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
    projectContextId: project.id,
    extractionSchemaId: schema.id,
    promptRevisionId: prompt.id,
    annotationMode: 'hints',
    outcome: 'SUCCEEDED',
    modelAttribution: {},
    proposedTree: [],
  })
  assert.equal(suggestion.projectContextId, project.id)
  await assert.rejects(
    db.orm.public.SchemaSuggestion.create({
      projectContextId: null as never,
      annotationMode: 'hints',
      outcome: 'SUCCEEDED',
      modelAttribution: {},
    }),
    /projectContextId.*null|not-null/i,
  )
  await assert.rejects(
    db.orm.public.SchemaSuggestion.create({
      projectContextId: survivor.id,
      extractionSchemaId: schema.id,
      annotationMode: 'hints',
      outcome: 'SUCCEEDED',
      modelAttribution: {},
    }),
    /schema_suggestion_schema_owner_fkey/,
  )
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

  // A concurrent ready/reopen trigger gives exactly one durable source
  // suggestion lease owner. A later process recovers an abandoned lease and
  // exposes only the completed, representation-pinned result.
  const suggestedDocument = await db.orm.public.SourceDocument.create({
    projectContextId: project.id,
    ingestionKey: '51000000-0000-4000-9000-000000000003',
    contentSha256: 'f'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'suggested.pdf',
  })
  const suggestedRepresentation =
    await db.orm.public.SourceRepresentationRevision.create({
      sourceDocumentId: suggestedDocument.id,
      revisionNumber: 1,
      artifactReference: 'f'.repeat(64),
      artifactSha256: 'f'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'f'.repeat(64)}`,
      parserName: 'test',
      parserVersion: '1',
    })
  const extractionSchemaCountBeforeSuggestion = (
    await db.orm.public.ExtractionSchema.all()
  ).length
  const schemaRevisionCountBeforeSuggestion = (
    await db.orm.public.SchemaRevision.all()
  ).length
  const claimedAt = new Date('2026-08-15T10:00:00Z')
  const claims = await Promise.all([
    store.beginSourceSchemaSuggestion(
      project.id,
      suggestedDocument.id,
      claimedAt,
    ),
    store.beginSourceSchemaSuggestion(
      project.id,
      suggestedDocument.id,
      claimedAt,
    ),
  ])
  const owner = claims.find((claim) => claim?.status === 'work')
  assert.equal(claims.filter((claim) => claim?.status === 'work').length, 1)
  assert.equal(claims.filter((claim) => claim?.status === 'pending').length, 1)
  assert.equal(owner?.status, 'work')
  if (owner?.status !== 'work') throw new Error('Expected one lease owner.')
  await store.failSourceSchemaSuggestion(owner.schemaSuggestionId, {
    code: 'model_operation_failed',
  })
  assert.deepEqual(
    (
      await db.orm.public.SchemaSuggestion.select('failure').first({
        id: owner.schemaSuggestionId,
      })
    )?.failure,
    { state: 'failed', code: 'model_operation_failed' },
  )
  const immediateRetry = await store.beginSourceSchemaSuggestion(
    project.id,
    suggestedDocument.id,
    claimedAt,
  )
  assert.equal(immediateRetry?.status, 'work')
  assert.notEqual(
    immediateRetry?.status === 'work'
      ? immediateRetry.schemaSuggestionId
      : null,
    owner.schemaSuggestionId,
  )
  if (immediateRetry?.status !== 'work')
    throw new Error('Expected immediate retry owner.')
  assert.equal(
    (
      await store.beginSourceSchemaSuggestion(
        project.id,
        suggestedDocument.id,
        claimedAt,
      )
    )?.status,
    'pending',
  )
  const equalTimeAttempts = (
    await db.orm.public.SchemaSuggestion.where({
      projectContextId: project.id,
    })
      .select('createdAt', 'modelAttribution', 'outcome', 'leaseExpiresAt')
      .all()
  )
    .filter(
      (attempt) =>
        (
          attempt.modelAttribution as {
            operation?: string
          }
        ).operation === 'batch-source-schema-suggestion',
    )
    .sort(
      (left, right) =>
        (left.modelAttribution as { attemptOrdinal: number }).attemptOrdinal -
        (right.modelAttribution as { attemptOrdinal: number }).attemptOrdinal,
    )
  assert.deepEqual(
    equalTimeAttempts.map((attempt) => [
      attempt.createdAt.toISOString(),
      (attempt.modelAttribution as { attemptOrdinal: number }).attemptOrdinal,
      attempt.outcome,
      attempt.leaseExpiresAt?.toISOString(),
    ]),
    [
      [claimedAt.toISOString(), 1, 'FAILED', undefined],
      [
        claimedAt.toISOString(),
        2,
        'RUNNING',
        new Date(claimedAt.getTime() + 2 * 60 * 1000).toISOString(),
      ],
    ],
  )
  const recovered = await store.beginSourceSchemaSuggestion(
    project.id,
    suggestedDocument.id,
    new Date('2026-08-15T10:03:00Z'),
  )
  assert.equal(recovered?.status, 'work')
  assert.notEqual(
    recovered?.status === 'work' ? recovered.schemaSuggestionId : null,
    immediateRetry?.status === 'work'
      ? immediateRetry.schemaSuggestionId
      : null,
  )
  if (recovered?.status !== 'work') throw new Error('Expected lease recovery.')
  await store.completeSourceSchemaSuggestion(
    immediateRetry.schemaSuggestionId,
    { _description: 'Stale record.', stale: 'string' },
    '{"stale":"string"}',
  )
  const staleAttempt = await db.orm.public.SchemaSuggestion.select(
    'outcome',
    'failure',
    'leaseExpiresAt',
    'proposedTree',
  ).first({ id: immediateRetry.schemaSuggestionId })
  assert.equal(staleAttempt?.outcome, 'CANCELLED')
  assert.equal(staleAttempt?.failure, null)
  assert.equal(staleAttempt?.leaseExpiresAt, null)
  assert.equal(staleAttempt?.proposedTree, null)
  await store.completeSourceSchemaSuggestion(
    recovered.schemaSuggestionId,
    { _description: 'One record.', place: 'string' },
    '{"place":"string"}',
  )
  await store.failSourceSchemaSuggestion(immediateRetry.schemaSuggestionId, {
    code: 'unexpected_failure',
  })
  assert.equal(
    (
      await db.orm.public.SchemaSuggestion.select('failure').first({
        id: immediateRetry.schemaSuggestionId,
      })
    )?.failure,
    null,
  )
  assert.deepEqual(
    await db.orm.public.SchemaSuggestion.select(
      'outcome',
      'leaseExpiresAt',
    ).first({ id: recovered.schemaSuggestionId }),
    { outcome: 'SUCCEEDED', leaseExpiresAt: null },
  )
  const reopened = await store.getBatchSchemaSuggestionInputs(project.id, [
    suggestedDocument.id,
  ])
  assert.ok(reopened)
  assert.deepEqual(reopened.suggestions, [
    {
      sourceDocumentId: suggestedDocument.id,
      sourceRepresentationRevisionId: suggestedRepresentation.id,
      template: { _description: 'One record.', place: 'string' },
    },
  ])
  assert.equal(
    (await db.orm.public.ExtractionSchema.all()).length,
    extractionSchemaCountBeforeSuggestion,
  )
  assert.equal(
    (await db.orm.public.SchemaRevision.all()).length,
    schemaRevisionCountBeforeSuggestion,
  )
  assert.ok(
    (
      await db.orm.public.SchemaSuggestion.where({
        projectContextId: project.id,
      })
        .select('extractionSchemaId', 'modelAttribution')
        .all()
    )
      .filter(
        (attempt) =>
          (attempt.modelAttribution as { operation?: string }).operation ===
          'batch-source-schema-suggestion',
      )
      .every((attempt) => attempt.extractionSchemaId === null),
  )
  const suggestedDefinition = {
    recordDescription: 'One record.',
    schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
  }
  const confirmed = await store.confirmBatchSchemaSuggestion(
    project.id,
    [suggestedDocument.id],
    reopened.selectionKey,
    suggestedDefinition,
  )
  assert.equal(confirmed?.status, 'created')
  if (confirmed?.status !== 'created') throw new Error('Expected confirmation.')
  const changed = await store.appendSchemaRevision(
    project.id,
    confirmed.revision.extractionSchemaId,
    confirmed.revision.revisionNumber,
    {
      recordDescription: 'A changed record.',
      schemaNodes: [{ id: 'country', name: 'country', type: 'string' }],
    },
  )
  assert.equal(changed?.status, 'created')
  const restored = await store.confirmBatchSchemaSuggestion(
    project.id,
    [suggestedDocument.id],
    reopened.selectionKey,
    suggestedDefinition,
  )
  assert.equal(restored?.status, 'created')
  if (restored?.status !== 'created')
    throw new Error('Expected restored confirmation.')
  assert.deepEqual(restored.revision.schemaTree, suggestedDefinition)
  assert.equal(restored.revision.revisionNumber, 3)
  const replayedConfirmation = await store.confirmBatchSchemaSuggestion(
    project.id,
    [suggestedDocument.id],
    reopened.selectionKey,
    {
      recordDescription: 'One record.',
      schemaNodes: [{ id: 'another-id', name: 'place', type: 'string' }],
    },
  )
  assert.equal(replayedConfirmation?.status, 'replayed')
  assert.equal(
    replayedConfirmation?.status === 'replayed'
      ? replayedConfirmation.revision.schemaRevisionId
      : null,
    restored?.status === 'created' ? restored.revision.schemaRevisionId : null,
  )
  const suggestedBatch = await store.createBatchExtraction(project.id, {
    batchExtractionId: '51000000-0000-4000-9000-000000000103',
    schemaRevisionId: restored.revision.schemaRevisionId,
    strategy: 'CATALOG',
    sourceDocumentIds: [suggestedDocument.id],
  })
  assert.equal(suggestedBatch?.status, 'created')
  assert.equal(
    suggestedBatch?.status === 'created'
      ? suggestedBatch.batch.members[0]?.sourceRepresentationRevisionId
      : null,
    suggestedRepresentation.id,
  )

  // Source-owned attempts follow their Source Document, not only their Project
  // Context. The direct owner FK makes deletion race-safe and stale settlement
  // harmless while leaving another document's attempt intact.
  const retainedAttempt = await store.beginSourceSchemaSuggestion(
    project.id,
    document.id,
    new Date('2026-08-15T11:00:00Z'),
  )
  assert.equal(retainedAttempt?.status, 'work')
  if (retainedAttempt?.status !== 'work')
    throw new Error('Expected retained source suggestion owner.')
  await store.completeSourceSchemaSuggestion(
    retainedAttempt.schemaSuggestionId,
    { _description: 'Retained record.', retained: 'string' },
    '{"retained":"string"}',
  )
  const deletableDocument = await db.orm.public.SourceDocument.create({
    projectContextId: project.id,
    ingestionKey: '51000000-0000-4000-9000-000000000004',
    contentSha256: 'g'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'deletable.pdf',
  })
  const deletableRepresentation =
    await db.orm.public.SourceRepresentationRevision.create({
      sourceDocumentId: deletableDocument.id,
      revisionNumber: 1,
      artifactReference: 'g'.repeat(64),
      artifactSha256: 'g'.repeat(64),
      contractVersion: 'parsed_document.v2',
      preprocessId: `sha256:${'g'.repeat(64)}`,
      parserName: 'test',
      parserVersion: '1',
    })
  const deletableAttempt = await store.beginSourceSchemaSuggestion(
    project.id,
    deletableDocument.id,
    new Date('2026-08-15T11:01:00Z'),
  )
  assert.equal(deletableAttempt?.status, 'work')
  if (deletableAttempt?.status !== 'work')
    throw new Error('Expected deletable source suggestion owner.')
  await store.completeSourceSchemaSuggestion(
    deletableAttempt.schemaSuggestionId,
    { _description: 'Deleted record.', deleted: 'string' },
    '{"deleted":"string"}',
  )
  assert.deepEqual(
    await db.orm.public.SchemaSuggestion.select(
      'projectContextId',
      'sourceDocumentId',
    ).first({ id: deletableAttempt.schemaSuggestionId }),
    {
      projectContextId: project.id,
      sourceDocumentId: deletableDocument.id,
    },
  )

  assert.deepEqual(
    await store.deleteSourceDocument(project.id, deletableDocument.id),
    [
      {
        artifactReference: deletableRepresentation.artifactReference,
        artifactSha256: deletableRepresentation.artifactSha256,
      },
    ],
  )
  assert.equal(
    await db.orm.public.SchemaSuggestion.select('id').first({
      id: deletableAttempt.schemaSuggestionId,
    }),
    null,
  )
  assert.equal(
    await db.orm.public.SchemaSuggestionInput.select(
      'schemaSuggestionId',
    ).first({ schemaSuggestionId: deletableAttempt.schemaSuggestionId }),
    null,
  )
  await store.completeSourceSchemaSuggestion(
    deletableAttempt.schemaSuggestionId,
    { _description: 'Stale record.', stale: 'string' },
    '{"stale":"string"}',
  )
  assert.equal(
    (
      await db.orm.public.SchemaSuggestion.select('outcome').first({
        id: retainedAttempt.schemaSuggestionId,
      })
    )?.outcome,
    'SUCCEEDED',
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
    {
      artifactReference: suggestedRepresentation.artifactReference,
      artifactSha256: suggestedRepresentation.artifactSha256,
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
