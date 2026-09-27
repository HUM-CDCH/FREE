import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { after, describe, it, test } from 'node:test'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import { strToU8, zipSync } from 'fflate'
import pg from 'pg'
import type { CanonicalPackageStore, Database } from 'db'
import { validateDisposableTestDatabaseTarget } from 'db/database-url'
import { withBlockedUpdates, withHeldSourceDocumentLock } from 'db/postgres-test-helpers'
import type { ExtractionExecution, TerminalExtraction } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { createKeiExpClient } from './kei-exp.js'
import { keiExpArtifact, keiExpEvidence, keiExpGroundedArtifact } from './kei-exp-fixture.js'
import {
  createKeiHandoff, KEI_APPLICATION, keiExtractWorkflowId,
  type KeiExtractInput, type KeiFailureCode, type KeiHandoff, type KeiPoll, type KeiSubmission,
} from './kei-handoff.js'
import { createExtractionModule } from './module.js'
import type { BatchExtractionSnapshot, ExtractionAttemptSnapshot, ExtractionModule, RunSingleInput } from './types.js'
import { dbosSteps } from './workflow-steps.js'
import { RUN_EXTRACTION, type ExtractionWorkflowPorts } from './workflows.js'

const configuredDatabaseUrl =
  process.env.EXTRACTION_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const disposableDatabaseUrl = configuredDatabaseUrl
  ? validateDisposableTestDatabaseTarget(configuredDatabaseUrl).toString()
  : null

