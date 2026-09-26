import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { validateDisposableTestDatabaseTarget } from './database-url.js'
import { withBlockedUpdates } from './postgres-test-helpers.js'

const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('Source Document deletion preserves suggestions and interrupts affected attempts', { timeout: 120_000 }, async (t) => {
  if (!databaseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database.')
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl
  const [{ db, pool }, { createResearcherProjectStore, createInternalProjectWorkerStore }] = await Promise.all([
    import('./prisma/db.js'), import('./project-store.js'),
  ])
  const account = randomUUID()
  const schema = `dbos_delete_${randomBytes(4).toString('hex')}`
  after(async () => {
    try {
      await DBOS.shutdown()
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await db.orm.public.ProjectContext.where({ researcherAccountId: account }).delete()
      await db.orm.public.ResearcherAccount.where({ id: account }).delete()
    } finally { await db.close(); await pool.end() }
  })
  DBOS.setConfig({ name: 'free-delete-check', systemDatabaseUrl: databaseUrl, systemDatabaseSchemaName: schema,
    applicationVersion: 'check@1', executorID: `delete-${schema}`, enableOTLP: false, logLevel: 'error' })
  await DBOS.launch()
  await db.orm.public.ResearcherAccount.create({ id: account, tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Delete check' })
  const store = createResearcherProjectStore(account, db)
  const worker = createInternalProjectWorkerStore(db)
  const project = (await store.createProjectContext('Delete check')).projectContextId
  const draft = { recordDescription: 'Places in this document.', schemaNodes: [{ id: 'place', name: 'Place', type: 'string' }] }
  const proposed = { phase: 'READY' as const, proposal: draft, coverage: [], draft }

  async function source() {
    const document = await db.orm.public.SourceDocument.create({ projectContextId: project,
      contentSha256: randomBytes(32).toString('hex'), mediaType: 'application/pdf', originalName: 'source.pdf' })
    const artifact = randomBytes(32).toString('hex')
    const representation = await db.orm.public.SourceRepresentationRevision.create({ sourceDocumentId: document.id,
      revisionNumber: 1, artifactReference: artifact, artifactSha256: artifact,
      contractVersion: 'parsed_document.v2', preprocessId: randomUUID(), parserName: 'test', parserVersion: '1' })
    return { document: document.id, representation: representation.id }
  }
  async function suggestion(members: { document: string; representation: string }[], active = true) {
    const row = await db.orm.public.BatchSchemaSuggestion.create({ projectContextId: project,
      selectionKey: randomUUID(), attempt: active ? 2 : 1, outcome: active ? null : 'SUCCEEDED',
      phase: 'READY', proposal: draft, coverage: [], draft, draftVersion: 1 })
    for (const member of members) await db.orm.public.BatchSchemaSuggestionSource.create({
      batchSchemaSuggestionId: row.id, sourceDocumentId: member.document,
      sourceRepresentationRevisionId: member.representation,
    })
    return row.id
  }
  const saved = (id: string) => db.orm.public.BatchSchemaSuggestion.select(
    'attempt', 'outcome', 'failure', 'phase', 'proposal', 'draft', 'draftVersion',
  ).first({ id })

  await t.test('an active attempt is interrupted before its pin disappears, while its valid draft survives', async () => {
    const left = await source()
    const right = await source()
    const id = await suggestion([left, right])
    const before = await saved(id)
    const deleted = await store.deleteSourceDocument(project, left.document)
    assert.deepEqual(deleted, { interruptedAttempts: [{ batchSchemaSuggestionId: id, attempt: 2 }] })
    const afterDeletion = await saved(id)
    assert.equal(afterDeletion?.outcome, 'FAILED')
    assert.equal((afterDeletion?.failure as { code?: string })?.code, 'interrupted')
    assert.equal(afterDeletion?.attempt, before?.attempt)
    assert.deepEqual(afterDeletion?.proposal, before?.proposal)
    assert.deepEqual(afterDeletion?.draft, before?.draft)
    assert.equal(afterDeletion?.draftVersion, before?.draftVersion)
    assert.deepEqual(afterDeletion?.draft, draft)
    assert.deepEqual((await store.getBatchSchemaSuggestion(project, id))?.sources.map((member) => member.sourceDocumentId), [right.document])
    assert.equal(await worker.publishBatchSchemaSuggestion(id, 2, proposed), 'stopped')
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(id, 2, { code: 'late', message: 'Late.' }), 'stopped')
    assert.deepEqual(await saved(id), afterDeletion)
  })

  await t.test('deletion before, during and after publication commits without a pin FK error', async () => {
    const beforeSource = await source()
    const beforeId = await suggestion([beforeSource])
    assert.ok(await store.deleteSourceDocument(project, beforeSource.document))
    assert.equal((await saved(beforeId))?.outcome, 'FAILED')

    const duringSource = await source()
    const duringId = await suggestion([duringSource])
    const [publication, deletion] = await withBlockedUpdates(databaseUrl, 'BatchSchemaSuggestion', duringId, 2,
      () => Promise.all([
        worker.publishBatchSchemaSuggestion(duringId, 2, proposed),
        store.deleteSourceDocument(project, duringSource.document),
      ]))
    assert.ok(deletion)
    assert.ok(['published', 'stopped'].includes(publication))
    const duringRow = await saved(duringId)
    assert.ok(duringRow?.outcome === 'FAILED' || duringRow?.outcome === 'SUCCEEDED')
    assert.deepEqual(duringRow?.draft, draft)

    const afterSource = await source()
    const afterId = await suggestion([afterSource], false)
    assert.deepEqual(await store.deleteSourceDocument(project, afterSource.document), { interruptedAttempts: [] })
    assert.equal((await saved(afterId))?.outcome, 'SUCCEEDED')
    assert.deepEqual((await saved(afterId))?.draft, draft)
    assert.deepEqual((await store.getBatchSchemaSuggestion(project, afterId))?.sources, [])
    assert.deepEqual(await store.retryBatchSchemaSuggestion(project, afterId, 1), { status: 'not-ready' })
  })

  await t.test('a confirmed suggestion refuses a late attempt write even if its outcome is missing', async () => {
    const member = await source()
    const id = await suggestion([member])
    await db.orm.public.BatchSchemaSuggestion.where({ id }).update({ confirmedSchemaRevisionId: randomUUID() })
    const before = await saved(id)
    assert.equal(await worker.suggestionAttemptState(id, 2), 'stopped')
    assert.equal(await worker.publishBatchSchemaSuggestion(id, 2, proposed), 'stopped')
    assert.equal(await worker.failBatchSchemaSuggestionAttempt(id, 2, { code: 'late', message: 'Late.' }), 'stopped')
    assert.deepEqual(await saved(id), before)
  })
})
