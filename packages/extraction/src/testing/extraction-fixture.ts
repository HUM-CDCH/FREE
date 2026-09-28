/** One disposable PostgreSQL/DBOS fixture per test process. Owns seeded resources,
 * scripted kei, workflow settlement and cleanup; cluster suites own their assertions. */
import type { Database } from 'db'
import { validateDisposableTestDatabaseTarget } from 'db/database-url'
import { strToU8, zipSync } from 'fflate'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ExtractionExecution, TerminalExtraction } from '../dependencies.js'
import { ExtractionError } from '../errors.js'
import { keiExpArtifact, keiExpEvidence } from '../kei-exp-fixture.js'
import {
  keiExtractWorkflowId, type KeiExtractInput, type KeiFailureCode, type KeiHandoff, type KeiPoll, type KeiSubmission,
} from '../kei-handoff.js'
import { createExtractionModule } from '../module.js'
import type {
  BatchExtractionSnapshot, ExtractionAttemptSnapshot, ExtractionModule, RunSingleInput,
} from '../types.js'
import { dbosSteps } from '../workflow-steps.js'
import type { ExtractionWorkflowPorts } from '../workflows.js'

type StoredPackage = {
  artifactReference: string
  artifactSha256: string
}
export type SeededDocument = {
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  /** The kei run the revision was made from (`preprocessId` `kei-exp:<run>:g1`). */
  runId: string
  packageBytes: Uint8Array
  storedPackage: StoredPackage
  filename: string
}
type SeededProject = {
  researcherAccountId: string
  projectContextId: string
  extractionSchemaId: string
  schemaRevisionId: string
  documents: SeededDocument[]
}

const configuredDatabaseUrl =
  process.env.EXTRACTION_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const disposableDatabaseUrl = configuredDatabaseUrl
  ? validateDisposableTestDatabaseTarget(configuredDatabaseUrl).toString()
  : null

export const fixture = disposableDatabaseUrl ? await setup(disposableDatabaseUrl) : null

