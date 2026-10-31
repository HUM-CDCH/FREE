import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { test } from 'node:test'
import { Client, Pool } from 'pg'
import { migrate, provisionDatabase, seedPreMigrationHistory, ARTICLE_TREE } from '../../db/src/record-scope-history-fixture.js'

/** The value history gate: ten Extractions whose head results are each about 20 MB answer one value's history in under
 *  1.5 s, in a response under 50 KB. Opt in with VALUE_HISTORY_PERFORMANCE=1; it writes about 200 MB. */
test('value history reads one value from ten 20 MB results in under 1.5 s', { skip: process.env.VALUE_HISTORY_PERFORMANCE !== '1' }, async t => {
  const base = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const target = await provisionDatabase(base, `free_test_value_history_performance_${randomBytes(5).toString('hex')}`)
  const admin = new Client({ connectionString: target.url }), source = new Pool({ connectionString: target.url, max: 2 })
  t.after(async () => { await source.end(); await admin.end(); await target.drop() })
  await migrate(target.url); await admin.connect()
  const { createDurableRepository, initializeDurableExtraction } = await import('./durable-repository.js')
  const history = await seedPreMigrationHistory(admin)
  const d1 = history.documents.d1, node = ARTICLE_TREE.schemaNodes[0]!
  const { preprocessId } = (await admin.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1', [d1.sourceRepresentationRevisionId])).rows[0]
  const ids: string[] = []
  for (let index = 0; index < 10; index += 1) {
    const id = randomUUID()
    await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings","createdAt")
      VALUES ($1,$2,$3,$4,'ARTICLE',$5,$6)`, [id, d1.sourceDocumentId, d1.sourceRepresentationRevisionId, history.revisions.article, { article: null }, new Date(Date.UTC(2026, 9, 1 + index)).toISOString()])
    await admin.query('BEGIN')
    await initializeDurableExtraction(admin as never, id, { projectContextId: history.projectContextId, sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId,
      schemaRevisionId: history.revisions.article, schemaTree: ARTICLE_TREE, strategy: 'ARTICLE', catalogRecipe: null, preprocessId,
      requestedModels: null, requestedSettings: { article: null } })
    await admin.query('COMMIT')
    const selectionId = (await admin.query('SELECT "selectionId" FROM extraction_runtime.head WHERE id=$1', [id])).rows[0].selectionId
    // Random text resists TOAST compression; the traced value is last, the whole array is searched.
    const values = Array.from({ length: 36_000 }, (_, at) => ({ id: `v${at}`, recordId: `record${at}`, fieldId: node.id, path: ['records', at, node.name],
      selectionId, schemaRevisionId: history.revisions.article, node, modelValue: randomBytes(150).toString('base64'), evidence: [], grounding: 'ungrounded',
      processing: 'saved', lineage: [] }))
    values.push({ ...values[0]!, id: 'traced', modelValue: `Traced ${index}` })
    const body = JSON.stringify(values)
    assert.ok(body.length > 19_000_000 && body.length < 22_000_000, `results of ${body.length} bytes`)
    await admin.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage)
      VALUES ($1,$2,1,$3,$4,$5,'{}')`, [randomUUID(), id, selectionId, randomBytes(32).toString('hex'), body])
    await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=1 WHERE id=$1', [id])
    ids.push(id)
  }
  await admin.query('VACUUM ANALYZE extraction_runtime.snapshot')
  const stored = (await admin.query(`SELECT pg_size_pretty(sum(pg_column_size(values))) AS size FROM extraction_runtime.snapshot`)).rows[0].size
  const owner = createDurableRepository(history.accountId, source)
  const timings: number[] = []
  let bytes = 0
  for (let run = 0; run < 5; run += 1) {
    const started = performance.now()
    const read = await owner.valueHistory(history.projectContextId, d1.sourceDocumentId, ids[0]!, 'traced')
    timings.push(performance.now() - started)
    assert.equal(read.readings.length, 10)
    bytes = JSON.stringify(read).length
  }
  t.diagnostic(`stored ${stored}; timings ms ${timings.map(each => each.toFixed(0)).join(', ')}; response ${bytes} bytes`)
  assert.ok(Math.max(...timings) < 1500, `slowest read ${Math.max(...timings).toFixed(0)} ms`)
  assert.ok(bytes < 50_000, `response ${bytes} bytes`)
})
