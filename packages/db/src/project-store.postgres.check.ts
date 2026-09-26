import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { validateDisposableTestDatabaseTarget } from './database-url.js'
import { withBlockedUpdates } from './postgres-test-helpers.js'

/**
 * The cascade is a PostgreSQL behaviour, so only PostgreSQL can prove it. This
 * check is deliberately outside the `src/*.test.ts` unit glob and never skips:
 * `pnpm --filter db test:postgres` fails loudly when it has no database, so a
 * green run always means the cascade actually ran.
 *
 * Give it a freshly created database every run. Ingestion keys are globally
 * unique and fixed here, and the check only cleans up when it passes, so
 * re-running against a database a previous failure dirtied reports
 * `IngestionKeyConflictError` instead of the original failure.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('PostgreSQL preserves Project Context ownership, concurrency, and cascades', async (t) => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_cascade.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  const [
    { db },
    {
      createInternalProjectWorkerStore,
      createResearcherProjectStore,
    },
  ] = await Promise.all([
    import('./prisma/db.js'),
    import('./project-store.js'),
  ])
  after(() => db.close())

  assert.deepEqual(await db.orm.public.ResearcherAccount.select('id').all(), [])
  assert.deepEqual(await db.orm.public.ProjectContext.select('id').all(), [])
  await assert.rejects(
    db.orm.public.ProjectContext.create({
      researcherAccountId: '52000000-0000-4000-8000-000000000099',
      name: 'Invalid owner',
    }),
  )

  const accountA = await db.orm.public.ResearcherAccount.create({
    tenantId: '52000000-0000-4000-8000-000000000001',
    objectId: '52000000-0000-4000-8000-000000000002',
    displayName: 'Restrict A',
  })
  const accountB = await db.orm.public.ResearcherAccount.create({
    tenantId: '52000000-0000-4000-8000-000000000001',
    objectId: '52000000-0000-4000-8000-000000000003',
    displayName: 'Restrict B',
  })
  const store = createResearcherProjectStore(accountA.id, db)
  const survivorStore = createResearcherProjectStore(accountB.id, db)
  const workerStore = createInternalProjectWorkerStore(db)
  const project = await store.createProjectContext('Doomed')
  const survivor = await survivorStore.createProjectContext('Survivor')
  await assert.rejects(
    db.orm.public.ResearcherAccount.where({ id: accountA.id }).delete(),
  )
  assert.ok(
    await db.orm.public.ProjectContext.select('id').first({
      id: project.projectContextId,
    }),
  )
  const ingestion = {
    ingestionKey: '51000000-0000-4000-9000-000000000001',
    contentSha256: 'a'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'doomed.pdf',
    artifactReference: 'c'.repeat(64),
    artifactSha256: 'c'.repeat(64),
    contractVersion: 'parsed_document.v2',
    preprocessId: `sha256:${'d'.repeat(64)}`,
    parserName: 'test',
    parserVersion: '1',
    ensureRetained: async () => {},
  }
  await assert.rejects(
    survivorStore.ingestSourceDocument(survivor.projectContextId, {
      ...ingestion,
      ingestionKey: '51000000-0000-4000-9000-000000000099',
      ensureRetained: async () => {
        throw new Error('package unavailable')
      },
    }),
    /package unavailable/,
  )
  assert.equal(
    await db.orm.public.SourceDocument.select('id').first({
      ingestionKey: '51000000-0000-4000-9000-000000000099',
    }),
    null,
  )
  const [ingested, concurrentReplay] = await Promise.all([
    store.ingestSourceDocument(project.projectContextId, ingestion),
    store.ingestSourceDocument(project.projectContextId, {
      ...ingestion,
      ingestionKey: '51000000-0000-4000-9000-000000000002',
      originalName: 'same-bytes-renamed.pdf',
    }),
  ])
  assert.ok(ingested)
  assert.deepEqual(concurrentReplay, ingested)
  assert.equal(ingested.revisionNumber, 1)
  assert.equal(
    (
      await db.orm.public.SourceDocument.where({
        projectContextId: project.projectContextId,
      }).all()
    ).length,
    1,
  )
  assert.equal(
    (
      await db.orm.public.SourceRepresentationRevision.where({
        sourceDocumentId: ingested.sourceDocumentId,
      }).all()
    ).length,
    1,
  )
  assert.deepEqual(
    await store.ingestSourceDocument(project.projectContextId, ingestion),
    ingested,
  )
  const sameNameDifferentContent = await store.ingestSourceDocument(
    project.projectContextId,
    {
      ...ingestion,
      ingestionKey: '51000000-0000-4000-9000-000000000003',
      contentSha256: 'b'.repeat(64),
      artifactReference: 'f'.repeat(64),
      artifactSha256: 'f'.repeat(64),
      originalName: ingested.name,
    },
  )
  assert.ok(sameNameDifferentContent)
  assert.notEqual(sameNameDifferentContent.sourceDocumentId, ingested.sourceDocumentId)
  const document = { id: ingested.sourceDocumentId }
  const representation = {
    id: ingested.sourceRepresentationId,
    artifactReference: ingestion.artifactReference,
    artifactSha256: ingestion.artifactSha256,
  }
  const survivingIngestion = await survivorStore.ingestSourceDocument(
    survivor.projectContextId,
    {
      ...ingestion,
      ingestionKey: '51000000-0000-4000-9000-000000000004',
      originalName: 'survivor.pdf',
    },
  )
  assert.ok(survivingIngestion)
  assert.notEqual(survivingIngestion.sourceDocumentId, document.id)
  assert.deepEqual(
    await store.getSourceRepresentation(
      project.projectContextId,
      survivingIngestion.sourceRepresentationId,
    ),
    null,
  )
  const survivingDocument = { id: survivingIngestion.sourceDocumentId }
  await db.orm.public.AnnotationSetRevision.create({
    sourceDocumentId: document.id,
    sourceRepresentationRevisionId: representation.id,
    revisionNumber: 1,
    snapshot: {},
  })
  const schema = await db.orm.public.ExtractionSchema.create({
    projectContextId: project.projectContextId,
    name: 'Schema',
  })
  await db.orm.public.SchemaRevision.create({
    extractionSchemaId: schema.id,
    revisionNumber: 1,
    origin: 'RESEARCHER_EDIT',
    schemaTree: [],
  })
  const appliedRevision = await db.orm.public.SchemaRevision.create({
    extractionSchemaId: schema.id,
    revisionNumber: 2,
    origin: 'MODEL_EDIT',
    schemaTree: [],
  })
  const extraction = await db.orm.public.Extraction.create({
    sourceDocumentId: document.id,
    schemaRevisionId: appliedRevision.id,
    sourceRepresentationRevisionId: representation.id,
    strategy: 'whole_document',
    outcome: 'SUCCEEDED',
    diagnostics: {},
    modelAttribution: {},
    resultPayload: {},
    reviewable: true,
  })
  const review = await db.orm.public.ExtractionReview.create({
    extractionId: extraction.id,
    revisionNumber: 1,
    decisionDigest: 'cascade-check',
  })
  await db.orm.public.ReviewDecision.create({
    extractionReviewId: review.id,
    resultPath: ['title'],
    resultPathKey: '["title"]',
    evidenceAnchorId: 'anchor-1',
    reviewedOccurrenceIds: [],
    action: 'approve',
  })
  const newerRepresentation =
    await db.orm.public.SourceRepresentationRevision.create({
      sourceDocumentId: document.id,
      revisionNumber: 2,
      artifactReference: 'e'.repeat(64),
      artifactSha256: 'e'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'e'.repeat(64)}`,
      parserName: 'test',
      parserVersion: '2',
    })

  const batchSuggestion = await db.orm.public.BatchSchemaSuggestion.create({
    projectContextId: project.projectContextId,
    selectionKey: 'atomic-suggestion-check',
    executionStatus: 'COMPLETED',
    phase: 'READY',
    draft: { name: 'original' },
    draftVersion: 1,
  })
  await db.orm.public.BatchSchemaSuggestionSource.create({
    batchSchemaSuggestionId: batchSuggestion.id,
    sourceDocumentId: document.id,
    sourceRepresentationRevisionId: newerRepresentation.id,
  })
  await t.test('simultaneous edits cannot overwrite the same draft revision', async () => {
    const results = await withBlockedUpdates(databaseUrl, 'BatchSchemaSuggestion', batchSuggestion.id, 2,
      () => Promise.all(['first', 'second'].map((name) => store.updateBatchSchemaSuggestionDraft(
        project.projectContextId, batchSuggestion.id, 1, { name },
      ))),
    )
    assert.deepEqual(results.map((result) => result?.status).sort(), ['conflict', 'updated'])
    const winner = results.findIndex((result) => result?.status === 'updated')
    const saved = await store.getBatchSchemaSuggestion(project.projectContextId, batchSuggestion.id)
    assert.equal(saved?.draftVersion, 2)
    assert.deepEqual(saved?.draft, { name: ['first', 'second'][winner] })
  })
  await t.test('only one worker can claim a queued suggestion', async () => {
    await db.orm.public.BatchSchemaSuggestion.where({ id: batchSuggestion.id }).update({ executionStatus: 'QUEUED' })
    const now = new Date()
    const expiresAt = new Date(now.getTime() + 60_000)
    const claims = await withBlockedUpdates(databaseUrl, 'BatchSchemaSuggestion', batchSuggestion.id, 2,
      () => Promise.all(['worker-a', 'worker-b'].map((owner) =>
        workerStore.claimBatchSchemaSuggestion(owner, now, expiresAt),
      )),
    )
    assert.equal(claims.filter(Boolean).length, 1)
    const winner = claims.find((claim) => claim !== null)!
    const saved = await store.getBatchSchemaSuggestion(project.projectContextId, batchSuggestion.id)
    assert.equal(saved?.executionStatus, 'RUNNING')
    assert.equal(await workerStore.renewBatchSchemaSuggestionLease(batchSuggestion.id, winner.lease, expiresAt), true)

    const later = new Date(expiresAt.getTime() + 1)
    const reclaimed = await workerStore.claimBatchSchemaSuggestion('replacement', later, new Date(later.getTime() + 60_000))
    assert.ok(reclaimed)
    assert.equal(reclaimed.lease.version, winner.lease.version + 1)
    for (const [lease, accepted] of [[winner.lease, false], [reclaimed.lease, true]] as const) {
      assert.equal(await workerStore.renewBatchSchemaSuggestionLease(batchSuggestion.id, lease, expiresAt), accepted)
      assert.equal(await workerStore.startBatchSchemaSuggestionSource(batchSuggestion.id, document.id, lease, later), accepted)
      assert.equal(await workerStore.completeBatchSchemaSuggestionSource(
        batchSuggestion.id, document.id, lease, { definition: { field: lease.owner } }, later,
      ), accepted)
      assert.equal(await workerStore.startBatchSchemaSuggestionMerge(batchSuggestion.id, lease), accepted)
      assert.equal(await workerStore.completeBatchSchemaSuggestionMerge(
        batchSuggestion.id, lease, { heterogeneous: true }, later,
      ), accepted)
    }
    const completed = await store.getBatchSchemaSuggestion(project.projectContextId, batchSuggestion.id)
    assert.equal(completed?.phase, 'HETEROGENEOUS')
    assert.deepEqual(completed?.sources[0]?.definition, { field: 'replacement' })
    assert.equal(await workerStore.failBatchSchemaSuggestion(batchSuggestion.id, winner.lease, {}, later), false)
    assert.equal(await workerStore.failBatchSchemaSuggestion(batchSuggestion.id, reclaimed.lease, {}, later), false)
    assert.equal((await store.retryBatchSchemaSuggestion(project.projectContextId, batchSuggestion.id))?.status, 'retried')
    const retry = await workerStore.claimBatchSchemaSuggestion('retry', later, expiresAt)
    assert.ok(retry)
    assert.equal(await workerStore.failBatchSchemaSuggestion(batchSuggestion.id, retry.lease, { code: 'model_failed' }, later), true)
  })
  assert.equal(await store.deleteProjectContext(project.projectContextId), true)

  assert.deepEqual(
    (await db.orm.public.ProjectContext.select('id').all()).map(({ id }) => id),
    [survivor.projectContextId],
  )
  assert.deepEqual(
    (await db.orm.public.SourceDocument.select('id').all()).map(({ id }) => id),
    [survivingDocument.id],
  )
  assert.equal(
    await workerStore.isPackageReferenced(representation.artifactReference),
    true,
  )
  for (const table of [
    db.orm.public.AnnotationSetRevision,
    db.orm.public.ExtractionSchema,
    db.orm.public.SchemaRevision,
    db.orm.public.Extraction,
    db.orm.public.ExtractionReview,
    db.orm.public.ReviewDecision,
  ])
    assert.deepEqual(await table.all(), [])

  await survivorStore.deleteProjectContext(survivor.projectContextId)
})
