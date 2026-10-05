import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client, Pool } from 'pg'
import { createDisposableRuntime } from 'db/postgres-test-helpers'
import { migrate, provisionDatabase, seedPreMigrationHistory, ARTICLE_TREE } from '../../db/src/record-scope-history-fixture.js'
import { initializeDurableExtraction } from './durable-repository.js'
import { ExtractionError } from './errors.js'
import { createResearcherExtractionPersistence } from './postgres-persistence.js'

/** Readers show durable Extractions only, to their owner only; with the gate off, admission writes nothing. */
test('durable readers ignore head-less rows, conceal another researcher\'s Extraction, and admit nothing while off', async t => {
  const base = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const target = await provisionDatabase(base, `free_test_durable_readers_${randomBytes(5).toString('hex')}`)
  const admin = new Client({ connectionString: target.url }), source = new Pool({ connectionString: target.url, max: 4 })
  t.after(async () => { await source.end(); await admin.end(); await target.drop() })
  await migrate(target.url); await admin.connect()
  // Public Extraction rows from before durable execution: published, reviewed and batch members, none with a head.
  const history = await seedPreMigrationHistory(admin)
  const execution = {
    enqueue: async () => { throw new Error('A disabled admission must not enqueue.') },
    statuses: async () => new Map<string, string>(),
  }
  const owner = createResearcherExtractionPersistence(history.accountId, execution, { database: createDisposableRuntime(source) })
  const d1 = history.documents.d1

  assert.deepEqual(await owner.readDocumentExtractions({ sourceDocumentId: d1.sourceDocumentId }),
    { sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId, latestAttempt: null, latestReviewed: null })
  assert.equal(await owner.readExtractionAttempt(history.extractions.article.reviewed), null)
  assert.deepEqual((await owner.readBatch({ projectContextId: history.projectContextId, batchExtractionId: history.batches.catalog }))?.members, [])

  const id = randomUUID()
  const representation = (await admin.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1', [d1.sourceRepresentationRevisionId])).rows[0]
  await admin.query('INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,$4,\'ARTICLE\',$5)',
    [id, d1.sourceDocumentId, d1.sourceRepresentationRevisionId, history.revisions.article, { article: null }])
  await admin.query('BEGIN')
  try {
    await initializeDurableExtraction(admin as never, id, { projectContextId: history.projectContextId, sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId,
      schemaRevisionId: history.revisions.article, schemaTree: ARTICLE_TREE, strategy: 'ARTICLE', catalogRecipe: null, preprocessId: representation.preprocessId,
      requestedModels: null, requestedSettings: { article: null } })
    await admin.query('COMMIT')
  } catch (error) { await admin.query('ROLLBACK'); throw error }
  const listed = await owner.readDocumentExtractions({ sourceDocumentId: d1.sourceDocumentId })
  assert.equal(listed?.latestAttempt?.extractionId, id)
  assert.equal(listed?.latestAttempt?.executionStatus, 'QUEUED')
  assert.equal(listed?.latestReviewed, null)
  assert.equal((await owner.readExtractionAttempt(id))?.finalizedReview, null)

  const stranger = randomUUID()
  await admin.query('INSERT INTO public."researcherAccount" (id,"tenantId","objectId","displayName","updatedAt") VALUES ($1,$2,$3,\'Stranger\',now())',
    [stranger, randomUUID(), randomUUID()])
  const other = createResearcherExtractionPersistence(stranger, execution, { database: createDisposableRuntime(source) })
  assert.equal(await other.readExtractionAttempt(id), null)
  assert.equal(await other.readDocumentExtractions({ sourceDocumentId: d1.sourceDocumentId }), null)
  assert.equal(await other.readBatch({ projectContextId: history.projectContextId, batchExtractionId: history.batches.catalog }), null)

  const rows = async () => (await admin.query('SELECT count(*)::int AS n FROM public.extraction')).rows[0].n as number
  const heads = async () => (await admin.query('SELECT count(*)::int AS n FROM extraction_runtime.head')).rows[0].n as number
  const before = { rows: await rows(), heads: await heads() }
  await assert.rejects(owner.scheduleExtraction({ kind: 'fresh', extractionId: randomUUID(), sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId,
    schemaRevisionId: history.revisions.article, strategy: 'ARTICLE', method: history.methods.article as never }),
  (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_admissions_disabled')
  await assert.rejects(owner.scheduleBatch({ projectContextId: history.projectContextId, schemaRevisionId: history.revisions.article, strategy: 'ARTICLE',
    method: history.methods.article as never, sourceDocumentIds: [d1.sourceDocumentId], repetition: 'create-new' }),
  (error: unknown) => error instanceof ExtractionError && error.code === 'extraction_admissions_disabled')
  assert.deepEqual({ rows: await rows(), heads: await heads() }, before)
})
