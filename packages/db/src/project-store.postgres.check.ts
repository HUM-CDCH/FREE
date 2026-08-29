import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

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

test('PostgreSQL cascades the complete Project Context graph', async () => {
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
  const annotation = await db.orm.public.AnnotationSetRevision.create({
    sourceDocumentId: document.id,
    sourceRepresentationRevisionId: representation.id,
    revisionNumber: 1,
    snapshot: {},
  })
  const schema = await db.orm.public.ExtractionSchema.create({
    projectContextId: project.projectContextId,
    name: 'Schema',
  })
  const prompt = await db.orm.public.PromptRevision.create({
    extractionSchemaId: schema.id,
    revisionNumber: 1,
    text: 'Extract.',
  })
  const suggestion = await db.orm.public.SchemaSuggestion.create({
    extractionSchemaId: schema.id,
    promptRevisionId: prompt.id,
    annotationMode: 'hints',
    outcome: 'SUCCEEDED',
    modelAttribution: {},
    proposedTree: [],
  })
  await db.orm.public.SchemaSuggestionInput.create({
    schemaSuggestionId: suggestion.id,
    sourceRepresentationRevisionId: representation.id,
    annotationSetRevisionId: annotation.id,
  })
  const baseRevision = await db.orm.public.SchemaRevision.create({
    extractionSchemaId: schema.id,
    schemaSuggestionId: suggestion.id,
    revisionNumber: 1,
    origin: 'SUGGESTION',
    schemaTree: [],
  })
  const edit = await db.orm.public.ConversationalSchemaEdit.create({
    extractionSchemaId: schema.id,
    baseSchemaRevisionId: baseRevision.id,
    sourceRepresentationRevisionId: representation.id,
    annotationSetRevisionId: annotation.id,
    promptRevisionId: prompt.id,
    instruction: 'Add a field.',
    outcome: 'SUCCEEDED',
    modelAttribution: {},
    proposedTree: [],
  })
  const appliedRevision = await db.orm.public.SchemaRevision.create({
    extractionSchemaId: schema.id,
    conversationalSchemaEditId: edit.id,
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
    db.orm.public.PromptRevision,
    db.orm.public.SchemaSuggestion,
    db.orm.public.SchemaSuggestionInput,
    db.orm.public.SchemaRevision,
    db.orm.public.ConversationalSchemaEdit,
    db.orm.public.Extraction,
    db.orm.public.ExtractionReview,
    db.orm.public.ReviewDecision,
  ])
    assert.deepEqual(await table.all(), [])

  await survivorStore.deleteProjectContext(survivor.projectContextId)
})
