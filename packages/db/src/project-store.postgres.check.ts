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
 * Give it a freshly created database every run: it expects no account and no
 * Project Context before it starts, and it only cleans up when it passes.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('PostgreSQL preserves Project Context ownership, concurrency, and cascades', async (t) => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_cascade.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  // Imported only now: these modules build the pool from DATABASE_URL when they load.
  const [
    { db, pool },
    {
      createInternalProjectWorkerStore,
      createResearcherProjectStore,
    },
    { isUniqueViolation },
  ] = await Promise.all([
    import('./prisma/db.js'),
    import('./project-store.js'),
    import('./pool-client-transaction.js'),
  ])
  after(async () => {
    await db.close()
    await pool.end()
  })

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
      ensureRetained: async () => {
        throw new Error('package unavailable')
      },
    }),
    /package unavailable/,
  )
  assert.equal(
    await db.orm.public.SourceDocument.select('id').first({
      projectContextId: survivor.projectContextId,
    }),
    null,
  )
  const [ingested, concurrentReplay] = await Promise.all([
    store.ingestSourceDocument(project.projectContextId, ingestion),
    store.ingestSourceDocument(project.projectContextId, {
      ...ingestion,
      originalName: 'same-bytes-renamed.pdf',
    }),
  ])
  assert.ok(ingested)
  assert.ok(concurrentReplay)
  // One insert won; the other met the (project, content) constraint and read the winner.
  assert.deepEqual(
    [ingested.disposition, concurrentReplay.disposition].sort(),
    ['created', 'replayed'],
  )
  const { disposition: _ingestedDisposition, ...ingestedDocument } = ingested
  const { disposition: _replayDisposition, ...replayedDocument } = concurrentReplay
  assert.deepEqual(replayedDocument, ingestedDocument)
  assert.deepEqual(
    await store.findSourceDocumentByContent(project.projectContextId, ingestion.contentSha256),
    ingestedDocument,
  )
  assert.equal(
    await survivorStore.findSourceDocumentByContent(project.projectContextId, ingestion.contentSha256),
    null,
  )
  // The Source Ingestion listing resolves failed attempts' content in one read, within one owned project only.
  assert.deepEqual(
    [...(await store.findSourceDocumentIdsByContent(project.projectContextId, [ingestion.contentSha256, 'f'.repeat(64)]))],
    [[ingestion.contentSha256, ingestedDocument.sourceDocumentId]],
  )
  assert.equal((await survivorStore.findSourceDocumentIdsByContent(project.projectContextId, [ingestion.contentSha256])).size, 0)
  assert.equal((await store.findSourceDocumentIdsByContent(project.projectContextId, [])).size, 0)
  // The publication backstop names this constraint: a second insert of the content is a replay, nothing else is.
  const duplicate = await db.transaction(({ orm }) => orm.public.SourceDocument.create({
    projectContextId: project.projectContextId,
    contentSha256: ingestion.contentSha256,
    mediaType: 'application/pdf',
    originalName: 'duplicate.pdf',
  })).then(() => null, (error: unknown) => error)
  assert.ok(isUniqueViolation(duplicate, 'sourceDocument_projectContextId_contentSha256_key'), String(duplicate))
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
    { ...ingestedDocument, disposition: 'replayed' },
  )
  const sameNameDifferentContent = await store.ingestSourceDocument(
    project.projectContextId,
    {
      ...ingestion,
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
  await t.test("modelOperationScopeExists is true only for the account's project and, when named, a schema of that project", async () => {
    assert.equal(await store.modelOperationScopeExists(project.projectContextId, null), true)
    assert.equal(await store.modelOperationScopeExists(project.projectContextId, schema.id), true)
    assert.equal(await store.modelOperationScopeExists(project.projectContextId, '52000000-0000-4000-8000-0000000000aa'), false)
    assert.equal(await store.modelOperationScopeExists(survivor.projectContextId, null), false)
    assert.equal(await survivorStore.modelOperationScopeExists(project.projectContextId, null), false)
    assert.equal(await survivorStore.modelOperationScopeExists(survivor.projectContextId, schema.id), false)
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
    outcome: 'SUCCEEDED',
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
  await t.test('two executions of one attempt\'s publication write one outcome and one draft version', async () => {
    await db.orm.public.BatchSchemaSuggestion.where({ id: batchSuggestion.id }).update({ attempt: 2, outcome: null })
    const proposal = { phase: 'READY' as const, proposal: { name: 'proposed' }, coverage: [], draft: { name: 'proposed' } }
    const results = await withBlockedUpdates(databaseUrl, 'BatchSchemaSuggestion', batchSuggestion.id, 2,
      () => Promise.all([1, 2].map(() => workerStore.publishBatchSchemaSuggestion(batchSuggestion.id, 2, proposal))),
    )
    assert.deepEqual([...results].sort(), ['published', 'stopped'])
    const saved = await db.orm.public.BatchSchemaSuggestion.select('outcome', 'draft', 'draftVersion').first({ id: batchSuggestion.id })
    assert.deepEqual(saved, { outcome: 'SUCCEEDED', draft: { name: 'proposed' }, draftVersion: 3 })
    assert.equal(await workerStore.failBatchSchemaSuggestionAttempt(batchSuggestion.id, 2, { code: 'late', message: 'Late.' }), 'stopped')
  })
  assert.equal(await store.deleteProjectContext(project.projectContextId), true)
  assert.equal(await store.modelOperationScopeExists(project.projectContextId, null), false)

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
    db.orm.public.BatchSchemaSuggestion,
    db.orm.public.BatchSchemaSuggestionSource,
  ])
    assert.deepEqual(await table.all(), [])

  await survivorStore.deleteProjectContext(survivor.projectContextId)
})
