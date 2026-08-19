import assert from 'node:assert/strict'
import { after, test } from 'node:test'

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
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: docker compose -f packages/db/docker-compose.yml up -d && createdb free_test_cascade.',
    )
  const url = new URL(databaseUrl)
  if (!url.pathname.slice(1).startsWith('free_test_'))
    throw new Error(
      'The PostgreSQL cascade check requires a free_test_* database.',
    )
  process.env.DATABASE_URL = databaseUrl

  const [{ db }, { createProjectStore }] = await Promise.all([
    import('./prisma/db.js'),
    import('./project-store.js'),
  ])
  after(() => db.close())

  const store = createProjectStore(db)
  const project = await db.orm.public.ProjectContext.create({ name: 'Doomed' })
  const survivor = await db.orm.public.ProjectContext.create({
    name: 'Survivor',
  })
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
    store.ingestSourceDocument(survivor.id, {
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
    store.ingestSourceDocument(project.id, ingestion),
    store.ingestSourceDocument(project.id, ingestion),
  ])
  assert.ok(ingested)
  assert.deepEqual(concurrentReplay, ingested)
  assert.equal(ingested.revisionNumber, 1)
  assert.deepEqual(
    await store.ingestSourceDocument(project.id, ingestion),
    ingested,
  )
  const document = { id: ingested.sourceDocumentId }
  const representation = {
    id: ingested.sourceRepresentationId,
    artifactReference: ingestion.artifactReference,
    artifactSha256: ingestion.artifactSha256,
  }
  const survivingDocument = await db.orm.public.SourceDocument.create({
    projectContextId: survivor.id,
    ingestionKey: '51000000-0000-4000-9000-000000000002',
    contentSha256: 'b'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'survivor.pdf',
  })
  await db.orm.public.SourceRepresentationRevision.create({
    sourceDocumentId: survivingDocument.id,
    revisionNumber: 1,
    artifactReference: 'c'.repeat(64),
    artifactSha256: 'c'.repeat(64),
    contractVersion: 'parsed_document.v2',
    preprocessId: `sha256:${'d'.repeat(64)}`,
    parserName: 'test',
    parserVersion: '1',
  })
  const annotation = await db.orm.public.AnnotationSetRevision.create({
    sourceDocumentId: document.id,
    sourceRepresentationRevisionId: representation.id,
    revisionNumber: 1,
    snapshot: {},
  })
  const schema = await db.orm.public.ExtractionSchema.create({
    projectContextId: project.id,
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
  await db.orm.public.ReviewDecision.create({
    extractionId: extraction.id,
    evidenceAnchorId: 'anchor-1',
    reviewedOccurrenceIds: [],
  })
  // Historical owned revisions cannot open a new batch: batches always pin
  // the Current Schema Revision.
  assert.deepEqual(
    await store.createBatchExtraction(project.id, {
      batchExtractionId: '51000000-0000-4000-9000-000000000100',
      schemaRevisionId: baseRevision.id,
      strategy: 'CATALOG',
      sourceDocumentIds: [document.id],
    }),
    { status: 'invalid' },
  )
  const opened = await store.createBatchExtraction(project.id, {
    batchExtractionId: '51000000-0000-4000-9000-000000000101',
    schemaRevisionId: appliedRevision.id,
    strategy: 'CATALOG',
    sourceDocumentIds: [document.id],
  })
  assert.equal(opened?.status, 'created')
  assert.deepEqual(opened?.status === 'created' ? opened.batch.members : null, [
    {
      sourceDocumentId: document.id,
      sourceRepresentationRevisionId: representation.id,
      latestExtraction: null,
    },
  ])
  // A Source Document outside the Project Context can never join its batch.
  assert.deepEqual(
    await store.createBatchExtraction(project.id, {
      batchExtractionId: '51000000-0000-4000-9000-000000000102',
      schemaRevisionId: appliedRevision.id,
      strategy: 'CATALOG',
      sourceDocumentIds: [survivingDocument.id],
    }),
    { status: 'invalid' },
  )
  assert.deepEqual(
    await store.createBatchExtraction(project.id, {
      batchExtractionId: '51000000-0000-4000-9000-000000000101',
      schemaRevisionId: appliedRevision.id,
      strategy: 'ARTICLE',
      sourceDocumentIds: [document.id],
    }),
    { status: 'conflict' },
  )
  await db.orm.public.Extraction.create({
    sourceDocumentId: document.id,
    schemaRevisionId: appliedRevision.id,
    sourceRepresentationRevisionId: representation.id,
    batchExtractionId: '51000000-0000-4000-9000-000000000101',
    strategy: 'CATALOG',
    outcome: 'FAILED',
    diagnostics: {},
    failure: { code: 'extraction_failed', message: 'Extraction failed.' },
    reviewable: false,
  })
  // The composite pin refuses an Extraction whose Schema Revision or
  // Extraction Strategy disagrees with the Batch Extraction it claims.
  await assert.rejects(
    db.orm.public.Extraction.create({
      sourceDocumentId: document.id,
      schemaRevisionId: baseRevision.id,
      sourceRepresentationRevisionId: representation.id,
      batchExtractionId: '51000000-0000-4000-9000-000000000101',
      strategy: 'CATALOG',
      outcome: 'SUCCEEDED',
      complete: true,
      diagnostics: {},
      modelAttribution: {},
      resultPayload: {},
      reviewable: true,
    }),
    /extraction_batch_pin_fkey/,
  )
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
  // Matching the Batch's schema and strategy is not enough: the persisted
  // attempt must also be for its selected Source Document revision.
  await assert.rejects(
    db.orm.public.Extraction.create({
      sourceDocumentId: document.id,
      schemaRevisionId: appliedRevision.id,
      sourceRepresentationRevisionId: newerRepresentation.id,
      batchExtractionId: '51000000-0000-4000-9000-000000000101',
      strategy: 'CATALOG',
      outcome: 'SUCCEEDED',
      complete: true,
      diagnostics: {},
      modelAttribution: {},
      resultPayload: {},
      reviewable: true,
    }),
    /extraction_batch_member_fkey/,
  )
  const listed = await store.listBatchExtractions(project.id, 20)
  assert.equal(listed?.length, 1)
  assert.equal(listed?.[0].extractionSchemaName, 'Schema')
  assert.equal(listed?.[0].schemaRevisionNumber, 2)
  assert.equal(listed?.[0].members[0].latestExtraction?.outcome, 'FAILED')

  const suggestedBatch = await store.createBatchExtraction(project.id, {
    batchExtractionId: '51000000-0000-4000-9000-000000000103',
    schemaRevisionId: appliedRevision.id,
    strategy: 'CATALOG',
    sourceDocumentIds: [document.id],
  })
  assert.equal(suggestedBatch?.status, 'created')
  assert.equal(
    suggestedBatch?.status === 'created'
      ? suggestedBatch.batch.members[0]?.sourceRepresentationRevisionId
      : null,
    newerRepresentation.id,
  )
  const candidates = await store.deleteProjectContext(project.id)

  assert.deepEqual(candidates, [
    {
      artifactReference: representation.artifactReference,
      artifactSha256: representation.artifactSha256,
    },
    {
      artifactReference: newerRepresentation.artifactReference,
      artifactSha256: newerRepresentation.artifactSha256,
    },
  ])
  assert.deepEqual(
    (await db.orm.public.ProjectContext.select('id').all()).map(({ id }) => id),
    [survivor.id],
  )
  assert.deepEqual(
    (await db.orm.public.SourceDocument.select('id').all()).map(({ id }) => id),
    [survivingDocument.id],
  )
  assert.equal(
    await store.isPackageReferenced(representation.artifactReference),
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
    db.orm.public.ReviewDecision,
    db.orm.public.BatchExtraction,
    db.orm.public.BatchExtractionMember,
  ])
    assert.deepEqual(await table.all(), [])

  await store.deleteProjectContext(survivor.id)
})
