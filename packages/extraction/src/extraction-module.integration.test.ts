import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import type { CanonicalPackageStore, Database } from 'db'
import type {
  ExtractionModel,
  ExtractionModelRequest,
  GroundingModel,
} from './dependencies.js'
import type {
  BatchExtractionSnapshot,
  ExtractionModule,
  ExtractionRuntime,
} from './types.js'

const configuredDatabaseUrl =
  process.env.EXTRACTION_TEST_DATABASE_URL ?? process.env.DATABASE_URL
const disposableDatabaseUrl = (() => {
  if (!configuredDatabaseUrl) return null
  try {
    const url = new URL(configuredDatabaseUrl)
    return url.pathname.slice(1).startsWith('free_test_') ? configuredDatabaseUrl : null
  } catch {
    return null
  }
})()

if (!disposableDatabaseUrl) {
  test(
    'ExtractionModule PostgreSQL contracts',
    {
      skip: configuredDatabaseUrl
        ? 'EXTRACTION_TEST_DATABASE_URL/DATABASE_URL must name a disposable free_test_* database'
        : 'set EXTRACTION_TEST_DATABASE_URL (or DATABASE_URL) to a migrated disposable free_test_* database',
    },
    () => {},
  )
} else {
  process.env.DATABASE_URL = disposableDatabaseUrl

  const [
    { db },
    { createCanonicalPackageStore },
    { createResearcherProjectStore },
    { createExtractionRuntimeWithInfrastructure },
  ] =
    await Promise.all([
      import('../../db/src/prisma/db.js'),
      import('../../db/src/artifact-store.js'),
      import('../../db/src/project-store.js'),
      import('./runtime.js'),
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
  const metadata = {
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 5,
    durationMs: 1,
  } as const
  const attribution = { provider: 'test', modelId: 'deterministic' } as const

  type StoredPackage = {
    artifactReference: string
    artifactSha256: string
  }
  type SeededDocument = {
    sourceDocumentId: string
    sourceRepresentationRevisionId: string
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

  type DeterministicAdapters = {
    model: ExtractionModel
    groundingModel: GroundingModel
    calls: ExtractionModelRequest[]
  }
  const projects = new Set<string>()
  const accounts = new Set<string>()
  const runtimes = new Set<ExtractionRuntime>()
  let packageRoot = ''
  let packages: CanonicalPackageStore

  const sha256 = (value: Uint8Array) =>
    createHash('sha256').update(value).digest('hex')

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
              anchor_id: 'anchor-alpha',
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
              anchor_id: 'anchor-beta',
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
        email: `${researcherAccountId}@example.test`,
        passwordHash: 'test-only-password-hash',
        mustChangePassword: false,
        disabledAt: null,
        sessionVersion: 0,
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
        ingestionKey: randomUUID(),
        contentSha256: sha256(strToU8(filename)),
        mediaType: 'application/pdf',
        originalName: filename,
      })
      const sourceRepresentationRevisionId = randomUUID()
      await db.orm.public.SourceRepresentationRevision.create({
        id: sourceRepresentationRevisionId,
        sourceDocumentId,
        revisionNumber: 1,
        artifactReference: storedPackage.artifactReference,
        artifactSha256: storedPackage.artifactSha256,
        contractVersion: 'parsed_document.v2',
        preprocessId: `seed-${randomUUID()}`,
        parserName: 'test',
        parserVersion: '1',
      })
      documents.push({
        sourceDocumentId,
        sourceRepresentationRevisionId,
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
      preprocessId: `seed-${randomUUID()}`,
      parserName: 'test',
      parserVersion: '1',
    })
    return sourceRepresentationRevisionId
  }

  function deterministicAdapters(options: {
    failArticle?: boolean
  } = {}): DeterministicAdapters {
    const calls: ExtractionModelRequest[] = []
    const model: ExtractionModel = {
      async extract(request) {
        calls.push(request)
        if (request.signal.aborted)
          throw new DOMException('Aborted', 'AbortError')
        if (options.failArticle)
          throw new Error('controlled article failure')
        return {
          result: {
            records: [{ title: 'Alpha' }],
          },
          metadata,
          attribution,
        }
      },
    }
    const groundingModel: GroundingModel = {
      async ground(request) {
        const labels = Object.keys(request.anchors)
        return {
          selections: Object.keys(request.claims).map((claimLabel, index) => ({
            claimLabel,
            anchorLabel: labels[index] ?? labels[0] ?? null,
          })),
          metadata,
          attribution,
        }
      },
    }
    return { model, groundingModel, calls }
  }

  function createRuntime(
    researcherAccountId: string,
    adapters: DeterministicAdapters = deterministicAdapters(),
  ) {
    const runtime = createExtractionRuntimeWithInfrastructure(
      {
        models: {
          async open() {
            return {
              attribution,
              model: adapters.model,
              groundingModel: adapters.groundingModel,
            }
          },
        },
        now: () => 100,
      },
      { database: db as Database, packages },
    )
    runtimes.add(runtime)
    return {
      runtime,
      module: runtime.forResearcher(researcherAccountId),
      adapters,
    }
  }

  const freshInput = (
    project: SeededProject,
    extractionId = randomUUID(),
  ) => ({
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
    const deadline = Date.now() + 5_000
    for (;;) {
      const batch = await module.readBatch({ projectContextId, batchExtractionId })
      if (predicate(batch)) return batch
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for Batch Extraction ${batchExtractionId}.`)
      const turn = Promise.withResolvers<void>()
      setImmediate(turn.resolve)
      await turn.promise
    }
  }

  async function runWorkerUntil(
    runtime: ExtractionRuntime,
    module: ExtractionModule,
    projectContextId: string,
    batchExtractionId: string,
    predicate: (batch: BatchExtractionSnapshot) => boolean,
  ) {
    const controller = new AbortController()
    const running = runtime.run(controller.signal)
    try {
      return await waitForBatch(
        module,
        projectContextId,
        batchExtractionId,
        predicate,
      )
    } finally {
      controller.abort()
      await running
    }
  }

  async function cleanup() {
    for (const runtime of runtimes) await runtime.close()
    runtimes.clear()
    for (const projectContextId of projects)
      await db.orm.public.ProjectContext.where({ id: projectContextId }).delete()
    projects.clear()
    for (const researcherAccountId of accounts)
      await db.orm.public.ResearcherAccount.where({
        id: researcherAccountId,
      }).delete()
    accounts.clear()
  }

  packageRoot = await mkdtemp(join(tmpdir(), 'free-extraction-contract-'))
  packages = createCanonicalPackageStore(packageRoot)

  describe('ExtractionModule on disposable PostgreSQL', () => {
    it('scopes run, read, review, and cancellation to one researcher', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const foreign = await seedProject()
      const contested = createRuntime(project.researcherAccountId)
      const contestedInput = freshInput(project)
      const accepted = contested.module.runSingle(contestedInput)
      await assert.rejects(
        contested.runtime
          .forResearcher(foreign.researcherAccountId)
          .runSingle({
            ...freshInput(foreign),
            extractionId: contestedInput.extractionId,
          }),
        rejectsWithCode('not_found'),
      )
      await accepted
      assert.equal(contested.adapters.calls.length, 1)
      const { module, adapters } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)

      const created = await module.runSingle(input)
      assert.equal(created.disposition, 'created')
      assert.equal(created.extraction.outcome, 'SUCCEEDED')
      assert.equal(created.extraction.complete, true)
      assert.deepEqual(created.extraction.result, {
        records: [{ title: 'Alpha', filename: 'article.pdf' }],
      })
      assert.equal(adapters.calls.length, 1)

      const replayed = await module.runSingle(input)
      assert.equal(replayed.disposition, 'replayed')
      assert.equal(replayed.extraction.extractionId, input.extractionId)
      assert.equal(adapters.calls.length, 1)

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
      assert.equal(adapters.calls.length, 1)

      const foreignModule = createRuntime(
        foreign.researcherAccountId,
      ).module
      const foreignExtraction = await foreignModule.runSingle(
        freshInput(foreign),
      )
      const foreignExtractionId =
        foreignExtraction.extraction.extractionId
      await assert.rejects(
        module.runSingle({
          ...freshInput(project),
          extractionId: foreignExtractionId,
        }),
        rejectsWithCode('not_found'),
      )
      assert.equal(adapters.calls.length, 1)
      await assert.rejects(
        module.prepareReview(foreignExtractionId),
        rejectsWithCode('not_found'),
      )
      await assert.rejects(
        module.finalizeReview(foreignExtractionId, []),
        rejectsWithCode('not_found'),
      )
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
        await db.orm.public.Extraction.select('reviewedAt').first({
          id: foreignExtractionId,
        })
      assert.equal(unchanged?.reviewedAt, null)
    })

    it('persists Article failures as terminal snapshots', async (t) => {
      t.after(cleanup)
      const article = await seedProject()
      const failing = createRuntime(
        article.researcherAccountId,
        deterministicAdapters({ failArticle: true }),
      ).module
      const failed = await failing.runSingle(freshInput(article))
      assert.equal(failed.extraction.outcome, 'FAILED')
      assert.equal(failed.extraction.complete, null)
      assert.equal(failed.extraction.result, null)
      assert.equal(failed.extraction.failure?.code, 'extraction_failed')

    })

    it('bounds the cancellation race and persists one durable CANCELLED terminal', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const modelStarted = Promise.withResolvers<void>()
      const model: ExtractionModel = {
        extract(request) {
          modelStarted.resolve()
          const pending = Promise.withResolvers<never>()
          const abort = () =>
            pending.reject(new DOMException('Aborted', 'AbortError'))
          request.signal.addEventListener('abort', abort, { once: true })
          if (request.signal.aborted) abort()
          return pending.promise
        },
      }
      const adapters = deterministicAdapters()
      const runtime = createExtractionRuntimeWithInfrastructure(
        {
          models: {
            async open() {
              return {
                attribution,
                model,
                groundingModel: adapters.groundingModel,
              }
            },
          },
        },
        { database: db, packages },
      )
      runtimes.add(runtime)
      const module = runtime.forResearcher(project.researcherAccountId)
      const input = freshInput(project)
      const running = module.runSingle(input)
      await modelStarted.promise

      assert.equal(
        await module.cancelSingle(input.extractionId),
        'cancellation-requested',
      )
      const terminal = await running
      assert.equal(terminal.extraction.outcome, 'CANCELLED')
      assert.equal(terminal.extraction.failure?.code, 'cancelled')
      assert.equal(
        await module.cancelSingle(input.extractionId),
        'already-terminal',
      )
      assert.equal(await module.cancelSingle(randomUUID()), 'not-found')
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
          evidenceAnchorId: 'anchor-alpha',
          reviewedOccurrenceIds: ['occurrence-alpha'],
          action: 'APPROVED',
          reviewedValue: null,
        },
      ])
      await assert.rejects(
        module.finalizeReview(extractionId, [
          {
            resultPath: ['records', 0, 'title'],
            evidenceAnchorId: 'anchor-alpha',
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
            evidenceAnchorId: 'anchor-alpha',
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
      const adapters = deterministicAdapters()
      adapters.model = {
        async extract() {
          return {
            result: { records: [{ title: 'Alpha', note: 'Beta' }] },
            metadata,
            attribution,
          }
        },
      }
      adapters.groundingModel = {
        async ground(request) {
          const [firstClaim, secondClaim] = Object.keys(request.claims)
          const firstAnchor = Object.keys(request.anchors)[0] ?? null
          return {
            selections: [
              { claimLabel: firstClaim!, anchorLabel: firstAnchor },
              { claimLabel: secondClaim!, anchorLabel: null },
            ],
            metadata,
            attribution,
          }
        },
      }
      const { module } = createRuntime(project.researcherAccountId, adapters)
      const completed = await module.runSingle(freshInput(project))
      assert.equal(completed.extraction.outcome, 'SUCCEEDED')
      assert.equal(completed.extraction.complete, false)
      assert.equal(completed.extraction.reviewable, true)
      assert.equal(completed.extraction.evidence?.length, 1)
      assert.equal(completed.extraction.diagnostics.ungroundedPaths.length, 1)

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
      const adapters = deterministicAdapters()
      adapters.model = {
        async extract() {
          return {
            result: { records: [{ title: 'Alpha', note: 'Alpha' }] },
            metadata,
            attribution,
          }
        },
      }
      adapters.groundingModel = {
        async ground(request) {
          const anchorLabel = Object.keys(request.anchors)[0]!
          return {
            selections: Object.keys(request.claims).map((claimLabel) => ({
              claimLabel,
              anchorLabel,
            })),
            metadata,
            attribution,
          }
        },
      }
      const { module } = createRuntime(project.researcherAccountId, adapters)
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
    })

    it('does not invent a terminal Extraction when its canonical package is unavailable', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      await packages.remove(document.storedPackage, async () => false)
      const input = freshInput(project)

      await assert.rejects(module.runSingle(input))
      assert.equal(await module.cancelSingle(input.extractionId), 'not-found')
    })

    it('rejects duplicate members, atomically pins valid members, replays equal selections, and creates explicit repetitions', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['b.pdf', 'a.pdf'])
      const foreign = await seedProject()
      const { runtime, module } = createRuntime(
        project.researcherAccountId,
      )
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
      const foreignModule = runtime.forResearcher(
        foreign.researcherAccountId,
      )
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
      const completedForeign = await runWorkerUntil(
        runtime,
        foreignModule,
        foreign.projectContextId,
        foreignBatch.batch.batchExtractionId,
        (batch) => batch.executionStatus === 'COMPLETED',
      )
      assert.equal(completedForeign.executionStatus, 'COMPLETED')
    })

    it('atomically hands a ready Schema Suggestion to one replayable Batch', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const { module } = createRuntime(project.researcherAccountId)
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
        executionStatus: 'COMPLETED',
        phase: 'READY',
        draft: ARTICLE_SCHEMA,
        draftVersion: 1,
        finishedAt: new Date(),
      })

      const request = {
        projectContextId: project.projectContextId,
        batchSchemaSuggestionId,
        strategy: 'ARTICLE' as const,
      }
      const handoffs = await Promise.all([
        module.scheduleSuggestedBatch(request),
        module.scheduleSuggestedBatch(request),
      ])
      assert.deepEqual(
        handoffs.map((handoff) => handoff.disposition).sort(),
        ['created', 'replayed'],
      )
      assert.equal(
        handoffs[0]!.batch.batchExtractionId,
        handoffs[1]!.batch.batchExtractionId,
      )
      assert.deepEqual(
        handoffs[0]!.batch.members.map((member) => ({
          sourceDocumentId: member.sourceDocumentId,
          sourceRepresentationRevisionId:
            member.sourceRepresentationRevisionId,
        })),
        project.documents
          .map((document) => ({
            sourceDocumentId: document.sourceDocumentId,
            sourceRepresentationRevisionId:
              document.sourceRepresentationRevisionId,
          }))
          .sort((left, right) =>
            left.sourceDocumentId.localeCompare(right.sourceDocumentId),
          ),
      )
      const persisted = await db.orm.public.BatchSchemaSuggestion.select(
        'confirmedSchemaRevisionId',
        'batchExtractionId',
      ).first({ id: batchSchemaSuggestionId })
      assert.ok(persisted?.confirmedSchemaRevisionId)
      assert.equal(
        persisted.batchExtractionId,
        handoffs[0]!.batch.batchExtractionId,
      )
      assert.equal(
        handoffs[0]!.batch.schemaRevisionId,
        persisted.confirmedSchemaRevisionId,
      )
    })

    it('rejects invalid stored suggestion drafts inside the atomic batch transaction', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf'])
      const { module } = createRuntime(project.researcherAccountId)
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
          executionStatus: 'COMPLETED',
          phase: 'READY',
          draft,
          draftVersion: 1,
          finishedAt: new Date(),
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
    })

    it('retries one durable suggestion while preserving successful source checkpoints', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const store = createResearcherProjectStore(
        project.researcherAccountId,
        db,
      )
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
      const completedAt = new Date('2026-08-24T10:00:00.000Z')
      await db.orm.public.BatchSchemaSuggestionSource.where({
        batchSchemaSuggestionId,
        sourceDocumentId: project.documents[0]!.sourceDocumentId,
      }).update({
        executionStatus: 'COMPLETED',
        definition: ARTICLE_SCHEMA,
        startedAt: completedAt,
        finishedAt: completedAt,
      })
      await db.orm.public.BatchSchemaSuggestionSource.where({
        batchSchemaSuggestionId,
        sourceDocumentId: project.documents[1]!.sourceDocumentId,
      }).update({
        executionStatus: 'FAILED',
        failure: {
          code: 'invalid_model_output',
          message: 'Sanitized durable failure.',
        },
        startedAt: completedAt,
        finishedAt: completedAt,
      })
      await db.orm.public.BatchSchemaSuggestion.where({
        id: batchSchemaSuggestionId,
      }).update({
        executionStatus: 'FAILED',
        phase: 'SOURCES',
        failure: {
          code: 'source_suggestion_failed',
          message: 'One source failed.',
        },
        startedAt: completedAt,
        finishedAt: completedAt,
      })

      const retried = await store.retryBatchSchemaSuggestion(
        project.projectContextId,
        batchSchemaSuggestionId,
      )
      assert.equal(retried?.suggestion.batchSchemaSuggestionId, batchSchemaSuggestionId)
      assert.equal(retried?.suggestion.executionStatus, 'QUEUED')
      const successful = retried?.suggestion.sources.find(
        (source) =>
          source.sourceDocumentId === project.documents[0]!.sourceDocumentId,
      )
      const failed = retried?.suggestion.sources.find(
        (source) =>
          source.sourceDocumentId === project.documents[1]!.sourceDocumentId,
      )
      assert.equal(successful?.executionStatus, 'COMPLETED')
      assert.deepEqual(successful?.definition, ARTICLE_SCHEMA)
      assert.equal(successful?.finishedAt?.toISOString(), completedAt.toISOString())
      assert.equal(failed?.executionStatus, 'QUEUED')
      assert.equal(failed?.failure, null)
      assert.equal(failed?.startedAt, null)
      assert.equal(failed?.finishedAt, null)
      assert.equal(
        (
          await db.orm.public.BatchSchemaSuggestion.where({
            projectContextId: project.projectContextId,
          })
            .select('id')
            .all()
        ).length,
        1,
      )
    })
  })

  after(async () => {
    await cleanup()
    await db.close()
    await rm(packageRoot, { recursive: true, force: true })
  })
}