async function setup(disposableDatabaseUrl: string) {
  process.env.DATABASE_URL = disposableDatabaseUrl

  const [
    { db, pool, stableJson, stableUuid },
    { createCanonicalPackageStore },
    { createResearcherProjectStore },
    { createResearcherExtractionPersistence },
    { createExtractionStore, settleExtraction },
    { launchDbosTestApp },
    { spawnKeiStandIn },
  ] =
    await Promise.all([
      import('db'),
      import('../../../db/src/artifact-store.js'),
      import('../../../db/src/project-store.js'),
      import('../postgres-persistence.js'),
      import('../postgres-workflow-store.js'),
      import('./dbos-test-app.js'),
      import('./kei-stand-in-client.js'),
    ])

  const ARTICLE_SCHEMA = {
    recordDescription: 'One product record.',
    schemaNodes: [
      { id: 'title-node', name: 'title', type: 'string' },
      {
        id: 'filename-node',
        name: 'filename',
        type: 'string',
        valueSource: 'source-filename',
      },
    ],
  } as const
  type KeiDecision =
    | { artifact: unknown }
    | { failure: { code: KeiFailureCode; reason: string; retryable: boolean } }
  type KeiResponder = (request: KeiExtractInput, extractionId: string) => KeiDecision | Promise<KeiDecision>

  const projects = new Set<string>()
  const accounts = new Set<string>()

  const sha256 = (value: Uint8Array) =>
    createHash('sha256').update(value).digest('hex')

  /** The artifact the scripted kei publishes unless a test answers otherwise: one grounded record, as kei-exp dumps it. */
  function deterministicArtifact(request: KeiExtractInput) {
    const { schema, options } = request.request
    const strategy = options.strategy === 'catalog' ? 'catalog' : 'article'
    const nodes = (schema as { schemaNodes?: Array<{ name: string }> }).schemaNodes ?? []
    return keiExpArtifact({
      run_id: request.run_id, generation: request.generation, strategy, model: 'deterministic',
      schema: schema as { recordDescription: string; schemaNodes: unknown[] },
      // As kei dumps the options it ran under: the run's model choice, null when it chose no role.
      options: { strategy, model: 'deterministic', models: (options.models as Record<string, string> | undefined) ?? null },
      started: new Date().toISOString(), seconds: 0.001,
      complete: true,
      records: [{ title: 'Alpha', ...(nodes.some((node) => node.name === 'filename') ? { filename: 'article.pdf' } : {}) }],
      evidence: [keiExpEvidence({ bbox_pt: [10, 10, 100, 30], linked_by: 'model' })],
    })
  }

  /**
   * kei at its contract, in memory: each submission is answered by `respond` (or held until `release`), its child is
   * polled like kei's workflow row, and the published artifact is served by `readArtifact`. Most tests use it; the
   * `through kei's contract` group talks to a spawned stand-in instead.
   */
  function scriptedKei() {
    const submissions: KeiSubmission[] = []
    const cancels: string[] = []
    const children = new Map<string, { state: KeiPoll }>()
    const artifacts = new Map<string, Uint8Array>()
    const held = new Map<string, (decision: KeiDecision | null) => void>()
    const scripted = {
      respond: ((request) => ({ artifact: deterministicArtifact(request) })) as KeiResponder,
      holding: false,
      submissions,
      cancels,
      children,
      /** The Extraction IDs whose kei decision is held. */
      held: () => [...held.keys()],
      /** Answers a held extraction with `respond`, or with `decision`. */
      release(extractionId: string, decision?: KeiDecision) {
        const answer = held.get(extractionId)
        if (!answer) throw new Error(`kei holds no decision for ${extractionId}.`)
        held.delete(extractionId)
        answer(decision ?? null)
      },
      releaseAll() {
        for (const extractionId of [...held.keys()]) scripted.release(extractionId)
      },
      /** Answers every held decision and restores the default script. */
      reset() {
        scripted.holding = false
        scripted.respond = (request) => ({ artifact: deterministicArtifact(request) })
        scripted.releaseAll()
      },
      /** Forgets a finished test's work. */
      forget() {
        submissions.length = 0
        cancels.length = 0
        children.clear()
        artifacts.clear()
      },
      handoff: {
        async submit(submission) {
          // Reusing a child's ID returns the existing workflow (M0 #1).
          if (children.has(submission.workflowId)) return
          submissions.push(submission)
          const child: { state: KeiPoll } = { state: { state: 'live' } }
          children.set(submission.workflowId, child)
          const extractionId = submission.workflowId.slice(keiExtractWorkflowId('').length)
          const request = submission.request as KeiExtractInput
          const decided = scripted.holding
            ? new Promise<KeiDecision | null>((resolve) => held.set(extractionId, resolve))
            : Promise.resolve(null)
          void decided
            .then(async (decision) => decision ?? scripted.respond(request, extractionId))
            .then((decision) => {
              if (child.state.state !== 'live') return // cancelled meanwhile
              if ('failure' in decision) {
                child.state = { state: 'SUCCESS', output: { ok: false, ...decision.failure } }
                return
              }
              const bytes = new TextEncoder().encode(JSON.stringify(decision.artifact))
              artifacts.set(`${request.run_id}/${extractionId}`, bytes)
              const artifact = decision.artifact as { generation: string; model: string; models: Record<string, string> }
              child.state = {
                state: 'SUCCESS',
                output: {
                  ok: true, run_id: request.run_id, extraction_id: extractionId, generation: artifact.generation,
                  artifact_sha256: sha256(bytes), model: artifact.model, models: artifact.models,
                },
              }
            })
        },
        async poll(workflowId, signal) {
          const deadline = Date.now() + 2_000
          for (;;) {
            signal?.throwIfAborted()
            const child = children.get(workflowId)
            if (!child) return { state: 'missing' }
            if (child.state.state !== 'live') return child.state
            if (Date.now() >= deadline) return { state: 'live' }
            await delay(20, undefined, { signal })
          }
        },
        async cancel(workflowId) {
          cancels.push(workflowId)
          const child = children.get(workflowId)
          if (child?.state.state === 'live') child.state = { state: 'CANCELLED', deadlinePassed: false }
        },
        async requestDeleteRuns() {
          assert.fail('An Extraction never asks kei to delete runs.')
        },
      } satisfies KeiHandoff,
      async readArtifact(runId: string, extractionId: string) {
        const bytes = artifacts.get(`${runId}/${extractionId}`)
        if (!bytes) throw new ExtractionError('extraction_failed', 'kei-exp has no published artifact for this Extraction.')
        return bytes
      },
    }
    return scripted
  }

  const packageRoot = await mkdtemp(join(tmpdir(), 'free-extraction-contract-'))
  const packages = createCanonicalPackageStore(packageRoot)
  const kei = scriptedKei()
  const scriptedPorts: ExtractionWorkflowPorts = {
    steps: dbosSteps,
    store: createExtractionStore({ database: db as Database, packages }),
    kei: kei.handoff,
    readArtifact: (runId, extractionId) => kei.readArtifact(runId, extractionId),
  }
  const ports = { current: scriptedPorts }
  const app = await launchDbosTestApp({ databaseUrl: disposableDatabaseUrl, ports: () => ports.current })
  /** Every ExtractionExecution.cancel call, by Extraction ID. */
  const executionCancels: string[] = []
  const execution: ExtractionExecution = {
    ...app.execution,
    async cancel(extractionId) {
      executionCancels.push(extractionId)
      await app.execution.cancel(extractionId)
    },
  }

  function canonicalPackage(filename: string): Uint8Array {
    const pdf = strToU8(`%PDF-1.7\n${filename}`)
    const markdown = strToU8('# Product A\nAlpha\n# Product B\nBeta\n')
    const contentSha256 = sha256(pdf)
    const preprocessId = `fixture-${sha256(strToU8(filename)).slice(0, 16)}`
    const bbox = { x0: 10, y0: 10, x1: 100, y1: 30 }
    const alphaStart = new TextDecoder().decode(markdown).indexOf('Alpha')
    const betaStart = new TextDecoder().decode(markdown).indexOf('Beta')
    const document = strToU8(
      JSON.stringify({
        schema_version: 'parsed_document.v2',
        document: {
          document_id: randomUUID(),
          content_sha256: contentSha256,
          source: {
            kind: 'upload',
            original_filename: filename,
            media_type: 'application/pdf',
            byte_size: pdf.byteLength,
          },
          created_at: '2026-08-20T00:00:00.000Z',
          page_count: 1,
          language_hints: ['en'],
          is_encrypted: false,
          input_profile: {
            file_kind: 'pdf',
            detected_mime: 'application/pdf',
            pdf_version: '1.7',
            has_text_layer: true,
            has_images: false,
          },
        },
        preprocessing: {
          preprocess_id: preprocessId,
          profile: 'test',
          service_version: '1',
          started_at: null,
          finished_at: null,
          status: 'completed',
          warnings: [],
        },
        page_count: 1,
        page_mapping_verified: true,
        artifacts: {
          source_ref: 'source.pdf',
          parsed_json_ref: 'parsed_document.json',
          markdown_ref: 'artifacts/document.llm.md',
        },
        parser_runs: [
          {
            parser: 'test',
            version: '1',
            status: 'success',
            warnings: [],
            error: null,
          },
        ],
        arbitration: { primary_document_parser: 'test' },
        diagnostics: [],
        content_stream: [
          {
            block_id: 'heading-a',
            kind: 'heading',
            text: 'Product A',
            level: 1,
            page_number: 1,
            parser: 'test',
            bbox: null,
            markdown_span: null,
          },
          {
            block_id: 'alpha',
            kind: 'paragraph',
            text: 'Alpha',
            page_number: 1,
            parser: 'test',
            bbox,
            markdown_span: { start: alphaStart, end: alphaStart + 5 },
          },
          {
            block_id: 'heading-b',
            kind: 'heading',
            text: 'Product B',
            level: 1,
            page_number: 1,
            parser: 'test',
            bbox: null,
            markdown_span: null,
          },
          {
            block_id: 'beta',
            kind: 'paragraph',
            text: 'Beta',
            page_number: 1,
            parser: 'test',
            bbox,
            markdown_span: { start: betaStart, end: betaStart + 4 },
          },
        ],
        pages: [
          {
            page_number: 1,
            width_pt: 612,
            height_pt: 792,
            rotation: 0,
            ordered_content: ['heading-a', 'alpha', 'heading-b', 'beta'],
            unplaced_content: [],
            markdown_span: { start: 0, end: markdown.byteLength },
          },
        ],
        tables: [],
        evidence_index: {
          anchors: [
            {
              kind: 'text',
              anchor_id: 'a_p1_s0',
              content_sha256: contentSha256,
              preprocess_id: preprocessId,
              block_id: 'alpha',
              markdown_span: { start: alphaStart, end: alphaStart + 5 },
              producer_observations: [
                {
                  occurrence_id: 'occurrence-alpha',
                  page_number: 1,
                  producer_ref: null,
                  bbox,
                },
              ],
            },
            {
              kind: 'text',
              anchor_id: 'a_p1_s1',
              content_sha256: contentSha256,
              preprocess_id: preprocessId,
              block_id: 'beta',
              markdown_span: { start: betaStart, end: betaStart + 4 },
              producer_observations: [
                {
                  occurrence_id: 'occurrence-beta',
                  page_number: 1,
                  producer_ref: null,
                  bbox,
                },
              ],
            },
          ],
        },
      }),
    )
    const entries = [
      ['source.pdf', pdf, 'application/pdf'],
      ['parsed_document.json', document, 'application/json'],
      [
        'artifacts/document.llm.md',
        markdown,
        'text/markdown; charset=utf-8',
      ],
    ] as const
    const manifest = strToU8(
      JSON.stringify({
        package_version: 'canonical-ingestion-package.v1',
        parsed_document_schema_version: 'parsed_document.v2',
        source_sha256: contentSha256,
        preprocess_id: preprocessId,
        entries: entries.map(([path, bytes, mediaType]) => ({
          path,
          media_type: mediaType,
          size: bytes.byteLength,
          sha256: sha256(bytes),
        })),
      }),
    )
    return zipSync(
      Object.fromEntries([
        ['manifest.json', manifest],
        ...entries.map(([path, bytes]) => [path, bytes]),
      ]),
      { level: 0 },
    )
  }


  async function seedProject(
    schemaTree: unknown = ARTICLE_SCHEMA,
    filenames: readonly string[] = ['article.pdf'],
    ownerId?: string,
  ): Promise<SeededProject> {
    const researcherAccountId = ownerId ?? randomUUID()
    if (!accounts.has(researcherAccountId)) {
      await db.orm.public.ResearcherAccount.create({
        id: researcherAccountId,
        tenantId: '91000000-0000-4000-8000-000000000001',
        objectId: researcherAccountId,
        displayName: `Extraction test ${researcherAccountId.slice(0, 8)}`,
      })
      accounts.add(researcherAccountId)
    }
    const projectContextId = randomUUID()
    projects.add(projectContextId)
    await db.orm.public.ProjectContext.create({
      id: projectContextId,
      name: `Extraction test ${projectContextId}`,
      researcherAccountId,
    })
    const extractionSchemaId = randomUUID()
    await db.orm.public.ExtractionSchema.create({
      id: extractionSchemaId,
      projectContextId,
      name: 'Fixture schema',
    })
    const schemaRevisionId = randomUUID()
    await db.orm.public.SchemaRevision.create({
      id: schemaRevisionId,
      extractionSchemaId,
      revisionNumber: 1,
      origin: 'SUGGESTION',
      schemaTree,
    })
    const documents: SeededDocument[] = []
    for (const filename of filenames) {
      const packageBytes = canonicalPackage(filename)
      const storedPackage = await packages.save(packageBytes)
      const sourceDocumentId = randomUUID()
      await db.orm.public.SourceDocument.create({
        id: sourceDocumentId,
        projectContextId,
        contentSha256: sha256(strToU8(filename)),
        mediaType: 'application/pdf',
        originalName: filename,
      })
      const sourceRepresentationRevisionId = randomUUID()
      const runId = `run-${randomUUID()}`
      await db.orm.public.SourceRepresentationRevision.create({
        id: sourceRepresentationRevisionId,
        sourceDocumentId,
        revisionNumber: 1,
        artifactReference: storedPackage.artifactReference,
        artifactSha256: storedPackage.artifactSha256,
        contractVersion: 'parsed_document.v2',
        preprocessId: `kei-exp:${runId}:g1`,
        parserName: 'test',
        parserVersion: '1',
      })
      documents.push({
        sourceDocumentId,
        sourceRepresentationRevisionId,
        runId,
        packageBytes,
        storedPackage,
        filename,
      })
    }
    return {
      researcherAccountId,
      projectContextId,
      extractionSchemaId,
      schemaRevisionId,
      documents,
    }
  }

  async function addRepresentation(document: SeededDocument, filename: string) {
    const packageBytes = canonicalPackage(filename)
    const storedPackage = await packages.save(packageBytes)
    const sourceRepresentationRevisionId = randomUUID()
    await db.orm.public.SourceRepresentationRevision.create({
      id: sourceRepresentationRevisionId,
      sourceDocumentId: document.sourceDocumentId,
      revisionNumber: 2,
      artifactReference: storedPackage.artifactReference,
      artifactSha256: storedPackage.artifactSha256,
      contractVersion: 'parsed_document.v2',
      preprocessId: `kei-exp:run-${randomUUID()}:g2`,
      parserName: 'test',
      parserVersion: '1',
    })
    return sourceRepresentationRevisionId
  }

  /** A revision 2 a concurrent reprocess publishes, as the SQL and parameters of one statement. */
  const raceRevision = (sourceDocumentId: string, id: string = randomUUID()): [string, unknown[]] => [
    `INSERT INTO "sourceRepresentationRevision"
       (id, "sourceDocumentId", "revisionNumber", "artifactReference", "artifactSha256",
        "contractVersion", "preprocessId", "parserName", "parserVersion")
     VALUES ($1, $2, 2, $3, $3, 'parsed_document.v2', $4, 'test', '1')`,
    [id, sourceDocumentId, 'c'.repeat(64), `kei-exp:race-${randomUUID()}:g2`],
  ]

  /** The researcher's ExtractionModule: admission and reads through this process's DBOS. */
  function scheduler(researcherAccountId: string): ExtractionModule {
    return createExtractionModule(
      createResearcherExtractionPersistence(researcherAccountId, execution, { database: db as Database, packages }),
    )
  }

  function isTerminal(attempt: ExtractionAttemptSnapshot | null) {
    return attempt?.executionStatus === 'COMPLETED' || attempt?.executionStatus === 'FAILED'
  }

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await read()
      if (done(value)) return value
      if (Date.now() >= deadline) throw new Error(`Timed out waiting until ${what}.`)
      await delay(25)
    }
  }

  async function waitForAttempt(
    module: ExtractionModule,
    extractionId: string,
    predicate: (attempt: ExtractionAttemptSnapshot | null) => boolean = isTerminal,
  ): Promise<ExtractionAttemptSnapshot> {
    return (await eventually(() => module.readExtractionAttempt(extractionId), predicate, `Extraction ${extractionId} settles`))!
  }

  /** A module whose runSingle waits until its runExtraction workflow has settled the Extraction. */
  function createRuntime(researcherAccountId: string) {
    const scheduled = scheduler(researcherAccountId)
    const module: ExtractionModule = {
      ...scheduled,
      async runSingle(input) {
        const admitted = await scheduled.runSingle(input)
        if (isTerminal(admitted.extraction)) return admitted
        return {
          disposition: admitted.disposition,
          extraction: await waitForAttempt(scheduled, input.extractionId),
        }
      },
    }
    return { module, scheduled }
  }

  const freshInput = (
    project: SeededProject,
    extractionId: string = randomUUID(),
  ): RunSingleInput => ({
    kind: 'fresh' as const,
    extractionId,
    sourceRepresentationRevisionId:
      project.documents[0]!.sourceRepresentationRevisionId,
    schemaRevisionId: project.schemaRevisionId,
    strategy: 'ARTICLE' as const,
  })

  function rejectsWithCode(code: string) {
    return (error: unknown) => {
      assert.equal(
        typeof error === 'object' && error !== null && 'code' in error
          ? error.code
          : null,
        code,
      )
      return true
    }
  }

  async function waitForBatch(
    module: ExtractionModule,
    projectContextId: string,
    batchExtractionId: string,
    predicate: (batch: BatchExtractionSnapshot) => boolean,
  ) {
    return eventually(
      () => module.readBatch({ projectContextId, batchExtractionId }),
      predicate,
      `Batch Extraction ${batchExtractionId} matches`,
    )
  }

  async function studioWorkflow(extractionId: string) {
    const [workflow] = await app.admission.listWorkflows({
      workflowIDs: [`extract:${extractionId}`], loadInput: false, loadOutput: false,
    })
    return workflow
  }

  /** Waits until kei holds the Extraction's child: its Studio workflow is running and polling. */
  const heldByKei = (extractionId: string) =>
    eventually(async () => kei.held(), (held) => held.includes(extractionId), `kei holds ${extractionId}`)

  async function extractionRow(extractionId: string) {
    return db.orm.public.Extraction.select(
      'id', 'outcome', 'failure', 'catalogRecipe', 'requestedModels', 'resultPayload', 'batchExtractionId',
    ).first({ id: extractionId })
  }

  /** A published result for `settle`, standing in for the one runExtraction would write. */
  function succeeded(extractionId: string, project: SeededProject): TerminalExtraction {
    const document = project.documents[0]!
    return {
      extractionId, sourceDocumentId: document.sourceDocumentId,
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
      strategy: 'ARTICLE', outcome: 'SUCCEEDED', complete: true,
      modelAttribution: { provider: 'kei-exp', modelId: 'deterministic' },
      diagnostics: {
        phase: 'persisting', durationMs: 1, modelCalls: 1, finishReason: null, inputTokens: null, outputTokens: null,
        ungroundedPaths: [], groundingIssues: [], groundingBatches: [], unverifiedFields: [], catalog: null,
      },
      failure: null, result: { records: [{ title: 'Alpha' }] }, evidence: [], reviewable: true, batchExtractionId: null,
    }
  }

  async function cleanup() {
    kei.reset()
    ports.current = scriptedPorts
    // Let every workflow of the test settle before its rows go.
    await eventually(
      () => app.admission.listWorkflows({ status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadInput: false, loadOutput: false }),
      (live) => live.length === 0,
      'the test\'s workflows finish',
    ).catch(async () => {
      for (const workflow of await app.admission.listWorkflows({ status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadInput: false, loadOutput: false }))
        await app.admission.cancelWorkflow(workflow.workflowID)
    })
    kei.forget()
    executionCancels.length = 0
    for (const projectContextId of projects)
      await db.orm.public.ProjectContext.where({ id: projectContextId }).delete()
    projects.clear()
    for (const researcherAccountId of accounts)
      await db.orm.public.ResearcherAccount.where({
        id: researcherAccountId,
      }).delete()
    accounts.clear()
  }

  after(async () => {
    await cleanup()
    try {
      await app.close()
    } finally {
      await db.close()
      await pool.end()
      await rm(packageRoot, { recursive: true, force: true })
    }
  })

  return {
    sha256, ARTICLE_SCHEMA, db, stableJson,
    stableUuid, createResearcherProjectStore, createResearcherExtractionPersistence, createExtractionStore, settleExtraction,
    packages, kei, scriptedPorts, ports, app,
    execution, executionCancels, deterministicArtifact, seedProject, addRepresentation,
    raceRevision, scheduler, eventually, waitForAttempt, createRuntime,
    freshInput, rejectsWithCode, waitForBatch, studioWorkflow, heldByKei,
    extractionRow, succeeded, cleanup, disposableDatabaseUrl, spawnKeiStandIn,
  }
}
