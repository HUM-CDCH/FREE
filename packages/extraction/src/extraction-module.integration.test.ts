import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import type { CanonicalPackageStore, Database } from 'db'
import { validateDisposableTestDatabaseTarget } from 'db/database-url'
import { withHeldSourceDocumentLock } from 'db/postgres-test-helpers'
import { withBlockedUpdates } from '../../db/src/postgres-test-helpers.js'
import type { KeiExpClient, KeiExpRequest, KeiExpArtifact } from './kei-exp.js'
import { keiExpArtifact, keiExpEvidence, keiExpGroundedArtifact } from './kei-exp-fixture.js'
import { ExtractionError } from './errors.js'
import type {
  BatchExtractionSnapshot,
  ExtractionModule,
  ExtractionRuntime,
} from './types.js'

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
    { db },
    { createCanonicalPackageStore },
    { createResearcherProjectStore },
    { createExtractionRuntimeWithInfrastructure },
    { createInternalExtractionJobStore },
  ] =
    await Promise.all([
      import('../../db/src/prisma/db.js'),
      import('../../db/src/artifact-store.js'),
      import('../../db/src/project-store.js'),
      import('./runtime.js'),
      import('./postgres-persistence.js'),
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

  type DeterministicAdapters = { client: Pick<KeiExpClient, 'extract'>; calls: KeiExpRequest[] }
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

  function deterministicAdapters(options: { failArticle?: boolean } = {}): DeterministicAdapters {
    const calls: KeiExpRequest[] = []
    return {
      calls,
      client: {
        async extract(request) {
          calls.push(request)
          request.signal.throwIfAborted()
          if (options.failArticle) throw new Error('controlled extraction failure')
          return keiExpArtifact({
            run_id: request.runId, strategy: request.strategy, model: 'deterministic', schema: request.schema,
            options: { strategy: request.strategy, model: 'deterministic' }, started: new Date().toISOString(), seconds: 0.001,
            complete: true, records: [{ title: 'Alpha', ...(request.schema.schemaNodes.some(node => node.name === 'filename') ? { filename: 'article.pdf' } : {}) }],
            evidence: [keiExpEvidence({ bbox_pt: [10, 10, 100, 30], linked_by: 'model' })],
          })
        },
      },
    }
  }

  function createRuntime(
    researcherAccountId: string,
    adapters: DeterministicAdapters = deterministicAdapters(),
  ) {
    const runtime = createExtractionRuntimeWithInfrastructure(
      {
        keiExp: { extract: request => adapters.client.extract(request) },
      },
      { database: db as Database, packages },
    )
    runtimes.add(runtime)
    const scheduledModule = runtime.forResearcher(researcherAccountId)
    const module: ExtractionModule = {
      ...scheduledModule,
      async runSingle(input) {
        const scheduled = await scheduledModule.runSingle(input)
        if (scheduled.extraction.executionStatus === 'COMPLETED' ||
            scheduled.extraction.executionStatus === 'FAILED') return scheduled
        const controller = new AbortController()
        const running = runtime.run(controller.signal)
        try {
          const deadline = Date.now() + 5_000
          for (;;) {
            const extraction = await scheduledModule.readExtractionAttempt(
              input.extractionId,
            )
            if (extraction &&
                (extraction.executionStatus === 'COMPLETED' ||
                 extraction.executionStatus === 'FAILED'))
              return { disposition: scheduled.disposition, extraction }
            if (Date.now() >= deadline)
              throw new Error(`Timed out waiting for Extraction ${input.extractionId}.`)
            const turn = Promise.withResolvers<void>()
            setImmediate(turn.resolve)
            await turn.promise
          }
        } finally {
          controller.abort()
          await running
        }
      },
    }
    return {
      runtime,
      module,
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
      await assert.rejects(module.readReviewDraft(foreignExtractionId), rejectsWithCode('not_found'))
      await assert.rejects(module.saveReviewDraft(foreignExtractionId, { version: 0, decisions: [] }), rejectsWithCode('not_found'))
      await assert.rejects(module.resetReview(foreignExtractionId, 0), rejectsWithCode('not_found'))
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
        ingestionKey: randomUUID(), expectedRepresentationId: document.sourceRepresentationRevisionId,
        requestFingerprint: 'f'.repeat(64), contentSha256: sha256(strToU8(document.filename)),
        mediaType: 'application/pdf', originalName: document.filename, ...document.storedPackage,
        contractVersion: 'parsed_document.v2', preprocessId: 'reprocessed', parserName: 'test', parserVersion: '5',
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

    it('refuses a new Extraction on a superseded Source Representation Revision and writes no job', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      await addRepresentation(document, 'article-v2.pdf')
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      await assert.rejects(module.runSingle(input), rejectsWithCode('source_representation_superseded'))
      assert.equal(await db.orm.public.ExtractionJob.select('id').first({ id: input.extractionId }), null)
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

    it('keeps a run admitted before a reprocess as a historical attempt', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      await addRepresentation(document, 'article-v2.pdf')
      const historical = await module.readDocumentExtractions({ sourceDocumentId: document.sourceDocumentId, extractionId: completed.extraction.extractionId })
      assert.equal(historical?.latestAttempt?.sourceRepresentationRevisionId, document.sourceRepresentationRevisionId)
    })

    it('refuses a run that was admitted while a reprocess published a newer revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      await assert.rejects(
        withHeldSourceDocumentLock(
          process.env.EXTRACTION_TEST_DATABASE_URL!,
          document.sourceDocumentId,
          () => module.runSingle(input),
          async (run) => {
            await run(
              `INSERT INTO "sourceRepresentationRevision"
                 (id, "sourceDocumentId", "revisionNumber", "artifactReference", "artifactSha256",
                  "contractVersion", "preprocessId", "parserName", "parserVersion")
               VALUES ($1, $2, 2, $3, $3, 'parsed_document.v2', $4, 'test', '1')`,
              [randomUUID(), document.sourceDocumentId, 'c'.repeat(64), `race-${randomUUID()}`],
            )
          },
        ),
        rejectsWithCode('source_representation_superseded'),
      )
      assert.equal(await db.orm.public.ExtractionJob.select('id').first({ id: input.extractionId }), null)
    })

    it('a batch admitted behind a reprocess pins the newly published revision', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const document = project.documents[0]!
      const { module } = createRuntime(project.researcherAccountId)
      const revisionTwo = randomUUID()
      const scheduled = await withHeldSourceDocumentLock(
        process.env.EXTRACTION_TEST_DATABASE_URL!,
        document.sourceDocumentId,
        () => module.scheduleBatch({
          projectContextId: project.projectContextId,
          schemaRevisionId: project.schemaRevisionId,
          sourceDocumentIds: [document.sourceDocumentId],
          strategy: 'ARTICLE',
          repetition: 'create-new',
        }),
        async (run) => {
          await run(
            `INSERT INTO "sourceRepresentationRevision"
               (id, "sourceDocumentId", "revisionNumber", "artifactReference", "artifactSha256",
                "contractVersion", "preprocessId", "parserName", "parserVersion")
             VALUES ($1, $2, 2, $3, $3, 'parsed_document.v2', $4, 'test', '1')`,
            [revisionTwo, document.sourceDocumentId, 'c'.repeat(64), `race-${randomUUID()}`],
          )
        },
      )
      assert.ok(scheduled)
      assert.equal(scheduled.batch.members[0]?.sourceRepresentationRevisionId, revisionTwo)
    })

    it('a batch and a reprocess of one of its members both finish', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const [one, two] = project.documents as [SeededDocument, SeededDocument]
      const { module } = createRuntime(project.researcherAccountId)
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
          ingestionKey: randomUUID(), expectedRepresentationId: two.sourceRepresentationRevisionId,
          requestFingerprint: 'f'.repeat(64), contentSha256: sha256(strToU8(two.filename)),
          mediaType: 'application/pdf', originalName: two.filename, ...two.storedPackage,
          contractVersion: 'parsed_document.v2', preprocessId: 'reprocessed', parserName: 'test', parserVersion: '5',
          ensureRetained: async () => {},
        }),
      ])
      assert.ok(scheduled)
      assert.ok(revised)
    })

    it('conceals a foreign document behind the same missing answer', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const foreign = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      await assert.rejects(
        module.runSingle({ ...freshInput(project), sourceRepresentationRevisionId: foreign.documents[0]!.sourceRepresentationRevisionId }),
        rejectsWithCode('not_found'),
      )
    })

    it('persists and reopens a partial remote Catalog result without local stage diagnostics', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const adapters = deterministicAdapters()
      const extract = adapters.client.extract
      adapters.client.extract = async request => ({ ...await extract(request), complete: false })
      const { module } = createRuntime(project.researcherAccountId, adapters)
      const input = { ...freshInput(project), strategy: 'CATALOG' as const }
      const created = await module.runSingle(input)
      assert.equal(created.extraction.complete, false)
      assert.equal(created.extraction.outcome, 'SUCCEEDED')
      assert.equal(created.extraction.diagnostics!.catalog, null)
      assert.equal((await module.runSingle(input)).disposition, 'replayed')
      assert.equal(adapters.calls.length, 1)
      const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
      assert.deepEqual(reopened?.latestAttempt?.result, created.extraction.result)
      const prepared = await module.prepareReview(input.extractionId)
      assert.equal((await module.finalizeReview(input.extractionId, prepared.reviewDecisions)).disposition, 'reviewed')
    })

    it('persists and reopens a version 2 recipe result with its span evidence and review material', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const adapters = deterministicAdapters()
      adapters.client.extract = async request => (adapters.calls.push(request), keiExpGroundedArtifact({
        run_id: request.runId, schema: request.schema, model: 'deterministic',
        records: [{ title: 'Alpha' }], record_blocks: [{ block: 'b1', entry_label: '1' }],
        evidence: [{ path: ['records', 0, 'title'], segment: 'p1_s0', page: 1, bbox_pt: [10, 10, 100, 30],
                     verbatim: true, hits: 1, linked_by: 'key', spans: [{ segment: 'p1_s0', start: 0, end: 5 }],
                     alternatives: [], provenance: 'token', key_spans: [], heading: null, precision: 'segment',
                     raw: 'Alpha', normalized: { value: 'Alphabet', rule: 'glossary',
                                                 key_span: { segment: 'p1_s0', start: 0, end: 5 },
                                                 expansion_span: { segment: 'p1_s0', start: 8, end: 16 } } }],
      }))
      const { module } = createRuntime(project.researcherAccountId, adapters)
      const input = { ...freshInput(project), strategy: 'CATALOG' as const, catalogRecipe: 'numbered-catalogue-de@1' }
      const created = await module.runSingle(input)
      assert.equal(adapters.calls[0]?.catalogRecipe, 'numbered-catalogue-de@1')
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

    it('retains Article failures on jobs without creating Extractions', async (t) => {
      t.after(cleanup)
      const article = await seedProject()
      const failing = createRuntime(
        article.researcherAccountId,
        deterministicAdapters({ failArticle: true }),
      ).module
      const failed = await failing.runSingle(freshInput(article))
      assert.equal(failed.extraction.executionStatus, 'FAILED')
      assert.equal(failed.extraction.outcome, null)
      assert.equal(failed.extraction.complete, null)
      assert.equal(failed.extraction.result, null)
      assert.equal(failed.extraction.failure?.code, 'extraction_failed')
      assert.equal(await db.orm.public.Extraction.select('id').first({
        id: failed.extraction.extractionId,
      }), null)
    })

    it('bounds the cancellation race without creating a terminal Extraction', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const modelStarted = Promise.withResolvers<void>()
      const client: Pick<KeiExpClient, 'extract'> = {
        extract(request) {
          modelStarted.resolve()
          const pending = Promise.withResolvers<KeiExpArtifact>()
          const abort = () => pending.reject(new DOMException('Aborted', 'AbortError'))
          request.signal.addEventListener('abort', abort, { once: true })
          if (request.signal.aborted) abort()
          return pending.promise
        },
      }
      const runtime = createExtractionRuntimeWithInfrastructure(
        { keiExp: client },
        { database: db, packages },
      )
      runtimes.add(runtime)
      const module = runtime.forResearcher(project.researcherAccountId)
      const input = freshInput(project)
      const scheduled = await module.runSingle(input)
      const controller = new AbortController()
      const running = runtime.run(controller.signal)
      await modelStarted.promise

      assert.equal(
        await module.cancelSingle(input.extractionId),
        'cancellation-requested',
      )
      let terminal = scheduled.extraction
      const deadline = Date.now() + 5_000
      while (terminal.executionStatus !== 'FAILED') {
        if (Date.now() >= deadline)
          throw new Error(`Timed out waiting for cancelled Extraction ${input.extractionId}.`)
        const current = await module.readExtractionAttempt(input.extractionId)
        if (!current) throw new Error('Cancelled Extraction Job disappeared.')
        terminal = current
        const turn = Promise.withResolvers<void>()
        setImmediate(turn.resolve)
        await turn.promise
      }
      controller.abort()
      await running
      assert.equal(terminal.outcome, null)
      assert.equal(terminal.failure?.code, 'cancelled')
      assert.equal(
        await module.cancelSingle(input.extractionId),
        'not-found',
      )
      assert.equal(await module.cancelSingle(randomUUID()), 'not-found')
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
      const { runtime, module } = createRuntime(project.researcherAccountId)
      const scheduled = await module.scheduleBatch({
        projectContextId: project.projectContextId, schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE', sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
        repetition: 'create-new',
      })
      const batch = await runWorkerUntil(runtime, module, project.projectContextId, scheduled.batch.batchExtractionId,
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
      const adapters = deterministicAdapters()
      const extract = adapters.client.extract
      adapters.client.extract = async request => ({
        ...await extract(request), complete: false,
        records: [{ title: 'Alpha', note: 'Beta' }],
        ungrounded: [['records', 0, 'note']],
      })
      const { module } = createRuntime(project.researcherAccountId, adapters)
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
      const adapters = deterministicAdapters()
      const extract = adapters.client.extract
      adapters.client.extract = async request => {
        const artifact = await extract(request)
        if (artifact.extraction_version !== 1) throw new Error('the deterministic adapter answers version 1')
        return { ...artifact, records: [{ title: 'Alpha', note: 'Alpha' }], evidence: [
          ...artifact.evidence, { ...artifact.evidence[0]!, path: ['records', 0, 'note'] },
        ] }
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
      const historical = await module.readDocumentExtractions({
        sourceDocumentId: document.sourceDocumentId,
        extractionId: reviewedAttempt.extraction.extractionId,
      })
      assert.equal(
        historical?.sourceRepresentationRevisionId,
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

      const failed = await module.runSingle(input)
      assert.equal(failed.extraction.executionStatus, 'FAILED')
      assert.equal(failed.extraction.outcome, null)
      assert.equal(await db.orm.public.Extraction.select('id').first({
        id: input.extractionId,
      }), null)
      assert.equal(await module.cancelSingle(input.extractionId), 'not-found')
    })

    it('claims interactive jobs first and FIFO within that kind', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['first.pdf', 'second.pdf'])
      const { runtime, module } = createRuntime(project.researcherAccountId)
      await module.scheduleBatch({
        projectContextId: project.projectContextId,
        schemaRevisionId: project.schemaRevisionId,
        strategy: 'ARTICLE',
        sourceDocumentIds: project.documents.map((document) => document.sourceDocumentId),
        repetition: 'create-new',
        models: { fields: 'nuextract', reasoning: 'instruct' },
      })
      const scheduler = runtime.forResearcher(project.researcherAccountId)
      const firstId = randomUUID()
      const secondId = randomUUID()
      await scheduler.runSingle(freshInput(project, firstId))
      await scheduler.runSingle(freshInput(project, secondId))
      await db.orm.public.ExtractionJob.where({ id: firstId }).update({
        createdAt: new Date('2026-08-31T10:00:00.000Z'),
      })
      await db.orm.public.ExtractionJob.where({ id: secondId }).update({
        createdAt: new Date('2026-08-31T10:00:01.000Z'),
      })

      const store = createInternalExtractionJobStore(db, packages)
      const owner = randomUUID()
      const now = new Date('2026-08-31T10:01:00.000Z')
      const expiresAt = new Date('2026-08-31T10:03:00.000Z')
      const failure = { code: 'test_cleanup', message: 'Test cleanup.', phase: 'loading' as const }
      const first = await store.claim(owner, now, expiresAt)
      assert.equal(first?.input.extractionId, firstId)
      assert.ok(first)
      await store.fail(first.input.extractionId, first.lease, failure, now)
      const second = await store.claim(owner, now, expiresAt)
      assert.equal(second?.input.extractionId, secondId)
      assert.ok(second)
      await store.fail(second.input.extractionId, second.lease, failure, now)
      const batchMember = await store.claim(owner, now, expiresAt)
      assert.ok(batchMember?.input.kind === 'batch-member')
      assert.deepEqual(batchMember.input.models, { fields: 'nuextract', reasoning: 'instruct' })
    })

    it('stores the Catalog recipe chosen for an Extraction on its job and hands it to the worker', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const scheduler = createRuntime(project.researcherAccountId).runtime.forResearcher(project.researcherAccountId)
      const extractionId = randomUUID()
      const input = { ...freshInput(project, extractionId), strategy: 'CATALOG' as const,
                      catalogRecipe: 'numbered-catalogue-de@1' }
      await scheduler.runSingle(input)
      assert.equal((await scheduler.runSingle(input)).disposition, 'replayed')
      await assert.rejects(scheduler.runSingle({ ...input, catalogRecipe: null }),
        (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_id_conflict')
      const row = await db.orm.public.ExtractionJob.select('catalogRecipe').first({ id: extractionId })
      assert.equal(row?.catalogRecipe, 'numbered-catalogue-de@1')
      const store = createInternalExtractionJobStore(db, packages)
      const claimed = await store.claim(randomUUID(), new Date(), new Date(Date.now() + 60_000))
      assert.ok(claimed && claimed.input.kind === 'fresh')
      assert.equal(claimed.input.catalogRecipe, 'numbered-catalogue-de@1')
      assert.equal(claimed.input.models, null)
      await store.fail(claimed.input.extractionId, claimed.lease,
        { code: 'test_cleanup', message: 'Test cleanup.', phase: 'loading' }, new Date())
    })

    it('keeps the Extraction Model Choice on its job and Extraction, relays it, and records the model each role ran on', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const adapters = deterministicAdapters()
      const extract = adapters.client.extract
      adapters.client.extract = async request => ({
        ...await extract(request), models: { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' },
      })
      const { module, runtime } = createRuntime(project.researcherAccountId, adapters)
      const models = { fields: 'nuextract', reasoning: 'instruct' }
      const input = { ...freshInput(project), models }
      const queued = await runtime.forResearcher(project.researcherAccountId).runSingle(input)
      assert.deepEqual(queued.extraction.requestedModels, models)
      // A replay must ask for the same models: another choice under the same id is another Extraction.
      for (const other of [null, {}, { fields: 'nuextract' }, { fields: 'instruct', reasoning: 'instruct' }])
        await assert.rejects(module.runSingle({ ...input, models: other }),
          (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_id_conflict')
      const created = await module.runSingle({ ...input, models: { reasoning: 'instruct', fields: 'nuextract' } })
      assert.equal(created.disposition, 'replayed')
      assert.equal(created.extraction.outcome, 'SUCCEEDED')
      assert.deepEqual(adapters.calls.map(call => call.models), [models])
      assert.deepEqual(created.extraction.requestedModels, models)
      assert.deepEqual(created.extraction.diagnostics?.models,
        { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' })
      assert.deepEqual(created.extraction.modelAttribution, { provider: 'kei-exp', modelId: 'deterministic' })
      const job = await db.orm.public.ExtractionJob.select('requestedModels').first({ id: input.extractionId })
      const extraction = await db.orm.public.Extraction.select('requestedModels').first({ id: input.extractionId })
      assert.deepEqual(job?.requestedModels, models)
      assert.deepEqual(extraction?.requestedModels, models)
      const reopened = await module.readDocumentExtractions({ sourceDocumentId: project.documents[0]!.sourceDocumentId })
      assert.deepEqual(reopened?.latestAttempt?.requestedModels, models)
    })

    it('refuses to replay a legacy job whose retryOfId still pins it as a retry', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      // A first Extraction, completed normally: its job row is the retry pin's FK target.
      const first = await module.runSingle(freshInput(project))
      assert.equal(first.extraction.executionStatus, 'COMPLETED')
      // A second job under its own id, then planted with a retryOfId the way a pre-migration
      // row would carry one: no code path creates this shape any more.
      const legacyId = randomUUID()
      await module.runSingle(freshInput(project, legacyId))
      const planted = await db.orm.public.ExtractionJob.where({ id: legacyId }).updateAll({
        retryOfId: first.extraction.extractionId,
      })
      assert.equal(planted.length, 1)
      await assert.rejects(
        module.runSingle(freshInput(project, legacyId)),
        rejectsWithCode('extraction_id_conflict'),
      )
    })

    it('reads a job holding legacy checkpoint columns as having no values yet', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const input = freshInput(project)
      await module.runSingle(input)
      // Legacy-row fixture: rows written before e88b08f could hold checkpointed values on RUNNING or FAILED
      // jobs; nothing writes them any more.
      await db.orm.public.ExtractionJob.where({ id: input.extractionId }).updateAll({
        executionStatus: 'RUNNING',
        complete: true,
        modelAttribution: { provider: 'kei-exp', modelId: 'legacy' },
        diagnostics: { phase: 'grounding' },
        resultPayload: { records: [{ place: 'Rome' }] },
      })
      const attempt = await module.readExtractionAttempt(input.extractionId)
      assert.equal(attempt?.executionStatus, 'RUNNING')
      assert.equal(attempt?.result, null)
      assert.equal(attempt?.complete, null)
      assert.equal(attempt?.modelAttribution, null)
      assert.equal(attempt?.diagnostics, null)

      const failedInput = freshInput(project)
      await module.runSingle(failedInput)
      // Legacy-row fixture: a FAILED job can hold the same stale checkpoint values, plus a failure in the
      // shape `fail()` still writes today (code/message/phase); the checkpoint columns must still read null.
      const failure = { code: 'legacy_failure', message: 'Legacy job failure.', phase: 'grounding' as const }
      await db.orm.public.ExtractionJob.where({ id: failedInput.extractionId }).updateAll({
        executionStatus: 'FAILED',
        complete: true,
        modelAttribution: { provider: 'kei-exp', modelId: 'legacy' },
        diagnostics: { phase: 'grounding' },
        resultPayload: { records: [{ place: 'Rome' }] },
        failure,
      })
      const failedAttempt = await module.readExtractionAttempt(failedInput.extractionId)
      assert.equal(failedAttempt?.executionStatus, 'FAILED')
      assert.equal(failedAttempt?.result, null)
      assert.equal(failedAttempt?.complete, null)
      assert.equal(failedAttempt?.modelAttribution, null)
      assert.equal(failedAttempt?.diagnostics, null)
      assert.deepEqual(failedAttempt?.failure, failure)
    })

    it('stores batch model choices on every job and completed Extraction and includes them in selection identity', async (t) => {
      t.after(cleanup)
      const project = await seedProject(ARTICLE_SCHEMA, ['one.pdf', 'two.pdf'])
      const { module, runtime, adapters } = createRuntime(project.researcherAccountId)
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
        const jobs = await db.orm.public.ExtractionJob.where({ batchExtractionId })
          .select('requestedModels').all()
        assert.equal(jobs.length, project.documents.length)
        for (const job of jobs) assert.deepEqual(job.requestedModels, models)
        await runWorkerUntil(runtime, module, project.projectContextId,
          batchExtractionId, batch => batch.executionStatus === 'COMPLETED')
        const extractions = await db.orm.public.Extraction.where({ batchExtractionId })
          .select('requestedModels').all()
        assert.equal(extractions.length, project.documents.length)
        for (const extraction of extractions) assert.deepEqual(extraction.requestedModels, models)
        assert.deepEqual(adapters.calls.slice(-project.documents.length).map(call => call.models),
          project.documents.map(() => models))
      }
    })

    it('stores no Extraction Model Choice when every role keeps kei-exp\'s defaults', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module, adapters } = createRuntime(project.researcherAccountId)
      for (const models of [undefined, null, {}]) {
        const input = { ...freshInput(project), models }
        const created = await module.runSingle(input)
        assert.equal(created.extraction.requestedModels, null)
        // No choice and an empty choice are the same request.
        assert.equal((await module.runSingle({ ...input, models: {} })).disposition, 'replayed')
        const row = await db.orm.public.Extraction.select('requestedModels').first({ id: input.extractionId })
        assert.equal(row?.requestedModels, null)
      }
      assert.deepEqual(adapters.calls.map(call => call.models ?? null), [null, null, null])
    })

    it('claims a queued job only once when workers compete', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const scheduler = createRuntime(project.researcherAccountId).runtime
        .forResearcher(project.researcherAccountId)
      const extractionId = randomUUID()
      await scheduler.runSingle(freshInput(project, extractionId))
      const store = createInternalExtractionJobStore(db, packages)
      const now = new Date('2026-08-31T10:00:00.000Z')
      const expiresAt = new Date('2026-08-31T10:03:00.000Z')
      const claims = await withBlockedUpdates(disposableDatabaseUrl, 'ExtractionJob', extractionId, 2,
        () => Promise.all([
          store.claim(randomUUID(), now, expiresAt),
          store.claim(randomUUID(), now, expiresAt),
        ]))
      assert.equal(claims.filter((claim) => claim !== null).length, 1)
    })

    it('honors cancellation when it races a worker failure', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const scheduler = createRuntime(project.researcherAccountId).runtime
        .forResearcher(project.researcherAccountId)
      const extractionId = randomUUID()
      await scheduler.runSingle(freshInput(project, extractionId))
      const store = createInternalExtractionJobStore(db, packages)
      const now = new Date('2026-08-31T10:00:00.000Z')
      const claimed = await store.claim(randomUUID(), now, new Date(now.getTime() + 60_000))
      assert.ok(claimed)
      const [cancellation, failed] = await withBlockedUpdates(
        disposableDatabaseUrl, 'ExtractionJob', extractionId, 2,
        () => Promise.all([
          scheduler.cancelSingle(extractionId),
          store.fail(extractionId, claimed.lease, {
            code: 'extraction_failed', message: 'Model failed.', phase: 'extracting',
          }, now),
        ]))
      assert.equal(failed, true)
      const job = await db.orm.public.ExtractionJob.select('failure', 'executionStatus')
        .first({ id: extractionId })
      assert.equal(job?.executionStatus, 'FAILED')
      assert.equal((job?.failure as { code: string }).code,
        cancellation === 'cancellation-requested' ? 'cancelled' : 'extraction_failed')
    })

    it('does not reclaim a renewed lease and lets committed cancellation win failure', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const scheduler = createRuntime(project.researcherAccountId).runtime
        .forResearcher(project.researcherAccountId)
      const store = createInternalExtractionJobStore(db, packages)
      const extractionId = randomUUID()
      await scheduler.runSingle(freshInput(project, extractionId))
      const owner = randomUUID()
      const claimed = await store.claim(
        owner,
        new Date('2026-08-31T10:00:00.000Z'),
        new Date('2026-08-31T10:01:00.000Z'),
      )
      assert.ok(claimed)
      assert.equal(await store.renew(
        extractionId,
        claimed.lease,
        new Date('2026-08-31T10:03:00.000Z'),
      ), 'owned')
      assert.equal(await store.claim(
        randomUUID(),
        new Date('2026-08-31T10:02:00.000Z'),
        new Date('2026-08-31T10:04:00.000Z'),
      ), null)

      assert.equal(
        await scheduler.cancelSingle(extractionId),
        'cancellation-requested',
      )
      assert.equal(await store.fail(extractionId, claimed.lease, {
        code: 'extraction_failed',
        message: 'Model failed.',
        phase: 'extracting',
      }, new Date('2026-08-31T10:02:30.000Z')), true)
      const failed = await db.orm.public.ExtractionJob.select('failure').first({
        id: extractionId,
      })
      assert.equal(
        (failed?.failure as { code?: unknown } | null)?.code,
        'cancelled',
      )
    })

    it('does not expose a terminal Extraction after its job identity is removed', async (t) => {
      t.after(cleanup)
      const project = await seedProject()
      const { module } = createRuntime(project.researcherAccountId)
      const completed = await module.runSingle(freshInput(project))
      await db.orm.public.ExtractionJob.where({
        id: completed.extraction.extractionId,
      }).delete()
      assert.equal(
        await module.readExtractionAttempt(completed.extraction.extractionId),
        null,
      )
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
      const jobs = await db.orm.public.ExtractionJob.where({
        batchExtractionId: handoffs[0]!.batch.batchExtractionId,
      }).select('requestedModels').all()
      assert.equal(jobs.length, project.documents.length)
      for (const job of jobs) assert.deepEqual(job.requestedModels, request.models)
      const store = createInternalExtractionJobStore(db, packages)
      for (const _document of project.documents) {
        const claimed = await store.claim(randomUUID(), new Date(), new Date(Date.now() + 60_000))
        assert.ok(claimed?.input.kind === 'batch-member')
        assert.equal(claimed.input.batchExtractionId, handoffs[0]!.batch.batchExtractionId)
        assert.deepEqual(claimed.input.models, request.models)
        await store.fail(claimed.input.extractionId, claimed.lease,
          { code: 'test_cleanup', message: 'Test cleanup.', phase: 'loading' }, new Date())
      }
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
