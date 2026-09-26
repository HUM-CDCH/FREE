import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import { Client } from 'pg'
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
  let admission: DBOSClient | undefined
  after(async () => {
    try {
      await admission?.destroy()
      await DBOS.shutdown()
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await db.orm.public.ProjectContext.where({ researcherAccountId: account }).delete()
      await db.orm.public.ResearcherAccount.where({ id: account }).delete()
    } finally { await db.close(); await pool.end() }
  })
  DBOS.setConfig({ name: 'free-delete-check', systemDatabaseUrl: databaseUrl, systemDatabaseSchemaName: schema,
    applicationVersion: 'check@1', executorID: `delete-${schema}`, enableOTLP: false, logLevel: 'error' })
  await DBOS.launch()
  admission = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, systemDatabaseSchemaName: schema,
    applicationName: 'studio' })
  await db.orm.public.ResearcherAccount.create({ id: account, tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Delete check' })
  const store = createResearcherProjectStore(account, db)
  const admitting = createResearcherProjectStore(account, db, { enqueue: async (client, workflow, input) => {
    await admission!.enqueueInTransaction(client, workflow, input)
  } })
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

  async function projectLockOrder<T, U>(first: () => Promise<T>, second: () => Promise<U>): Promise<[T, U]> {
    const holder = new Client({ connectionString: databaseUrl })
    await holder.connect()
    let one: Promise<T> | undefined
    let two: Promise<U> | undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM "projectContext" WHERE id = $1 FOR UPDATE', [project])
      const holderPid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      const waitFor = async (count: number) => {
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          await holder.query('SELECT pg_stat_clear_snapshot()')
          const waiting = await holder.query<{ count: number }>(`WITH RECURSIVE blocked(pid) AS (
              SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
              UNION
              SELECT activity.pid FROM pg_stat_activity activity JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
            )
            SELECT count(*)::int AS count FROM blocked JOIN pg_stat_activity USING (pid)
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE '%UPDATE%"projectContext"%'`,
            [holderPid])
          if (waiting.rows[0]!.count >= count) return
          await delay(10)
        }
        throw new Error(`Timed out waiting for ${count} project locks.`)
      }
      one = first()
      void one.catch(() => {})
      await waitFor(1)
      two = second()
      void two.catch(() => {})
      await waitFor(2)
      await holder.query('COMMIT')
      return await Promise.all([one, two])
    } finally {
      await holder.query('ROLLBACK').catch(() => {})
      await holder.end()
      await Promise.allSettled([one, two].filter((candidate) => candidate !== undefined))
    }
  }

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
    const publishedDraft = { recordDescription: 'Published places.', schemaNodes: [{ id: 'place', name: 'Place', type: 'string' }] }
    const [publication, deletion] = await withBlockedUpdates(databaseUrl, 'BatchSchemaSuggestion', duringId, 2,
      () => Promise.all([
        worker.publishBatchSchemaSuggestion(duringId, 2, { ...proposed, proposal: publishedDraft, draft: publishedDraft }),
        store.deleteSourceDocument(project, duringSource.document),
      ]))
    assert.ok(deletion)
    assert.ok(['published', 'stopped'].includes(publication))
    const duringRow = await saved(duringId)
    assert.ok(duringRow?.outcome === 'FAILED' || duringRow?.outcome === 'SUCCEEDED')
    assert.deepEqual(duringRow?.draft, publication === 'published' ? publishedDraft : draft)
    assert.equal(duringRow?.draftVersion, publication === 'published' ? 2 : 1)

    const afterSource = await source()
    const afterId = await suggestion([afterSource], false)
    assert.deepEqual(await store.deleteSourceDocument(project, afterSource.document), { interruptedAttempts: [] })
    assert.equal((await saved(afterId))?.outcome, 'SUCCEEDED')
    assert.deepEqual((await saved(afterId))?.draft, draft)
    assert.equal((await saved(afterId))?.draftVersion, 1)
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

  await t.test('admission and deletion serialize before membership is read', async () => {
    const admittedSource = await source()
    const [created, deleted] = await projectLockOrder(
      () => admitting.createBatchSchemaSuggestion(project, [admittedSource.document]),
      () => store.deleteSourceDocument(project, admittedSource.document),
    )
    assert.equal(created?.status, 'created')
    assert.ok(created && 'suggestion' in created)
    assert.deepEqual(deleted, { interruptedAttempts: [{ batchSchemaSuggestionId: created.suggestion.batchSchemaSuggestionId, attempt: 1 }] })
    assert.equal(await worker.publishBatchSchemaSuggestion(created.suggestion.batchSchemaSuggestionId, 1, proposed), 'stopped')

    const refusedSource = await source()
    const [removed, refused] = await projectLockOrder(
      () => store.deleteSourceDocument(project, refusedSource.document),
      () => admitting.createBatchSchemaSuggestion(project, [refusedSource.document]),
    )
    assert.deepEqual(removed, { interruptedAttempts: [] })
    assert.deepEqual(refused, { status: 'invalid' })
  })
})