if (!disposableDatabaseUrl) {
  test(
    'ExtractionModule PostgreSQL contracts',
    {
      skip: 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database',
    },
    () => {},
  )
} else {
  process.env.DATABASE_URL = disposableDatabaseUrl

  const [
    { db, pool, stableJson, stableUuid },
    { createCanonicalPackageStore },
    { createResearcherProjectStore },
    { createExtractionStore, createResearcherExtractionPersistence, settleExtraction },
    { launchDbosTestApp },
    { spawnKeiStandIn },
  ] =
    await Promise.all([
      import('db'),
      import('../../db/src/artifact-store.js'),
      import('../../db/src/project-store.js'),
      import('./postgres-persistence.js'),
      import('./testing/dbos-test-app.js'),
      import('./testing/kei-stand-in-client.js'),
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
  type StoredPackage = {
    artifactReference: string
    artifactSha256: string
  }
  type SeededDocument = {
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
  type KeiDecision =
    | { artifact: unknown }
    | { failure: { code: KeiFailureCode; reason: string; retryable: boolean } }
  type KeiResponder = (request: KeiExtractInput, extractionId: string) => KeiDecision | Promise<KeiDecision>

  const projects = new Set<string>()
  const accounts = new Set<string>()
  let packageRoot = ''
  let packages: CanonicalPackageStore

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

  packageRoot = await mkdtemp(join(tmpdir(), 'free-extraction-contract-'))
  packages = createCanonicalPackageStore(packageRoot)
  const kei = scriptedKei()
  const scriptedPorts: ExtractionWorkflowPorts = {
    steps: dbosSteps,
    store: createExtractionStore({ database: db as Database, packages }),
    kei: kei.handoff,
    readArtifact: (runId, extractionId) => kei.readArtifact(runId, extractionId),
  }
  let ports = scriptedPorts
  const app = await launchDbosTestApp({ databaseUrl: disposableDatabaseUrl, ports: () => ports })
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
        return { disposition: admitted.disposition, extraction: await waitForAttempt(scheduled, input.extractionId) }
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
    ports = scriptedPorts
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

  describe('ExtractionModule on disposable PostgreSQL', () => {
    it('admits an Extraction row and its runExtraction workflow in one transaction', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const models = { fields: 'nuextract' }
      const input = {
        ...freshInput(project), strategy: 'CATALOG' as const, catalogRecipe: 'numbered-catalogue-de@1', models,
      }
      const admitted = await module.runSingle(input)
      assert.equal(admitted.disposition, 'created')
      // The workflow was enqueued in the transaction that committed the row.
      assert.equal(admitted.extraction.executionStatus, 'QUEUED')
      const row = await extractionRow(input.extractionId)
      assert.equal(row?.outcome, null)
      assert.equal(row?.catalogRecipe, 'numbered-catalogue-de@1')
      assert.deepEqual(row?.requestedModels, models)
      const document = project.documents[0]!
      const [workflow] = await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`], loadInput: true })
      assert.equal(workflow?.workflowName, RUN_EXTRACTION)
      assert.equal(workflow?.queueName, 'studio')
      assert.equal(workflow?.authenticatedUser, project.researcherAccountId)
      assert.deepEqual(workflow?.input, [input.extractionId])
      assert.deepEqual(workflow?.attributes, {
        projectContextId: project.projectContextId,
        sourceDocumentId: document.sourceDocumentId,
        sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
        extractionSchemaId: project.extractionSchemaId,
        keiRunId: document.runId,
      })
      await heldByKei(input.extractionId)
    })

    it('a failure after the enqueue rolls back both the row and the workflow', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const failing: ExtractionExecution = {
        ...execution,
        async enqueue(client, workflow, input) {
          await execution.enqueue(client, workflow, input)
          throw new Error('the request failed after its enqueue')
        },
      }
      const module = createExtractionModule(
        createResearcherExtractionPersistence(project.researcherAccountId, failing, { database: db as Database, packages }),
      )
      const input = freshInput(project)
      await assert.rejects(module.runSingle(input), /after its enqueue/)
      assert.equal(await extractionRow(input.extractionId), null)
      assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
    })

    it('scopes run, read, review, and cancellation to one researcher', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const foreign = await seedProject()
      const contested = createRuntime(project.researcherAccountId)
      const contestedInput = freshInput(project)
      const accepted = contested.module.runSingle(contestedInput)
      await assert.rejects(
        scheduler(foreign.researcherAccountId).runSingle({
          ...freshInput(foreign),
          extractionId: contestedInput.extractionId,
        }),
        rejectsWithCode('not_found'),
      )
      await accepted
      assert.equal(kei.submissions.length, 1)
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)

      const created = await module.runSingle(input)
      assert.equal(created.disposition, 'created')
      assert.equal(created.extraction.outcome, 'SUCCEEDED')
      assert.equal(created.extraction.complete, true)
      assert.deepEqual(created.extraction.result, {
        records: [{ title: 'Alpha', filename: 'article.pdf' }],
      })
      assert.equal(kei.submissions.length, 2)

      const replayed = await module.runSingle(input)
      assert.equal(replayed.disposition, 'replayed')
      assert.equal(replayed.extraction.extractionId, input.extractionId)
      assert.equal(kei.submissions.length, 2)

      await assert.rejects(
        module.runSingle({
          ...freshInput(project),
          schemaRevisionId: foreign.schemaRevisionId,
        }),
        rejectsWithCode('not_found'),
      )
      await assert.rejects(
        module.runSingle(freshInput(foreign)),
        rejectsWithCode('not_found'),
      )
      assert.equal(kei.submissions.length, 2)

      const foreignModule = createRuntime(foreign.researcherAccountId).module
      const foreignExtraction = await foreignModule.runSingle(freshInput(foreign))
      const foreignExtractionId = foreignExtraction.extraction.extractionId
      await assert.rejects(
        module.runSingle({
          ...freshInput(project),
          extractionId: foreignExtractionId,
        }),
        rejectsWithCode('not_found'),
      )
      assert.equal(kei.submissions.length, 3)
      await assert.rejects(
        module.prepareReview(foreignExtractionId),
        rejectsWithCode('not_found'),
      )
      await assert.rejects(module.readReviewDraft(foreignExtractionId), rejectsWithCode('not_found'))
      await assert.rejects(module.saveReviewDraft(foreignExtractionId, { version: 0, decisions: [] }), rejectsWithCode('not_found'))
      await assert.rejects(module.resetReview(foreignExtractionId, 0), rejectsWithCode('not_found'))
      await assert.rejects(
        module.finalizeReview(foreignExtractionId, []),
        rejectsWithCode('not_found'),
      )
      assert.equal(await module.readExtractionAttempt(foreignExtractionId), null)
      assert.equal(
        await module.cancelSingle(foreignExtractionId),
        'not-found',
      )
      assert.equal(
        await module.readDocumentExtractions({
          sourceDocumentId: foreign.documents[0]!.sourceDocumentId,
          extractionId: foreignExtractionId,
        }),
        null,
      )
      const unchanged =
        await db.orm.public.Extraction.select('reviewedAt', 'outcome').first({
          id: foreignExtractionId,
        })
      assert.deepEqual(unchanged, { reviewedAt: null, outcome: 'SUCCEEDED' })
    })

    it('reprocessing advances the current source while historical extraction and review pins survive', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      const prepared = await module.prepareReview(completed.extraction.extractionId)
      await module.finalizeReview(completed.extraction.extractionId, prepared.reviewDecisions)
      const store = createResearcherProjectStore(project.researcherAccountId, db)
      const annotation = await db.orm.public.AnnotationSetRevision.create({
        sourceDocumentId: document.sourceDocumentId, sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
        revisionNumber: 1, snapshot: [{ text: 'original note' }],
      })
      const revised = await store.reprocessSourceDocument(project.projectContextId, document.sourceDocumentId, {
        requestKey: randomUUID(), expectedRepresentationId: document.sourceRepresentationRevisionId,
        requestFingerprint: 'f'.repeat(64), contentSha256: sha256(strToU8(document.filename)),
        mediaType: 'application/pdf', originalName: document.filename, ...document.storedPackage,
        contractVersion: 'parsed_document.v2', preprocessId: 'kei-exp:reprocessed:g2', parserName: 'test', parserVersion: '5',
        ensureRetained: async descriptor => { assert.ok(await packages.available(descriptor)) },
      })
      assert.equal(revised?.revisionNumber, 2)
      const current = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId })
      assert.equal(current?.sourceRepresentationRevisionId, revised?.sourceRepresentationId)
      assert.equal(current?.latestAttempt, null)
      assert.equal((await store.getDocumentReopenSnapshot(project.projectContextId, document.sourceDocumentId))?.annotationSet, null)
      const pinned = await store.getDocumentReopenSnapshot(project.projectContextId, document.sourceDocumentId, {
        sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
      })
      assert.equal(pinned?.annotationSet?.annotationSetId, annotation.id)
      const historical = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId, extractionId: completed.extraction.extractionId })
      assert.equal(historical?.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
      assert.equal(historical?.latestAttempt?.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
      const reviewed = await module.prepareReview(completed.extraction.extractionId)
      assert.ok(reviewed.extraction.reviewedAt)
      assert.deepEqual(reviewed.reviewDecisions, prepared.reviewDecisions)
      assert.deepEqual(reviewed.extraction.evidence, prepared.extraction.evidence)
    })

    it('refuses a new Extraction on a superseded Source Representation Revision and writes no row', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      await addRepresentation(document, 'article-v2.pdf')
      const module = scheduler(project.researcherAccountId)
      const input = freshInput(project)
      await assert.rejects(module.runSingle(input), rejectsWithCode('source_representation_superseded'))
      assert.equal(await extractionRow(input.extractionId), null)
      assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
      await assert.rejects(module.runSingle(freshInput(project)), rejectsWithCode('source_representation_superseded'))
    })

    it('admits a new Extraction on the current Source Representation Revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const revisionTwo = await addRepresentation(project.documents[0]!, 'article-v2.pdf')
      const { module } = createRuntime(project.researcherAccountId)
      const admitted = await module.runSingle({ ...freshInput(project), sourceRepresentationRevisionId: revisionTwo })
      assert.equal(admitted.disposition, 'created')
      assert.equal(admitted.extraction.sourceRepresentationRevisionId, revisionTwo)
    })

    it('replays an identical request after a reprocess instead of refusing it', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      const first = await module.runSingle(input)
      await addRepresentation(project.documents[0]!, 'article-v2.pdf')
      const again = await module.runSingle(input)
      assert.equal(again.disposition, 'replayed')
      assert.equal(again.extraction.extractionId, first.extraction.extractionId)
      await assert.rejects(module.runSingle({ ...input, strategy: 'CATALOG' }), rejectsWithCode('extraction_id_conflict'))
    })

    it('keeps a run admitted before a reprocess and executes it on its original revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const input = freshInput(project)
      const queued = await module.runSingle(input)
      assert.equal(queued.extraction.executionStatus, 'QUEUED')
      await heldByKei(input.extractionId)
      await addRepresentation(document, 'article-v2.pdf')
      kei.release(input.extractionId)
      const executed = await waitForAttempt(module, input.extractionId)
      assert.equal(executed.executionStatus, 'COMPLETED')
      assert.equal(executed.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
      const request = kei.submissions.at(-1)!.request as KeiExtractInput
      assert.equal(request.run_id, document.runId)
    })

    it('refuses a run that was admitted while a reprocess published a newer revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const module = scheduler(project.researcherAccountId)
      const input = freshInput(project)
      await assert.rejects(
        withHeldSourceDocumentLock(
          disposableDatabaseUrl,
          document.sourceDocumentId,
          () => module.runSingle(input),
          async (run) => { await run(...raceRevision(document.sourceDocumentId)) },
        ),
        rejectsWithCode('source_representation_superseded'),
      )
      assert.equal(await extractionRow(input.extractionId), null)
    })

    it('an identical request that waited behind a reprocess replays the Extraction admitted before it', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const module = scheduler(project.researcherAccountId)
      const input = freshInput(project)
      // Request B reads no Extraction under this ID, then waits on the document lock a reprocess holds. Meanwhile
      // request A's Extraction commits on revision 1 (it needs no lock of the reprocess's), and the reprocess publishes
      // revision 2. Once B holds the lock it reads the identity again and replays A instead of answering superseded.
      const replayed = await withHeldSourceDocumentLock(
        disposableDatabaseUrl,
        document.sourceDocumentId,
        () => module.runSingle(input),
        async (run) => {
          await db.orm.public.Extraction.create({
            id: input.extractionId,
            sourceDocumentId: document.sourceDocumentId,
            sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
            schemaRevisionId: project.schemaRevisionId,
            strategy: 'ARTICLE',
            catalogRecipe: null,
            requestedModels: null,
            batchExtractionId: null,
          })
          await run(...raceRevision(document.sourceDocumentId))
        },
      )
      assert.equal(replayed.disposition, 'replayed')
      assert.equal(replayed.extraction.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
      assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
    })

    it('a batch admitted behind a reprocess pins the newly published revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const module = scheduler(project.researcherAccountId)
      const revisionTwo = randomUUID()
      const scheduled = await withHeldSourceDocumentLock(
        disposableDatabaseUrl,
        document.sourceDocumentId,
        () => module.scheduleBatch({
          projectContextId: project.projectContextId,
          schemaRevisionId: project.schemaRevisionId,
          sourceDocumentIds: [document.sourceDocumentId],
          strategy: 'ARTICLE',
          repetition: 'create-new',
        }),
        async (run) => { await run(...raceRevision(document.sourceDocumentId, revisionTwo)) },
      )
      assert.ok(scheduled)
      assert.equal(scheduled.batch.members[0]?.sourceRepresentationRevisionId, revisionTwo)
    })

    it('a batch and a reprocess of one of its members both finish', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const [one, two] = project.documents as [SeededDocument, SeededDocument]
      const module = scheduler(project.researcherAccountId)
      const store = createResearcherProjectStore(project.researcherAccountId, db)
      const [scheduled, revised] = await Promise.all([
        module.scheduleBatch({
          projectContextId: project.projectContextId,
          schemaRevisionId: project.schemaRevisionId,
          sourceDocumentIds: [two.sourceDocumentId, one.sourceDocumentId],
          strategy: 'ARTICLE',
          repetition: 'create-new',
        }),
        store.reprocessSourceDocument(project.projectContextId, two.sourceDocumentId, {
          requestKey: randomUUID(), expectedRepresentationId: two.sourceRepresentationRevisionId,
          requestFingerprint: 'f'.repeat(64), contentSha256: sha256(strToU8(two.filename)),
          mediaType: 'application/pdf', originalName: two.filename, ...two.storedPackage,
          contractVersion: 'parsed_document.v2', preprocessId: 'kei-exp:reprocessed:g2', parserName: 'test', parserVersion: '5',
          ensureRetained: async () => {},
        }),
      ])
      assert.ok(scheduled)
      assert.ok(revised)
      // Either order is valid; the member pins whichever revision was current when it locked.
      const member = scheduled.batch.members.find(
        (candidate) => candidate.sourceDocumentId === two.sourceDocumentId,
      )
      assert.ok(
        member?.sourceRepresentationRevisionId === two.sourceRepresentationRevisionId ||
          member?.sourceRepresentationRevisionId === revised.sourceRepresentationId,
      )
    })

    it('conceals a foreign document behind the same missing answer', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const foreign = await seedProject()
      // Supersede the foreign revision: checking currency before ownership would answer superseded.
      await addRepresentation(foreign.documents[0]!, 'foreign-v2.pdf')
      const module = scheduler(project.researcherAccountId)
      await assert.rejects(
        module.runSingle({ ...freshInput(project), sourceRepresentationRevisionId: foreign.documents[0]!.sourceRepresentationRevisionId }),
        rejectsWithCode('not_found'),
      )
    })

    it('batch admission locks members in sorted order and creates one pending Extraction per member with a deterministic ID', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['b.pdf', 'a.pdf', 'c.pdf'])
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const sorted = project.documents.map((document) => document.sourceDocumentId).sort((left, right) => left.localeCompare(right))
      /** Holds one member's document row, admits a batch over the members in reverse order, and reports which other
       *  members the admission had locked when it blocked. */
      async function lockedWhileHolding(held: string) {
        const holder = new pg.Client({ connectionString: disposableDatabaseUrl! })
        const prober = new pg.Client({ connectionString: disposableDatabaseUrl! })
        await holder.connect()
        await prober.connect()
        try {
          await holder.query('BEGIN')
          await holder.query('SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE', [held])
          const scheduling = module.scheduleBatch({
            projectContextId: project.projectContextId,
            schemaRevisionId: project.schemaRevisionId,
            strategy: 'ARTICLE',
            sourceDocumentIds: [...sorted].reverse(),
            repetition: 'create-new',
            models: { fields: 'nuextract' },
          })
          void scheduling.catch(() => {})
          await eventually(async () => {
            await prober.query('SELECT pg_stat_clear_snapshot()')
            const { rows } = await prober.query<{ count: number }>(
              `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
                 AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%"sourceDocument"%'`)
            return rows[0]!.count
          }, (count) => count === 1, 'the batch admission waits on the held document')
          const locked: string[] = []
          for (const id of sorted.filter((candidate) => candidate !== held)) {
            await prober.query('BEGIN')
            try {
              await prober.query('SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE NOWAIT', [id])
            } catch (error) {
              if ((error as { code?: string }).code !== '55P03') throw error
              locked.push(id)
            } finally {
              await prober.query('ROLLBACK')
            }
          }
          await holder.query('COMMIT')
          return { locked, scheduled: await scheduling }
        } finally {
          await holder.query('ROLLBACK').catch(() => {})
          await holder.end()
          await prober.end()
        }
      }
      // Holding the smallest ID stops the admission before it locks anything else; holding the largest, after it
      // locked every other member.
      assert.deepEqual((await lockedWhileHolding(sorted[0]!)).locked, [])
      const { locked, scheduled } = await lockedWhileHolding(sorted[2]!)
      assert.deepEqual(locked, sorted.slice(0, 2))
      const batchExtractionId = scheduled.batch.batchExtractionId
      assert.equal(scheduled.disposition, 'created')
      assert.deepEqual(scheduled.batch.members.map((member) => member.sourceDocumentId), sorted)
      const rows = await db.orm.public.Extraction.where({ batchExtractionId })
        .select('id', 'sourceDocumentId', 'outcome', 'requestedModels', 'catalogRecipe').all()
      assert.equal(rows.length, 3)
      for (const row of rows) {
        assert.equal(row.id, stableUuid('batch-member-extraction', stableJson([batchExtractionId, row.sourceDocumentId])))
        assert.equal(row.outcome, null)
        assert.equal(row.catalogRecipe, null)
        assert.deepEqual(row.requestedModels, { fields: 'nuextract' })
      }
      const workflows = await app.admission.listWorkflows({ workflowIDs: rows.map((row) => `extract:${row.id}`) })
      assert.equal(workflows.length, 3)
      for (const workflow of workflows) {
        assert.equal(workflow.workflowName, RUN_EXTRACTION)
        assert.equal(workflow.queueName, 'studio')
        assert.equal(workflow.authenticatedUser, project.researcherAccountId)
        assert.equal(workflow.attributes?.batchExtractionId, batchExtractionId)
      }
      // Members reach kei at the batch priority.
      for (const row of rows) await heldByKei(row.id)
      const submitted = kei.submissions.filter((submission) => rows.some((row) => submission.workflowId === keiExtractWorkflowId(row.id)))
      assert.equal(submitted.length, 3)
      assert.ok(submitted.every((submission) => submission.priority === 10))
    })

    it('a committed batch answers with its admitted members even when DBOS cannot be read, and a retry adds no batch', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const outage = new Error('connect ECONNREFUSED: DBOS is unavailable')
      const unreadable: ExtractionExecution = { ...execution, statuses: async () => { throw outage } }
      const module = createExtractionModule(
        createResearcherExtractionPersistence(project.researcherAccountId, unreadable, { database: db as Database, packages }),
      )
      const batches = async () =>
        (await db.orm.public.BatchExtraction.where({ projectContextId: project.projectContextId }).select('id').all()).length
      const input = {
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE' as const,
        sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
      }
      for (const repetition of ['create-new', 'reuse-equal-selection'] as const) {
        const before = await batches()
        const created = await module.scheduleBatch({ ...input, repetition })
        assert.equal(created.disposition, 'created')
        assert.equal(created.batch.executionStatus, 'QUEUED')
        assert.deepEqual(created.batch.members.map((member) => member.executionStatus), ['QUEUED', 'QUEUED'])
        assert.equal(await batches(), before + 1)
      }
      // A replay reads its status like any read, so the outage still answers; it creates nothing.
      await assert.rejects(module.scheduleBatch({ ...input, repetition: 'reuse-equal-selection' }), (error: unknown) => error === outage)
      assert.equal(await batches(), 2)

      // A suggested batch's handoff answers the same way.
      const batchSchemaSuggestionId = randomUUID()
      await db.orm.public.BatchSchemaSuggestion.create({
        id: batchSchemaSuggestionId,
        projectContextId: project.projectContextId,
        selectionKey: sha256(strToU8(batchSchemaSuggestionId)),
      })
      for (const document of project.documents)
        await db.orm.public.BatchSchemaSuggestionSource.create({
          batchSchemaSuggestionId,
          sourceDocumentId: document.sourceDocumentId,
          sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
        })
      await db.orm.public.BatchSchemaSuggestion.where({ id: batchSchemaSuggestionId }).update({
        outcome: 'SUCCEEDED', phase: 'READY', draft: ARTICLE_SCHEMA, draftVersion: 1,
      })
      const handedOff = await module.scheduleSuggestedBatch({
        projectContextId: project.projectContextId, batchSchemaSuggestionId, strategy: 'ARTICLE',
      })
      assert.equal(handedOff.disposition, 'created')
      assert.deepEqual(handedOff.batch.members.map((member) => member.executionStatus), ['QUEUED', 'QUEUED'])
      assert.equal(await batches(), 3)
    })

    it('a batch rerun creates new Extraction identities', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const module = scheduler(project.researcherAccountId)
      const input = {
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE' as const,
        sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
        repetition: 'create-new' as const,
      }
      const first = await module.scheduleBatch(input)
      const second = await module.scheduleBatch(input)
      const ids = async (batchExtractionId: string) =>
        (await db.orm.public.Extraction.where({ batchExtractionId }).select('id').all()).map((row) => row.id)
      const firstIds = await ids(first.batch.batchExtractionId)
      const secondIds = await ids(second.batch.batchExtractionId)
      assert.equal(firstIds.length, 2)
      assert.equal(secondIds.length, 2)
      assert.ok(firstIds.every((id) => !secondIds.includes(id)))
    })

    it('pending Extractions count as batch members but do not displace the latest reviewed result on reopen', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const reviewed = await module.runSingle(freshInput(project))
      const prepared = await module.prepareReview(reviewed.extraction.extractionId)
      await module.finalizeReview(reviewed.extraction.extractionId, prepared.reviewDecisions)
      kei.holding = true
      const scheduled = await module.scheduleBatch({
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: [document.sourceDocumentId],
        repetition: 'create-new',
      })
      const member = stableUuid('batch-member-extraction', stableJson([scheduled.batch.batchExtractionId, document.sourceDocumentId]))
      await heldByKei(member)
      const batch = await module.readBatch({
        projectContextId: project.projectContextId, batchExtractionId: scheduled.batch.batchExtractionId,
      })
      assert.equal(batch.members.length, 1)
      assert.equal(batch.members[0]!.executionStatus, 'RUNNING')
      assert.equal(batch.members[0]!.latestExtraction, null)
      const reopened = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId })
      assert.equal(reopened?.latestReviewed?.extractionId, reviewed.extraction.extractionId)
      assert.equal(reopened?.latestAttempt?.extractionId, reviewed.extraction.extractionId)
      const results = await module.readBatchResults({
        projectContextId: project.projectContextId, batchExtractionId: scheduled.batch.batchExtractionId,
      })
      assert.deepEqual({ total: results.totalMembers, pending: results.pending, results: results.results.length },
        { total: 1, pending: 1, results: 0 })
      // The project list counts the pending member as batch progress, not as a published Extraction.
      const listed = await createResearcherProjectStore(project.researcherAccountId, db, { workflowStatuses: execution.statuses })
        .listProjectContexts(20)
      const summary = listed.find((item) => item.projectContextId === project.projectContextId)?.summary
      assert.equal(summary?.extractionCount, 1)
      assert.equal(summary?.reviewedSourceDocumentCount, 1)
      assert.deepEqual(summary?.runningBatch, { completedMemberCount: 0, memberCount: 1 })
      const activity = await createResearcherProjectStore(project.researcherAccountId, db).listRecentActivity(20)
      assert.equal(activity.filter((event) => event.kind === 'extraction_appended').length, 1)
    })

    it('derives QUEUED, RUNNING and interrupted from DBOS and never reports a settled row as running', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const module = scheduler(project.researcherAccountId)
      // A workflow DBOS holds back (DELAYED) reads as QUEUED.
      const delayed = randomUUID()
      await db.orm.public.Extraction.create({
        id: delayed, sourceDocumentId: document.sourceDocumentId,
        sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, batchExtractionId: null,
      })
      await app.admission.enqueue(
        { workflowName: RUN_EXTRACTION, workflowID: `extract:${delayed}`, queueName: 'studio', delaySeconds: 3_600 },
        delayed,
      )
      assert.equal((await module.readExtractionAttempt(delayed))?.executionStatus, 'QUEUED')
      // Its workflow cancelled without an outcome: interrupted.
      await DBOS.cancelWorkflow(`extract:${delayed}`)
      const interrupted = await module.readExtractionAttempt(delayed)
      assert.equal(interrupted?.executionStatus, 'FAILED')
      assert.equal(interrupted?.outcome, null)
      assert.deepEqual(interrupted?.failure, {
        code: 'interrupted', message: 'This work stopped before it finished. Start it again.', phase: 'extracting',
      })
      // A held kei keeps the workflow PENDING: RUNNING.
      kei.holding = true
      const input = freshInput(project)
      await module.runSingle(input)
      await heldByKei(input.extractionId)
      assert.equal((await studioWorkflow(input.extractionId))?.status, 'PENDING')
      const running = await module.readExtractionAttempt(input.extractionId)
      assert.equal(running?.executionStatus, 'RUNNING')
      assert.equal(running?.result, null)
      // An outcome on the row wins while its workflow is still PENDING.
      assert.equal(await settleExtraction(db.orm, input.extractionId, {
        outcome: 'FAILED', failure: { code: 'extraction_failed', message: 'Settled first.', phase: 'extracting' },
      }), 'settled')
      assert.equal((await studioWorkflow(input.extractionId))?.status, 'PENDING')
      const settled = await module.readExtractionAttempt(input.extractionId)
      assert.equal(settled?.executionStatus, 'FAILED')
      assert.equal(settled?.failure?.message, 'Settled first.')
      // The workflow finishes later and writes nothing over it.
      kei.release(input.extractionId)
      await eventually(() => studioWorkflow(input.extractionId), (workflow) => workflow?.status === 'SUCCESS', 'runExtraction ends')
      assert.equal((await extractionRow(input.extractionId))?.outcome, 'FAILED')
    })

    it('a SUCCESS workflow over a row without an outcome reads as interrupted after the re-read', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      const id = completed.extraction.extractionId
      assert.equal((await studioWorkflow(id))?.status, 'SUCCESS')
      // A workflow that returned SUCCESS without publishing (here: an outcome removed behind its back).
      await db.orm.public.Extraction.where({ id }).updateAll({ outcome: null })
      const read = await module.readExtractionAttempt(id)
      assert.equal(read?.executionStatus, 'FAILED')
      assert.equal(read?.failure?.code, 'interrupted')
    })

    it('cancel racing completion has one winner', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const module = scheduler(project.researcherAccountId)
      const store = createExtractionStore({ database: db as Database, packages })
      const probe = new pg.Client({ connectionString: disposableDatabaseUrl })
      await probe.connect()
      t.after(() => probe.end())
      /** Waits until `count` backends wait on the Extraction row lock with their conditional UPDATE. */
      const blockedWriters = (count: number) => eventually(async () => {
        await probe.query('SELECT pg_stat_clear_snapshot()')
        const { rows } = await probe.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database()
             AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%"extraction"%'`)
        return rows[0]!.count
      }, (blocked) => blocked >= count, `${count} blocked Extraction writes`)
      kei.holding = true
      const winners: string[] = []
      for (let iteration = 0; iteration < 20; iteration += 1) {
        const input = freshInput(project)
        await module.runSingle(input)
        await heldByKei(input.extractionId)
        const cancel = () => module.cancelSingle(input.extractionId)
        const complete = () =>
          store.settle(input.extractionId, { outcome: 'SUCCEEDED', extraction: succeeded(input.extractionId, project) })
        // A second connection holds the row, so both conditional UPDATEs queue on its lock and really collide; the
        // writer that queued first (alternating) takes the lock first, and the other re-checks `outcome IS NULL`.
        const collide = async (): Promise<[string, string]> => {
          if (iteration % 2 === 0) {
            const first = cancel()
            await blockedWriters(1)
            return Promise.all([first, complete()])
          }
          const first = complete()
          await blockedWriters(1)
          return Promise.all([cancel(), first])
        }
        const written: [string, string] =
          await withBlockedUpdates(disposableDatabaseUrl, 'Extraction', input.extractionId, 2, collide)
        const [cancelled, completed] = written
        const cancelWon: boolean = cancelled === 'cancellation-requested'
        assert.equal(cancelWon, completed === 'already-settled', `iteration ${iteration}: exactly one wrote`)
        assert.equal(completed === 'settled' || completed === 'already-settled', true)
        winners.push(cancelWon ? 'cancel' : 'completion')
        const row = await extractionRow(input.extractionId)
        assert.equal(row?.outcome, cancelWon ? 'CANCELLED' : 'SUCCEEDED')
        // No second write: a later attempt at either finds the outcome.
        assert.equal(await complete(), 'already-settled')
        assert.equal(await cancel(), 'not-found')
      }
      // Both branches ran: a cancel that won and a completion that won.
      assert.ok(winners.includes('cancel'), winners.join(','))
      assert.ok(winners.includes('completion'), winners.join(','))
    })

    it('a status read racing a cancel shows the cancellation, not an interruption', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const cancelling = scheduler(project.researcherAccountId)
      kei.holding = true
      const input = freshInput(project)
      await cancelling.runSingle(input)
      await heldByKei(input.extractionId)
      // The read loads the row (no outcome yet); the cancel commits and stops the workflow before the read asks DBOS.
      let raced = false
      const racing: ExtractionExecution = {
        ...execution,
        async statuses(workflowIds) {
          if (!raced) {
            raced = true
            assert.equal(await cancelling.cancelSingle(input.extractionId), 'cancellation-requested')
            assert.equal((await studioWorkflow(input.extractionId))?.status, 'CANCELLED')
          }
          return execution.statuses(workflowIds)
        },
      }
      const reader = createExtractionModule(
        createResearcherExtractionPersistence(project.researcherAccountId, racing, { database: db as Database, packages }),
      )
      const read = await reader.readExtractionAttempt(input.extractionId)
      assert.ok(raced)
      assert.equal(read?.executionStatus, 'FAILED')
      assert.deepEqual(read?.failure, { code: 'cancelled', message: 'Extraction cancelled.', phase: 'extracting' })
    })

    it('a replay of a failed Extraction returns its failure, even after its workflow history was deleted, and enqueues nothing', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      kei.respond = () => ({ failure: { code: 'extraction_failed', reason: 'the model server refused the request', retryable: false } })
      const input = freshInput(project)
      const failed = await module.runSingle(input)
      assert.equal(failed.extraction.executionStatus, 'FAILED')
      assert.equal((await extractionRow(input.extractionId))?.outcome, 'FAILED')
      await DBOS.deleteWorkflows([`extract:${input.extractionId}`])
      const submitted = kei.submissions.length
      const replayed = await module.runSingle(input)
      assert.equal(replayed.disposition, 'replayed')
      assert.equal(replayed.extraction.executionStatus, 'FAILED')
      assert.deepEqual(replayed.extraction.failure, failed.extraction.failure)
      assert.deepEqual(await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] }), [])
      assert.equal(kei.submissions.length, submitted)
    })

    it('cancel writes the cancelled outcome and stops the Studio workflow and its kei child', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const input = freshInput(project)
      await module.runSingle(input)
      await heldByKei(input.extractionId)
      assert.equal(await module.cancelSingle(input.extractionId), 'cancellation-requested')
      const row = await extractionRow(input.extractionId)
      assert.equal(row?.outcome, 'CANCELLED')
      assert.equal((row?.failure as { code?: string } | null)?.code, 'cancelled')
      assert.equal((await studioWorkflow(input.extractionId))?.status, 'CANCELLED')
      assert.deepEqual(executionCancels.filter((id) => id === input.extractionId), [input.extractionId])
      assert.ok(kei.cancels.includes(keiExtractWorkflowId(input.extractionId)))
      const read = await module.readExtractionAttempt(input.extractionId)
      assert.equal(read?.executionStatus, 'FAILED')
      assert.equal(read?.failure?.code, 'cancelled')
      assert.equal(await module.cancelSingle(input.extractionId), 'not-found')
      assert.equal(await module.cancelSingle(randomUUID()), 'not-found')
    })

    it('a batch member cannot be cancelled on its own, and its ID posted as an interactive Extraction answers extraction_id_conflict', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const scheduled = await module.scheduleBatch({
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: [document.sourceDocumentId],
        repetition: 'create-new',
      })
      const member = stableUuid('batch-member-extraction', stableJson([scheduled.batch.batchExtractionId, document.sourceDocumentId]))
      assert.equal(await module.cancelSingle(member), 'not-found')
      assert.equal((await extractionRow(member))?.outcome, null)
      await assert.rejects(module.runSingle(freshInput(project, member)), rejectsWithCode('extraction_id_conflict'))
    })

    it('an Extraction deleted while it runs publishes nothing and fails no surviving member', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['deleted.pdf', 'kept.pdf'])
      const [deleted, kept] = project.documents as [SeededDocument, SeededDocument]
      const module = scheduler(project.researcherAccountId)
      const store = createResearcherProjectStore(project.researcherAccountId, db)
      kei.holding = true
      const scheduled = await module.scheduleBatch({
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: [deleted.sourceDocumentId, kept.sourceDocumentId],
        repetition: 'create-new',
      })
      const batchExtractionId = scheduled.batch.batchExtractionId
      const memberOf = (document: SeededDocument) =>
        stableUuid('batch-member-extraction', stableJson([batchExtractionId, document.sourceDocumentId]))
      await heldByKei(memberOf(deleted))
      await heldByKei(memberOf(kept))
      assert.deepEqual(await store.deleteSourceDocument(project.projectContextId, deleted.sourceDocumentId), { interruptedAttempts: [] })
      assert.equal(await extractionRow(memberOf(deleted)), null)
      kei.releaseAll()
      await eventually(() => studioWorkflow(memberOf(deleted)), (workflow) => workflow?.status === 'SUCCESS',
        'the deleted member\'s workflow ends without an error')
      const batch = await waitForBatch(module, project.projectContextId, batchExtractionId,
        (candidate) => candidate.executionStatus === 'COMPLETED')
      assert.deepEqual(batch.members.map((member) => [member.sourceDocumentId, member.executionStatus]),
        [[kept.sourceDocumentId, 'COMPLETED']])
      assert.equal((await extractionRow(memberOf(kept)))?.outcome, 'SUCCEEDED')
      assert.equal(await createExtractionStore({ database: db as Database, packages }).settle(memberOf(deleted), {
        outcome: 'FAILED', failure: { code: 'extraction_failed', message: 'late', phase: 'extracting' },
      }), 'missing')
    })

    it('deleting one batch source preserves another member\'s result, revision pin and finalized review', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['deleted.pdf', 'kept.pdf'])
      const [deleted, kept] = project.documents as [SeededDocument, SeededDocument]
      const module = scheduler(project.researcherAccountId)
      const store = createResearcherProjectStore(project.researcherAccountId, db)
      const scheduled = await module.scheduleBatch({
        projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE', sourceDocumentIds: [deleted.sourceDocumentId, kept.sourceDocumentId], repetition: 'create-new',
      })
      const batchExtractionId = scheduled.batch.batchExtractionId
      await waitForBatch(module, project.projectContextId, batchExtractionId,
        (candidate) => candidate.executionStatus === 'COMPLETED')
      const keptId = stableUuid('batch-member-extraction', stableJson([batchExtractionId, kept.sourceDocumentId]))
      const prepared = await module.prepareReview(keptId)
      await module.finalizeReview(keptId, prepared.reviewDecisions)
      const keptBefore = await db.orm.public.Extraction.select('id', 'sourceRepresentationRevisionId', 'outcome', 'resultPayload').first({ id: keptId })
      const reviewsBefore = await db.orm.public.ExtractionReview.where({ extractionId: keptId })
        .select('id', 'decisionDigest').all()
      assert.ok(reviewsBefore.length > 0)

      assert.deepEqual(await store.deleteSourceDocument(project.projectContextId, deleted.sourceDocumentId), { interruptedAttempts: [] })
      assert.deepEqual(await db.orm.public.Extraction.select('id', 'sourceRepresentationRevisionId', 'outcome', 'resultPayload').first({ id: keptId }), keptBefore)
      assert.deepEqual(await db.orm.public.ExtractionReview.where({ extractionId: keptId })
        .select('id', 'decisionDigest').all(), reviewsBefore)
      const batch = await module.readBatch({ projectContextId: project.projectContextId, batchExtractionId })
      assert.deepEqual(batch.members.map((member) => member.sourceDocumentId), [kept.sourceDocumentId])
    })

    it('runExtraction records keiRunId from the pinned revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      await module.runSingle(input)
      const [workflow] = await app.admission.listWorkflows({ workflowIDs: [`extract:${input.extractionId}`] })
      assert.equal(workflow?.attributes?.keiRunId, document.runId)
      const submission = kei.submissions.find((candidate) => candidate.workflowId === keiExtractWorkflowId(input.extractionId))
      assert.equal(submission?.attributes.keiRunId, document.runId)
      assert.equal((submission?.request as KeiExtractInput).run_id, document.runId)
    })

    it('persists and reopens a partial remote Catalog result without local stage diagnostics', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      kei.respond = (request) => ({ artifact: { ...deterministicArtifact(request), complete: false } })
      const { module } = createRuntime(project.researcherAccountId)
      const input = { ...freshInput(project), strategy: 'CATALOG' as const }
      const created = await module.runSingle(input)
      assert.equal(created.extraction.complete, false)
      assert.equal(created.extraction.outcome, 'SUCCEEDED')
      assert.equal(created.extraction.diagnostics!.catalog, null)
      assert.equal((await module.runSingle(input)).disposition, 'replayed')
      assert.equal(kei.submissions.length, 1)
      const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
      assert.deepEqual(reopened?.latestAttempt?.result, created.extraction.result)
      const prepared = await module.prepareReview(input.extractionId)
      assert.equal((await module.finalizeReview(input.extractionId, prepared.reviewDecisions)).disposition, 'reviewed')
    })

    it('persists and reopens a version 2 recipe result with its span evidence and review material', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      kei.respond = (request) => ({
        artifact: keiExpGroundedArtifact({
          run_id: request.run_id, generation: request.generation, schema: request.request.schema as never, model: 'deterministic',
          records: [{ title: 'Alpha' }], record_blocks: [{ block: 'b1', entry_label: '1' }],
          evidence: [{ path: ['records', 0, 'title'], segment: 'p1_s0', page: 1, bbox_pt: [10, 10, 100, 30],
                       verbatim: true, hits: 1, linked_by: 'key', spans: [{ segment: 'p1_s0', start: 0, end: 5 }],
                       alternatives: [], provenance: 'token', key_spans: [], heading: null, precision: 'segment',
                       raw: 'Alpha', normalized: { value: 'Alphabet', rule: 'glossary',
                                                   key_span: { segment: 'p1_s0', start: 0, end: 5 },
                                                   expansion_span: { segment: 'p1_s0', start: 8, end: 16 } } }],
        }),
      })
      const { module } = createRuntime(project.researcherAccountId)
      const input = { ...freshInput(project), strategy: 'CATALOG' as const, catalogRecipe: 'numbered-catalogue-de@1' }
      const created = await module.runSingle(input)
      assert.deepEqual((kei.submissions[0]!.request as KeiExtractInput).request.options.catalog, { recipe: 'numbered-catalogue-de@1' })
      const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
      const attempt = reopened!.latestAttempt!
      assert.equal(attempt.extractionId, created.extraction.extractionId)
      assert.deepEqual(attempt.evidence![0]!.grounding, {
        linkedBy: 'key', provenance: 'token', textSpans: [{ segment: 'p1_s0', start: 0, end: 5 }], keySpans: [],
        alternatives: [], heading: null, precision: 'segment', raw: 'Alpha',
        normalized: { value: 'Alphabet', rule: 'glossary', keySpan: { segment: 'p1_s0', start: 0, end: 5 },
                      expansionSpan: { segment: 'p1_s0', start: 8, end: 16 } },
      })
      const grounded = attempt.diagnostics!.grounded!
      const fixture = keiExpGroundedArtifact()
      assert.equal(grounded.recipe, 'numbered-catalogue-de@1')
      assert.deepEqual(grounded.proposed, fixture.proposed)
      assert.deepEqual(grounded.rejected, fixture.rejected)
      assert.deepEqual(grounded.coverage, fixture.coverage)
      assert.deepEqual(grounded.completeness, fixture.completeness)
      const prepared = await module.prepareReview(input.extractionId)
      assert.equal(prepared.reviewDecisions.length, 1)
      assert.equal((await module.finalizeReview(input.extractionId, prepared.reviewDecisions)).disposition, 'reviewed')
    })

    it('a failed Extraction keeps its failure on its row and publishes no result', async (t) => {
      t.after(cleanup)
      const article = await seedProject()
      kei.respond = () => ({ failure: { code: 'extraction_failed', reason: 'controlled extraction failure', retryable: false } })
      const failed = await createRuntime(article.researcherAccountId).module.runSingle(freshInput(article))
      assert.equal(failed.extraction.executionStatus, 'FAILED')
      assert.equal(failed.extraction.outcome, null)
      assert.equal(failed.extraction.complete, null)
      assert.equal(failed.extraction.result, null)
      assert.deepEqual(failed.extraction.failure, {
        code: 'extraction_failed', message: 'kei-exp could not complete the Extraction: controlled extraction failure', phase: 'extracting',
      })
      const row = await extractionRow(failed.extraction.extractionId)
      assert.equal(row?.outcome, 'FAILED')
      assert.equal(row?.resultPayload, null)
    })

    it('persists drafts independently, rejects invalid and concurrent edits, and clears them atomically on finalization', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const { extraction } = await module.runSingle(freshInput(project))
      const id = extraction.extractionId
      const prepared = await module.prepareReview(id)
      const edited = [{ ...prepared.reviewDecisions[0]!, action: 'EDITED' as const, reviewedValue: 'Draft title' }]
      assert.deepEqual(await module.readReviewDraft(id), { version: 0, decisions: [] })
      for (const invalid of [
        [{ ...edited[0]!, evidenceAnchorId: 'foreign-anchor' }],
        [{ ...edited[0]!, reviewedOccurrenceIds: ['foreign-occurrence'] }],
        [{ ...edited[0]!, reviewedValue: 42 }],
        [edited[0]!, edited[0]!],
      ]) await assert.rejects(module.saveReviewDraft(id, { version: 0, decisions: invalid }), rejectsWithCode('invalid_review'))
      const saved = await module.saveReviewDraft(id, { version: 0, decisions: edited })
      assert.equal(saved.version, 1)
      assert.deepEqual(await createRuntime(project.researcherAccountId).module.readReviewDraft(id), saved)
      const unreviewed = await module.prepareReview(id)
      assert.equal(unreviewed.extraction.reviewedAt, null)
      assert.deepEqual(unreviewed.extraction.reviewDecisions, [])
      await assert.rejects(module.finalizeReview(id, edited, 0), rejectsWithCode('review_conflict'))
      const competing = await Promise.allSettled([
        module.saveReviewDraft(id, { version: 1, decisions: [] }),
        module.saveReviewDraft(id, { version: 1, decisions: prepared.reviewDecisions }),
      ])
      assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1)
      const latest = await module.readReviewDraft(id)
      assert.equal(latest.version, 2)
      const reverted = await module.saveReviewDraft(id, { version: 2, decisions: [] })
      assert.deepEqual(reverted.decisions, [])
      const complete = await module.saveReviewDraft(id, { version: 3, decisions: edited })
      const finalizations = await Promise.all([
        module.finalizeReview(id, edited, complete.version),
        module.finalizeReview(id, edited, complete.version),
      ])
      assert.deepEqual(finalizations.map((result) => result.disposition).sort(), ['replayed', 'reviewed'])
      const finalized = finalizations[0]!
      assert.ok(finalized.extraction.reviewedAt)
      assert.deepEqual((await module.readReviewDraft(id)).decisions, [])
      await assert.rejects(module.saveReviewDraft(id, { version: 4, decisions: [] }), rejectsWithCode('review_conflict'))
      for (const version of [-1, 1.5, Number.NaN])
        await assert.rejects(module.resetReview(id, version), rejectsWithCode('invalid_review'))
      await assert.rejects(module.resetReview(id, 4), rejectsWithCode('review_conflict'))
      const resets = await Promise.allSettled([module.resetReview(id, 5), module.resetReview(id, 5)])
      assert.equal(resets.filter((result) => result.status === 'fulfilled').length, 1)
      assert.deepEqual(await module.readReviewDraft(id), { version: 6, decisions: [] })
      const reopened = await module.prepareReview(id)
      assert.equal(reopened.extraction.reviewedAt, null)
      assert.deepEqual(reopened.extraction.reviewDecisions, [])
      assert.deepEqual(reopened.extraction.result, prepared.extraction.result)
      await assert.rejects(module.finalizeReview(id, edited, 4), rejectsWithCode('review_conflict'))
      const revised = await module.finalizeReview(id, prepared.reviewDecisions, 6)
      assert.equal(revised.disposition, 'reviewed')
      assert.equal(revised.extraction.reviewDecisions[0]!.action, 'APPROVED')
      const history = await db.orm.public.ExtractionReview.where({ extractionId: id })
        .select('id', 'revisionNumber').orderBy((review) => review.revisionNumber.asc()).all()
      assert.deepEqual(history.map((review) => review.revisionNumber), [1, 2])
      const previousDecision = await db.orm.public.ReviewDecision.where({ extractionReviewId: history[0]!.id }).select('action').first()
      assert.equal(previousDecision?.action, 'EDITED')
    })

    it('projects only the active review revision into batch results after reset', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const scheduled = await module.scheduleBatch({
        projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE', sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
        repetition: 'create-new',
      })
      const batch = await waitForBatch(module, project.projectContextId, scheduled.batch.batchExtractionId,
        (batch) => batch.executionStatus === 'COMPLETED')
      const id = batch.members[0]!.latestExtraction!.extractionId
      const input = { projectContextId: project.projectContextId, batchExtractionId: batch.batchExtractionId }
      const original = await module.readBatchResults(input)
      const prepared = await module.prepareReview(id)
      const edited = prepared.reviewDecisions.map((decision) => ({ ...decision, action: 'EDITED' as const, reviewedValue: 'Old title' }))
      await module.finalizeReview(id, edited, 0)
      assert.notDeepEqual(await module.readBatchResults(input), original)
      await module.resetReview(id, 1)
      assert.deepEqual(await module.readBatchResults(input), original)
      await module.finalizeReview(id, prepared.reviewDecisions, 2)
      assert.deepEqual(await module.readBatchResults(input), original)
    })

    it('uses the canonical package as review authority and enforces replay and conflict', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      const extractionId = completed.extraction.extractionId

      const prepared = await module.prepareReview(extractionId)
      assert.deepEqual(prepared.reviewDecisions, [
        {
          resultPath: ['records', 0, 'title'],
          evidenceAnchorId: 'a_p1_s0',
          reviewedOccurrenceIds: ['occurrence-alpha'],
          action: 'APPROVED',
          reviewedValue: null,
        },
      ])
      await assert.rejects(
        module.finalizeReview(extractionId, [
          {
            resultPath: ['records', 0, 'title'],
            evidenceAnchorId: 'a_p1_s0',
            reviewedOccurrenceIds: ['occurrence-beta'],
            action: 'APPROVED',
            reviewedValue: null,
          },
        ]),
        rejectsWithCode('invalid_review'),
      )

      await assert.rejects(
        module.finalizeReview(extractionId, [{
          ...prepared.reviewDecisions[0]!,
          action: 'EDITED',
          reviewedValue: 42,
        }]),
        rejectsWithCode('invalid_review'),
      )
      const edited = [{
        ...prepared.reviewDecisions[0]!,
        action: 'EDITED' as const,
        reviewedValue: 'Alpha corrected',
      }]
      const reviewed = await module.finalizeReview(extractionId, edited)
      assert.equal(reviewed.disposition, 'reviewed')
      assert.ok(reviewed.extraction.reviewedAt)
      assert.deepEqual(
        reviewed.extraction.reviewDecisions.map(({ createdAt: _createdAt, ...decision }) => decision),
        edited,
      )

      const replayed = await module.finalizeReview(extractionId, edited)
      assert.equal(replayed.disposition, 'replayed')
      await assert.rejects(
        module.finalizeReview(extractionId, [
          {
            resultPath: ['records', 0, 'title'],
            evidenceAnchorId: 'a_p1_s0',
            reviewedOccurrenceIds: ['occurrence-alpha'],
            action: 'REJECTED',
            reviewedValue: null,
          },
        ]),
        rejectsWithCode('review_conflict'),
      )

      const missingEvidence = await module.runSingle(freshInput(project))
      await db.orm.public.Extraction.where({
        id: missingEvidence.extraction.extractionId,
      }).update({ evidenceLinks: [] })
      await assert.rejects(
        module.finalizeReview(missingEvidence.extraction.extractionId, []),
        rejectsWithCode('invalid_review'),
      )
    })

    it('finalizes a partially grounded result without manufacturing Evidence', async (t) => {
      t.after(cleanup)
      const project = await seedProject({
        recordDescription: 'One partially grounded product record.',
        schemaNodes: [
          { id: 'title-node', name: 'title', type: 'string' },
          { id: 'note-node', name: 'note', type: 'string' },
        ],
      })
      kei.respond = (request) => ({
        artifact: {
          ...deterministicArtifact(request), complete: false,
          records: [{ title: 'Alpha', note: 'Beta' }],
          ungrounded: [['records', 0, 'note']],
        },
      })
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      assert.equal(completed.extraction.outcome, 'SUCCEEDED')
      assert.equal(completed.extraction.complete, false)
      assert.equal(completed.extraction.reviewable, true)
      assert.equal(completed.extraction.evidence?.length, 1)
      assert.equal(completed.extraction.diagnostics!.ungroundedPaths.length, 1)

      const prepared = await module.prepareReview(completed.extraction.extractionId)
      assert.equal(prepared.reviewDecisions.length, 1)
      const reviewed = await module.finalizeReview(
        completed.extraction.extractionId,
        prepared.reviewDecisions,
      )
      assert.equal(reviewed.disposition, 'reviewed')
      assert.ok(reviewed.extraction.reviewedAt)
      assert.equal(reviewed.extraction.reviewDecisions.length, 1)
      assert.equal(reviewed.extraction.diagnostics.ungroundedPaths.length, 1)
    })

    it('stores independent value decisions when two paths share one Evidence anchor', async (t) => {
      t.after(cleanup)
      const project = await seedProject({
        recordDescription: 'One record with two grounded values.',
        schemaNodes: [
          { id: 'title-node', name: 'title', type: 'string' },
          { id: 'note-node', name: 'note', type: 'string' },
        ],
      })
      kei.respond = (request) => {
        const artifact = deterministicArtifact(request)
        return { artifact: { ...artifact, records: [{ title: 'Alpha', note: 'Alpha' }], evidence: [
          ...artifact.evidence, { ...artifact.evidence[0]!, path: ['records', 0, 'note'] },
        ] } }
      }
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      const prepared = await module.prepareReview(completed.extraction.extractionId)
      assert.equal(prepared.reviewDecisions.length, 2)
      assert.equal(new Set(prepared.reviewDecisions.map((decision) => decision.evidenceAnchorId)).size, 1)

      const decisions = prepared.reviewDecisions.map((decision, index) => ({
        ...decision,
        action: index === 0 ? 'EDITED' as const : 'REJECTED' as const,
        reviewedValue: index === 0 ? 'Alpha corrected' : null,
      }))
      const reviewed = await module.finalizeReview(
        completed.extraction.extractionId,
        decisions,
      )
      assert.equal(reviewed.extraction.reviewDecisions.length, 2)
      for (const decision of decisions) {
        const stored = reviewed.extraction.reviewDecisions.find(
          (candidate) => JSON.stringify(candidate.resultPath) === JSON.stringify(decision.resultPath),
        )
        assert.equal(stored?.action, decision.action)
        assert.equal(stored?.reviewedValue, decision.reviewedValue)
        assert.ok(stored?.createdAt)
      }
    })

    it('selects latest attempt and latest reviewed across representation history', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const reviewedAttempt = await module.runSingle(freshInput(project))
      const prepared = await module.prepareReview(
        reviewedAttempt.extraction.extractionId,
      )
      await module.finalizeReview(
        reviewedAttempt.extraction.extractionId,
        prepared.reviewDecisions,
      )

      const newerRepresentationId = await addRepresentation(
        document,
        'article-reparsed.pdf',
      )
      const latestAttempt = await module.runSingle({
        ...freshInput(project),
        sourceRepresentationRevisionId: newerRepresentationId,
      })
      const reopened = await module.readDocumentExtractions({
        sourceDocumentId: document.sourceDocumentId,
      })

      assert.equal(
        reopened?.latestAttempt?.extractionId,
        latestAttempt.extraction.extractionId,
      )
      assert.equal(
        reopened?.latestReviewed?.extractionId,
        reviewedAttempt.extraction.extractionId,
      )
      assert.equal(
        reopened?.latestReviewed?.sourceRepresentationRevisionId,
        document.sourceRepresentationRevisionId,
      )
      const historical = await module.readDocumentExtractions({
        sourceDocumentId: document.sourceDocumentId,
        extractionId: reviewedAttempt.extraction.extractionId,
      })
      assert.equal(
        historical?.sourceRepresentationRevisionId,
        document.sourceRepresentationRevisionId,
      )
    })

    it('fails an Extraction whose canonical package is unavailable without inventing a result', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      await packages.remove(document.storedPackage, async () => false)
      const input = freshInput(project)

      const failed = await module.runSingle(input)
      assert.equal(failed.extraction.executionStatus, 'FAILED')
      assert.equal(failed.extraction.outcome, null)
      assert.deepEqual(failed.extraction.failure, {
        code: 'invalid_source_representation', message: 'The pinned Source Representation is unavailable.', phase: 'persisting',
      })
      const row = await extractionRow(input.extractionId)
      assert.equal(row?.outcome, 'FAILED')
      assert.equal(row?.resultPayload, null)
      assert.equal(await module.cancelSingle(input.extractionId), 'not-found')
    })

    it('stores the Catalog recipe chosen for an Extraction on its row and hands it to kei', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const extractionId = randomUUID()
      const input = { ...freshInput(project, extractionId), strategy: 'CATALOG' as const,
                      catalogRecipe: 'numbered-catalogue-de@1' }
      // Every read of the attempt names its recipe, so a failed attempt can be run again with it.
      assert.equal((await module.runSingle(input)).extraction.catalogRecipe, 'numbered-catalogue-de@1')
      assert.equal((await module.runSingle(input)).disposition, 'replayed')
      assert.equal((await module.readExtractionAttempt(extractionId))?.catalogRecipe, 'numbered-catalogue-de@1')
      await assert.rejects(module.runSingle({ ...input, catalogRecipe: null }),
        (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_id_conflict')
      assert.equal((await extractionRow(extractionId))?.catalogRecipe, 'numbered-catalogue-de@1')
      await heldByKei(extractionId)
      const request = kei.submissions.find((submission) => submission.workflowId === keiExtractWorkflowId(extractionId))!
        .request as KeiExtractInput
      assert.deepEqual(request.request.options, { strategy: 'catalog', catalog: { recipe: 'numbered-catalogue-de@1' } })
    })

    it('keeps the Extraction Model Choice on its row, hands it to kei, and records the model each role ran on', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      kei.respond = (request) => ({
        artifact: { ...deterministicArtifact(request), models: { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' } },
      })
      const { module, scheduled } = createRuntime(project.researcherAccountId)
      const models = { fields: 'nuextract', reasoning: 'instruct' }
      const input = { ...freshInput(project), models }
      const queued = await scheduled.runSingle(input)
      assert.deepEqual(queued.extraction.requestedModels, models)
      // A replay must ask for the same models: another choice under the same id is another Extraction.
      for (const other of [null, {}, { fields: 'nuextract' }, { fields: 'instruct', reasoning: 'instruct' }])
        await assert.rejects(module.runSingle({ ...input, models: other }),
          (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_id_conflict')
      const created = await module.runSingle({ ...input, models: { reasoning: 'instruct', fields: 'nuextract' } })
      assert.equal(created.disposition, 'replayed')
      assert.equal(created.extraction.outcome, 'SUCCEEDED')
      assert.deepEqual(kei.submissions.map((submission) => (submission.request as KeiExtractInput).request.options.models), [models])
      assert.deepEqual(created.extraction.requestedModels, models)
      assert.deepEqual(created.extraction.diagnostics?.models,
        { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' })
      assert.deepEqual(created.extraction.modelAttribution, { provider: 'kei-exp', modelId: 'deterministic' })
      assert.deepEqual((await extractionRow(input.extractionId))?.requestedModels, models)
      const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
      assert.deepEqual(reopened?.latestAttempt?.requestedModels, models)
    })

    it('reads no result values from a row without a published result, whatever its columns hold', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const input = freshInput(project)
      await module.runSingle(input)
      await heldByKei(input.extractionId)
      const planted = {
        complete: true,
        modelAttribution: { provider: 'kei-exp', modelId: 'planted' },
        diagnostics: { phase: 'grounding' },
        resultPayload: { records: [{ place: 'Rome' }] },
        evidenceLinks: [],
        reviewable: true,
      }
      await db.orm.public.Extraction.where({ id: input.extractionId }).updateAll(planted)
      const running = await module.readExtractionAttempt(input.extractionId)
      assert.equal(running?.executionStatus, 'RUNNING')
      assert.deepEqual([running?.result, running?.complete, running?.modelAttribution, running?.diagnostics, running?.reviewable],
        [null, null, null, null, false])
      const failure = { code: 'planted_failure', message: 'A planted failure.', phase: 'grounding' as const }
      await db.orm.public.Extraction.where({ id: input.extractionId }).updateAll({ outcome: 'FAILED', failure })
      const failed = await module.readExtractionAttempt(input.extractionId)
      assert.equal(failed?.executionStatus, 'FAILED')
      assert.deepEqual([failed?.result, failed?.complete, failed?.modelAttribution, failed?.diagnostics, failed?.reviewable],
        [null, null, null, null, false])
      assert.deepEqual(failed?.failure, failure)
      await assert.rejects(module.prepareReview(input.extractionId), rejectsWithCode('not_found'))
    })

    it('stores batch model choices on every member Extraction and includes them in selection identity', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const module = scheduler(project.researcherAccountId)
      const input = {
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE' as const,
        sourceDocumentIds: project.documents.map(document => document.sourceDocumentId),
        repetition: 'reuse-equal-selection' as const,
      }
      // Preserve the pre-model-choice identity for deployments with no selected roles.
      const hash = createHash('sha256').update(JSON.stringify([
        input.projectContextId, input.schemaRevisionId, input.strategy,
        [...input.sourceDocumentIds].sort((left, right) => left.localeCompare(right)),
      ])).digest('hex')
      const variant = ['8', '9', 'a', 'b'][parseInt(hash[16]!, 16) & 3]
      const originalId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-${variant}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      const defaults = await module.scheduleBatch(input)
      assert.equal(defaults.batch.batchExtractionId, originalId)
      for (const models of [null, {}, { fields: '' }]) {
        const replay = await module.scheduleBatch({ ...input, models })
        assert.equal(replay.disposition, 'replayed')
        assert.equal(replay.batch.batchExtractionId, originalId)
      }
      const ids = new Set([originalId])
      for (const models of [null, { fields: 'nuextract', reasoning: 'instruct' },
        { fields: 'instruct', reasoning: 'instruct' }, { fields: 'nuextract', reasoning: 'other' }]) {
        const scheduled = await module.scheduleBatch({ ...input, models })
        const batchExtractionId = scheduled.batch.batchExtractionId
        if (models) {
          assert.equal(scheduled.disposition, 'created')
          assert.ok(!ids.has(batchExtractionId))
          ids.add(batchExtractionId)
          const replay = await module.scheduleBatch({
            ...input, sourceDocumentIds: [...input.sourceDocumentIds].reverse(),
            models: { reasoning: models.reasoning, fields: models.fields },
          })
          assert.equal(replay.disposition, 'replayed')
          assert.equal(replay.batch.batchExtractionId, batchExtractionId)
        }
        await waitForBatch(module, project.projectContextId, batchExtractionId, batch => batch.executionStatus === 'COMPLETED')
        const members = await db.orm.public.Extraction.where({ batchExtractionId })
          .select('id', 'requestedModels', 'outcome').all()
        assert.equal(members.length, project.documents.length)
        for (const member of members) {
          assert.deepEqual(member.requestedModels, models)
          assert.equal(member.outcome, 'SUCCEEDED')
          const submission = kei.submissions.find((candidate) => candidate.workflowId === keiExtractWorkflowId(member.id))!
          assert.deepEqual((submission.request as KeiExtractInput).request.options.models ?? null, models)
        }
      }
    })

    it('stores no Extraction Model Choice when every role keeps kei-exp\'s defaults', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      for (const models of [undefined, null, {}]) {
        const input = { ...freshInput(project), models }
        const created = await module.runSingle(input)
        assert.equal(created.extraction.requestedModels, null)
        // No choice and an empty choice are the same request.
        assert.equal((await module.runSingle({ ...input, models: {} })).disposition, 'replayed')
        assert.equal((await extractionRow(input.extractionId))?.requestedModels, null)
      }
      assert.deepEqual(kei.submissions.map((submission) => (submission.request as KeiExtractInput).request.options.models ?? null),
        [null, null, null])
    })

    it('rejects duplicate members, atomically pins valid members, replays equal selections, and creates explicit repetitions', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['b.pdf', 'a.pdf'])
      const foreign = await seedProject()
      const module = scheduler(project.researcherAccountId)
      const selected = [
        project.documents[1]!.sourceDocumentId,
        project.documents[0]!.sourceDocumentId,
      ]
      const input = {
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE' as const,
        sourceDocumentIds: selected,
        repetition: 'reuse-equal-selection' as const,
      }

      await assert.rejects(
        module.scheduleBatch({
          ...input,
          sourceDocumentIds: [...selected, selected[0]!],
        }),
        rejectsWithCode('invalid_extraction_pins'),
      )
      const created = await module.scheduleBatch(input)
      assert.equal(created.disposition, 'created')
      assert.deepEqual(
        created.batch.members.map((member) => member.sourceDocumentId),
        [...new Set(selected)].sort(),
      )
      const originalPins = created.batch.members.map((member) =>
        member.sourceRepresentationRevisionId,
      )
      await addRepresentation(project.documents[0]!, 'b-v2.pdf')
      await addRepresentation(project.documents[1]!, 'a-v2.pdf')

      const replayed = await module.scheduleBatch(input)
      assert.equal(replayed.disposition, 'replayed')
      assert.equal(
        replayed.batch.batchExtractionId,
        created.batch.batchExtractionId,
      )
      assert.deepEqual(
        replayed.batch.members.map((member) =>
          member.sourceRepresentationRevisionId,
        ),
        originalPins,
      )

      const repeatedInput = { ...input, repetition: 'create-new' as const }
      const firstRepeat = await module.scheduleBatch(repeatedInput)
      const secondRepeat = await module.scheduleBatch(repeatedInput)
      assert.notEqual(
        firstRepeat.batch.batchExtractionId,
        secondRepeat.batch.batchExtractionId,
      )
      assert.ok(
        firstRepeat.batch.members.every(
          (member) => !originalPins.includes(member.sourceRepresentationRevisionId),
        ),
      )

      const before = await module.listBatches({
        projectContextId: project.projectContextId,
      })
      await assert.rejects(
        module.scheduleBatch({
          ...input,
          sourceDocumentIds: [
            project.documents[0]!.sourceDocumentId,
            foreign.documents[0]!.sourceDocumentId,
          ],
          repetition: 'create-new',
        }),
        rejectsWithCode('not_found'),
      )
      const after = await module.listBatches({
        projectContextId: project.projectContextId,
      })
      assert.equal(after.length, before.length)
      const foreignModule = scheduler(foreign.researcherAccountId)
      const foreignBatch = await foreignModule.scheduleBatch({
        projectContextId: foreign.projectContextId,
        schemaRevisionId: foreign.schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: [
          foreign.documents[0]!.sourceDocumentId,
        ],
        repetition: 'create-new',
      })
      await assert.rejects(
        module.listBatches({
          projectContextId: foreign.projectContextId,
        }),
        rejectsWithCode('not_found'),
      )
      for (const projectContextId of [
        project.projectContextId,
        foreign.projectContextId,
      ]) {
        await assert.rejects(
          module.readBatch({
            projectContextId,
            batchExtractionId:
              foreignBatch.batch.batchExtractionId,
          }),
          rejectsWithCode('not_found'),
        )
        await assert.rejects(
          module.readBatchResults({
            projectContextId,
            batchExtractionId:
              foreignBatch.batch.batchExtractionId,
          }),
          rejectsWithCode('not_found'),
        )
      }
      const completedForeign = await waitForBatch(
        foreignModule,
        foreign.projectContextId,
        foreignBatch.batch.batchExtractionId,
        (batch) => batch.executionStatus === 'COMPLETED',
      )
      assert.equal(completedForeign.executionStatus, 'COMPLETED')
      const results = await foreignModule.readBatchResults({
        projectContextId: foreign.projectContextId, batchExtractionId: foreignBatch.batch.batchExtractionId,
      })
      assert.deepEqual([results.successfulResults, results.pending, results.failed, results.cancelled], [1, 0, 0, 0])
    })

    it('counts a member kei cancelled as cancelled and an interrupted one as failed', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['cancelled.pdf', 'interrupted.pdf'])
      const [cancelled, interrupted] = project.documents as [SeededDocument, SeededDocument]
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const scheduled = await module.scheduleBatch({
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
        repetition: 'create-new',
      })
      const batchExtractionId = scheduled.batch.batchExtractionId
      const memberOf = (document: SeededDocument) =>
        stableUuid('batch-member-extraction', stableJson([batchExtractionId, document.sourceDocumentId]))
      await heldByKei(memberOf(cancelled))
      await heldByKei(memberOf(interrupted))
      // kei's own cancel of a child settles the member FAILED with code `cancelled`.
      await kei.handoff.cancel(keiExtractWorkflowId(memberOf(cancelled)))
      // A Studio workflow stopped without an outcome leaves its member interrupted.
      await DBOS.cancelWorkflow(`extract:${memberOf(interrupted)}`)
      await eventually(() => extractionRow(memberOf(cancelled)), (row) => row?.outcome === 'FAILED', 'the cancelled member settles')
      const results = await module.readBatchResults({ projectContextId: project.projectContextId, batchExtractionId })
      assert.deepEqual([results.totalMembers, results.pending, results.failed, results.cancelled], [2, 0, 1, 1])
      assert.equal(results.executionStatus, 'COMPLETED')
      const batch = await module.readBatch({ projectContextId: project.projectContextId, batchExtractionId })
      assert.deepEqual(batch.members.map((member) => [member.executionStatus, member.failureMessage]).sort(), [
        ['FAILED', 'The Extraction was cancelled.'],
        ['FAILED', 'This work stopped before it finished. Start it again.'],
      ])
    })

    it('a ready suggestion hands its saved pins to one replayable batch of pending member Extractions', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const module = scheduler(project.researcherAccountId)
      kei.holding = true
      const batchSchemaSuggestionId = randomUUID()
      await db.orm.public.BatchSchemaSuggestion.create({
        id: batchSchemaSuggestionId,
        projectContextId: project.projectContextId,
        selectionKey: sha256(strToU8(batchSchemaSuggestionId)),
      })
      for (const document of project.documents)
        await db.orm.public.BatchSchemaSuggestionSource.create({
          batchSchemaSuggestionId,
          sourceDocumentId: document.sourceDocumentId,
          sourceRepresentationRevisionId:
            document.sourceRepresentationRevisionId,
        })
      await db.orm.public.BatchSchemaSuggestion.where({
        id: batchSchemaSuggestionId,
      }).update({
        outcome: 'SUCCEEDED',
        phase: 'READY',
        draft: ARTICLE_SCHEMA,
        draftVersion: 1,
      })
      // The suggestion's saved revisions are kept even after a reprocess (PR #140's documented exemption).
      await addRepresentation(project.documents[0]!, 'one-v2.pdf')

      const request = {
        projectContextId: project.projectContextId,
        batchSchemaSuggestionId,
        strategy: 'ARTICLE' as const,
        models: { reasoning: 'instruct', fields: 'nuextract' },
      }
      const handoffs = await Promise.all([
        module.scheduleSuggestedBatch(request),
        module.scheduleSuggestedBatch(request),
      ])
      assert.deepEqual(
        handoffs.map((handoff) => handoff.disposition).sort(),
        ['created', 'replayed'],
      )
      const batchExtractionId = handoffs[0]!.batch.batchExtractionId
      assert.equal(handoffs[1]!.batch.batchExtractionId, batchExtractionId)
      const pins = project.documents
        .map((document) => ({
          sourceDocumentId: document.sourceDocumentId,
          sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
        }))
        .sort((left, right) => left.sourceDocumentId.localeCompare(right.sourceDocumentId))
      assert.deepEqual(
        handoffs[0]!.batch.members.map((member) => ({
          sourceDocumentId: member.sourceDocumentId,
          sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
        })),
        pins,
      )
      const members = async () => db.orm.public.Extraction.where({ batchExtractionId })
        .select('id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'requestedModels', 'outcome').all()
      const rows = await members()
      assert.equal(rows.length, project.documents.length)
      for (const row of rows) {
        assert.equal(row.id, stableUuid('batch-member-extraction', stableJson([batchExtractionId, row.sourceDocumentId])))
        assert.deepEqual(row.requestedModels, request.models)
        assert.equal(row.outcome, null)
      }
      const workflows = () => app.admission.listWorkflows({ workflowIDs: rows.map((row) => `extract:${row.id}`) })
      assert.equal((await workflows()).length, project.documents.length)
      const persisted = await db.orm.public.BatchSchemaSuggestion.select(
        'confirmedSchemaRevisionId',
        'batchExtractionId',
      ).first({ id: batchSchemaSuggestionId })
      assert.ok(persisted?.confirmedSchemaRevisionId)
      assert.equal(persisted.batchExtractionId, batchExtractionId)
      assert.equal(handoffs[0]!.batch.schemaRevisionId, persisted.confirmedSchemaRevisionId)
      for (const row of rows) {
        const [workflow] = await app.admission.listWorkflows({ workflowIDs: [`extract:${row.id}`] })
        assert.equal(workflow?.attributes?.extractionSchemaId, (await db.orm.public.SchemaRevision.select('extractionSchemaId')
          .first({ id: persisted.confirmedSchemaRevisionId }))?.extractionSchemaId)
      }

      // A repeat replays the handoff and adds no rows or workflows.
      const repeated = await module.scheduleSuggestedBatch(request)
      assert.equal(repeated.disposition, 'replayed')
      assert.equal(repeated.batch.batchExtractionId, batchExtractionId)
      assert.equal((await members()).length, project.documents.length)
      assert.equal((await workflows()).length, project.documents.length)
    })

    it('rejects invalid stored suggestion drafts inside the atomic batch transaction', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf'])
      const module = scheduler(project.researcherAccountId)
      const invalidDrafts = [
        {
          recordDescription: '   ',
          schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
        },
        {
          recordDescription: 'One invalid record.',
          schemaNodes: [
            { id: 'title-1', name: 'title', type: 'string' },
            { id: 'title-2', name: 'title', type: 'integer' },
          ],
        },
      ]

      for (const draft of invalidDrafts) {
        const batchSchemaSuggestionId = randomUUID()
        await db.orm.public.BatchSchemaSuggestion.create({
          id: batchSchemaSuggestionId,
          projectContextId: project.projectContextId,
          selectionKey: sha256(strToU8(batchSchemaSuggestionId)),
        })
        await db.orm.public.BatchSchemaSuggestionSource.create({
          batchSchemaSuggestionId,
          sourceDocumentId: project.documents[0]!.sourceDocumentId,
          sourceRepresentationRevisionId:
            project.documents[0]!.sourceRepresentationRevisionId,
        })
        await db.orm.public.BatchSchemaSuggestion.where({
          id: batchSchemaSuggestionId,
        }).update({
          outcome: 'SUCCEEDED',
          phase: 'READY',
          draft,
          draftVersion: 1,
        })

        await assert.rejects(
          module.scheduleSuggestedBatch({
            projectContextId: project.projectContextId,
            batchSchemaSuggestionId,
            strategy: 'ARTICLE',
          }),
          rejectsWithCode('batch_not_ready'),
        )
        const persisted = await db.orm.public.BatchSchemaSuggestion.select(
          'confirmedSchemaRevisionId',
          'batchExtractionId',
        ).first({ id: batchSchemaSuggestionId })
        assert.deepEqual(persisted, {
          confirmedSchemaRevisionId: null,
          batchExtractionId: null,
        })
      }

      assert.equal(
        (
          await db.orm.public.BatchExtraction.where({
            projectContextId: project.projectContextId,
          })
            .select('id')
            .all()
        ).length,
        0,
      )
      assert.equal((await db.orm.public.Extraction.where({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
        .select('id').all()).length, 0)
    })

    it('Run requires a valid draft, a surviving member and no active attempt', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      /** The DBOS status each suggestion attempt reports; an attempt missing here is gone (interrupted). */
      const attempts = new Map<string, string>()
      const module = createExtractionModule(
        createResearcherExtractionPersistence(project.researcherAccountId, {
          ...execution,
          async statuses(workflowIds) {
            const suggestions = workflowIds.filter((id) => id.startsWith('suggest:'))
            const statuses = new Map(await execution.statuses(workflowIds.filter((id) => !id.startsWith('suggest:'))))
            for (const id of suggestions) if (attempts.has(id)) statuses.set(id, attempts.get(id)!)
            return statuses
          },
        }, { database: db as Database, packages }),
      )
      async function suggestion(fields: Record<string, unknown>, members = project.documents) {
        const batchSchemaSuggestionId = randomUUID()
        await db.orm.public.BatchSchemaSuggestion.create({
          id: batchSchemaSuggestionId,
          projectContextId: project.projectContextId,
          selectionKey: sha256(strToU8(batchSchemaSuggestionId)),
        })
        for (const document of members)
          await db.orm.public.BatchSchemaSuggestionSource.create({
            batchSchemaSuggestionId,
            sourceDocumentId: document.sourceDocumentId,
            sourceRepresentationRevisionId: document.sourceRepresentationRevisionId,
          })
        await db.orm.public.BatchSchemaSuggestion.where({ id: batchSchemaSuggestionId }).update(fields)
        return batchSchemaSuggestionId
      }
      const run = (batchSchemaSuggestionId: string) =>
        module.scheduleSuggestedBatch({ projectContextId: project.projectContextId, batchSchemaSuggestionId, strategy: 'ARTICLE' })
      const unconfirmed = async (batchSchemaSuggestionId: string) =>
        assert.deepEqual(
          await db.orm.public.BatchSchemaSuggestion.select('confirmedSchemaRevisionId', 'batchExtractionId')
            .first({ id: batchSchemaSuggestionId }),
          { confirmedSchemaRevisionId: null, batchExtractionId: null },
        )
      const ready = { phase: 'READY', draft: ARTICLE_SCHEMA, draftVersion: 1 }

      // No draft yet: the first attempt has not published one.
      const drafting = await suggestion({ outcome: 'SUCCEEDED', phase: 'HETEROGENEOUS' })
      await assert.rejects(run(drafting), rejectsWithCode('batch_not_ready'))
      await unconfirmed(drafting)

      // A valid draft with no surviving member (its sources were deleted).
      const empty = await suggestion({ outcome: 'SUCCEEDED', ...ready }, [])
      await assert.rejects(run(empty), rejectsWithCode('batch_not_ready'))
      await unconfirmed(empty)

      // A retained draft while the next attempt runs: its result will replace the draft.
      const retrying = await suggestion({ attempt: 2, outcome: null, ...ready })
      for (const status of ['ENQUEUED', 'PENDING']) {
        attempts.set(`suggest:${retrying}:2`, status)
        await assert.rejects(run(retrying), rejectsWithCode('batch_not_ready'))
        await unconfirmed(retrying)
      }

      // The latest attempt need not have succeeded: a failed or interrupted attempt keeps a valid draft runnable.
      const failed = await suggestion({ attempt: 2, outcome: 'FAILED', failure: { code: 'source_suggestion_failed', message: 'Failed.' }, ...ready })
      assert.equal((await run(failed)).disposition, 'created')
      attempts.set(`suggest:${retrying}:2`, 'CANCELLED')
      assert.equal((await run(retrying)).disposition, 'created')
      const persisted = await db.orm.public.BatchSchemaSuggestion.select('confirmedSchemaRevisionId', 'batchExtractionId')
        .first({ id: retrying })
      assert.ok(persisted?.confirmedSchemaRevisionId)
      assert.ok(persisted.batchExtractionId)

      const removable = await suggestion({ outcome: 'SUCCEEDED', ...ready }, [project.documents[0]!])
      const projectStore = createResearcherProjectStore(project.researcherAccountId, db)
      assert.deepEqual(await projectStore.deleteSourceDocument(project.projectContextId, project.documents[0]!.sourceDocumentId),
        { interruptedAttempts: [] })
      await assert.rejects(run(removable), rejectsWithCode('batch_not_ready'))
      assert.deepEqual(await projectStore.retryBatchSchemaSuggestion(project.projectContextId, removable, 1), { status: 'not-ready' })
      assert.deepEqual((await db.orm.public.BatchSchemaSuggestion.select('draft', 'draftVersion').first({ id: removable })),
        { draft: ARTICLE_SCHEMA, draftVersion: 1 })
    })
  })

  describe('through kei\'s contract', () => {
    const keiSchema = `kei_dbos_t_${randomBytes(4).toString('hex')}`
    let standIn: Awaited<ReturnType<typeof spawnKeiStandIn>> | undefined
    let keiClient: DBOSClient | undefined

    after(async () => {
      try {
        await standIn?.stop()
      } finally {
        try {
          await keiClient?.destroy()
        } finally {
          const admin = new pg.Client({ connectionString: disposableDatabaseUrl })
          await admin.connect()
          try {
            if (!/^kei_dbos_t_[0-9a-f]{8}$/.test(keiSchema)) throw new Error(`Refusing to drop schema ${keiSchema}.`)
            await admin.query(`DROP SCHEMA IF EXISTS "${keiSchema}" CASCADE`)
          } finally {
            await admin.end()
          }
        }
      }
    })

    it('an Extraction runs end to end on the stand-in and publishes the artifact kei published', async (t) => {
      t.after(cleanup)
      standIn = await spawnKeiStandIn({ databaseUrl: disposableDatabaseUrl, schema: keiSchema })
      await standIn.policy({ extract: 'auto' })
      keiClient = await DBOSClient.create({
        systemDatabaseUrl: disposableDatabaseUrl, systemDatabaseSchemaName: keiSchema, applicationName: KEI_APPLICATION,
      })
      const keiExp = createKeiExpClient({ url: standIn.url })
      ports = {
        ...scriptedPorts,
        kei: createKeiHandoff(keiClient, { pollWindowMs: 3_000, pollIntervalMs: 100 }),
        readArtifact: (runId, extractionId, signal) => keiExp.readExtractionArtifact(runId, extractionId, signal),
      }
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      const completed = await module.runSingle(input)
      assert.equal(completed.extraction.executionStatus, 'COMPLETED')
      const published = JSON.parse(new TextDecoder().decode(
        await keiExp.readExtractionArtifact(document.runId, input.extractionId),
      )) as { records: unknown[]; model: string; models: Record<string, string>; complete: boolean }
      assert.deepEqual(completed.extraction.result, { records: published.records })
      assert.equal(completed.extraction.complete, published.complete)
      assert.deepEqual(completed.extraction.modelAttribution, { provider: 'kei-exp', modelId: published.model })
      assert.deepEqual(completed.extraction.diagnostics?.models, published.models)
      const [child] = await keiClient.listWorkflows({ workflowIDs: [keiExtractWorkflowId(input.extractionId)], loadInput: false })
      assert.equal(child?.status, 'SUCCESS')
      assert.equal(child?.queueName, 'kei-extract')
      assert.equal(child?.priority, 1)
      assert.equal(child?.attributes?.keiRunId, document.runId)
      assert.equal(kei.submissions.length, 0)
    })
  })

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
}
