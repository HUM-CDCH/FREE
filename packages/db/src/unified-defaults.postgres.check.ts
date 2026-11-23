import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { CATALOG_TREE, migrate, provisionDatabase, seedExtraction, seedResearchPins } from './postgres-fixture.js'

const MIGRATION = '20261121T1855_unified_defaults_12', INVARIANT = 'unified-catalog.defaults-12'

test('stored Unified Catalog pins move from defaults 11 to 12, what a run recorded stays, and it replays once', async t => {
  const base = process.env.PROJECT_STORE_POSTGRES_URL
  if (!base) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a guarded disposable database.')
  const target = await provisionDatabase(base, `free_test_defaults_${randomBytes(5).toString('hex')}`)
  const client = new Client({ connectionString: target.url })
  t.after(async () => { await client.end(); await target.drop() })
  // The release before this migration: the same contract, without the migration and its data invariant.
  const previous = mkdtempSync(resolve(tmpdir(), 'free-previous-release-'))
  const packageRoot = resolve(import.meta.dirname, '..')
  t.after(() => rmSync(previous, { recursive: true }))
  for (const name of ['prisma-next.config.ts', 'src/prisma', 'migrations'])
    cpSync(resolve(packageRoot, name), resolve(previous, name), { recursive: true })
  symlinkSync(resolve(packageRoot, 'node_modules'), resolve(previous, 'node_modules'), 'junction')
  rmSync(resolve(previous, 'migrations/app', MIGRATION), { recursive: true })
  const ref = JSON.parse(readFileSync(resolve(packageRoot, 'migrations/app/refs/db.json'), 'utf8')) as { hash: string; invariants: string[] }
  writeFileSync(resolve(previous, 'migrations/app/refs/db.json'),
    JSON.stringify({ hash: ref.hash, invariants: ref.invariants.filter(each => each !== INVARIANT) }))
  await migrate(target.url, 'db', previous)
  await client.connect()
  const pins = await seedResearchPins(client)

  // An Extraction as defaults 11 left it: its requested settings, its selections, the worker's resolved configuration,
  // a plan that records how the run read, and one researcher correction.
  const provider = { key: 'instruct', model: 'fake/extractor', adapter: 'instruct', adapterVersion: 1, url: 'http://model.test/v1', timeout: 60, maxTokens: 4096 }
  const seed = async (settings: Record<string, unknown>) => {
    const id = await seedExtraction(client, pins), catalog = 'unified' in settings, selections: string[] = []
    if (catalog) await client.query(`UPDATE public.extraction SET strategy='CATALOG',"schemaRevisionId"=$2 WHERE id=$1`, [id, pins.revisions.catalog])
    await client.query('UPDATE public.extraction SET "requestedSettings"=$2 WHERE id=$1', [id, settings])
    const options = catalog ? { strategy: 'catalog', ...settings } : { strategy: 'article', ...settings }
    for (const ordinal of [1, 2]) {
      const selection = randomUUID()
      selections.push(selection)
      if (ordinal === 1) await client.query(`INSERT INTO extraction_runtime.head
        (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"controlVersion","pendingResume",acknowledgement,fence,"leaseEpoch",generation,"snapshotVersion",deleted)
        VALUES ($1,$2,$3,$4,$6,$5,'RUN',0,false,'COMPLETED',0,0,1,0,false)`,
      [id, pins.projectContextId, pins.documents.d1.sourceRepresentationRevisionId, {}, selection, catalog ? 'CATALOG' : 'ARTICLE'])
      await client.query(`INSERT INTO extraction_runtime.selection
        (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5)`,
      [selection, id, ordinal, catalog ? pins.revisions.catalog : pins.revisions.article, 'a'.repeat(64), CATALOG_TREE,
        { models: null, settings }, { protocol: 1, plannerVersion: 1, promptVersion: 1, options, startPage: null }])
    }
    const [selection] = selections as [string, string]
    await client.query(`INSERT INTO extraction_runtime.effective (id,configuration,digest)
      VALUES ($1,$2,extraction_runtime.content_hash($2))`,
    [selection, { models: { fields: provider, reasoning: provider }, options, planner: 1, protocols: { calls: 1, source: catalog ? 'records' : 'document' } }])
    await client.query(`INSERT INTO extraction_runtime.plan (id,"extractionId",generation,stage,digest,manifest) VALUES ($1,$2,1,$3,$4,$5)`,
      [randomUUID(), id, 'unified-execution:0123456789abcdef', 'b'.repeat(64),
        { plannerVersion: 1, selectionId: selection, units: [], coverage: {}, execution: { method: settings.unified ?? null, prompt_version: 11 } }])
    await client.query('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES ($1,0) ON CONFLICT DO NOTHING', [pins.projectContextId])
    await client.query(`INSERT INTO extraction_runtime.correction
      (id,candidate,decision,"extractionId","feedbackVersion",included,"projectId",revision,"selectionId","snapshotVersion","valueId")
      VALUES ($1,'{}','{}',$2,1,true,$3,1,$4,1,'v1')`, [randomUUID(), id, pins.projectContextId, selection])
    return id
  }
  const catalog = await seed({ unified: { defaults: 11, overlap: 0 } })
  const article = await seed({ article: { context: 'full' } })
  const batch = randomUUID()
  await client.query(`INSERT INTO public."batchExtraction" (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings")
    VALUES ($1,$2,$3,'CATALOG',$4)`, [batch, pins.projectContextId, pins.revisions.catalogBatch, { unified: { defaults: 11 } }])

  const stored = async (id: string) => ({
    requested: (await client.query('SELECT "requestedSettings" AS s FROM public.extraction WHERE id=$1', [id])).rows[0].s,
    selections: (await client.query('SELECT method,resolved,digest FROM extraction_runtime.selection WHERE "extractionId"=$1 ORDER BY ordinal', [id])).rows,
    effective: (await client.query(`SELECT e.configuration,e.digest,e.digest=extraction_runtime.content_hash(e.configuration) AS hashed
      FROM extraction_runtime.effective e JOIN extraction_runtime.selection s ON s.id=e.id WHERE s."extractionId"=$1`, [id])).rows,
    plans: (await client.query('SELECT stage,digest,manifest FROM extraction_runtime.plan WHERE "extractionId"=$1', [id])).rows,
    corrections: (await client.query('SELECT count(*)::int AS n FROM extraction_runtime.correction WHERE "extractionId"=$1', [id])).rows[0].n,
  })
  const before = { catalog: await stored(catalog), article: await stored(article) }

  // Queued or running work is refused before anything changes.
  await client.query(`UPDATE extraction_runtime.head SET acknowledgement='RUNNING' WHERE id=$1`, [article])
  await assert.rejects(migrate(target.url), (error: unknown) => {
    const detail = String((error as { stdout?: string }).stdout) + String((error as { stderr?: string }).stderr)
    assert.match(detail, /unified-catalog\.defaults-12/)
    assert.match(detail, /queued or running/)
    return true
  })
  assert.deepEqual({ catalog: await stored(catalog), article: await stored(article) }, before)
  await client.query(`UPDATE extraction_runtime.head SET acknowledgement='COMPLETED' WHERE id=$1`, [article])

  assert.deepEqual((await migrate(target.url)).applied, [MIGRATION])

  // Every pin the admitted contract reads names defaults 12; the overrides beside it are kept.
  const after = await stored(catalog), unified = { defaults: 12, overlap: 0 }
  assert.deepEqual(after.requested, { unified })
  assert.deepEqual(after.selections.map(row => row.method), [{ models: null, settings: { unified } }, { models: null, settings: { unified } }])
  assert.deepEqual(after.selections.map(row => row.resolved.options), [{ strategy: 'catalog', unified }, { strategy: 'catalog', unified }])
  assert.deepEqual(after.effective.map(row => [row.configuration.options, row.hashed]), [[{ strategy: 'catalog', unified }, true]])
  assert.notEqual(after.effective[0].digest, before.catalog.effective[0].digest)
  assert.deepEqual({ ...after.effective[0].configuration, options: null }, { ...before.catalog.effective[0].configuration, options: null })
  assert.deepEqual((await client.query('SELECT "requestedSettings" AS s FROM public."batchExtraction" WHERE id=$1', [batch])).rows[0].s,
    { unified: { defaults: 12 } })
  // What the run recorded about itself stays: the selections' digests, the plan with its execution record, the
  // correction. Another method's Extraction is untouched.
  assert.deepEqual(after.selections.map(row => row.digest), before.catalog.selections.map(row => row.digest))
  assert.deepEqual(after.plans, before.catalog.plans)
  assert.equal(after.plans[0].manifest.execution.method.defaults, 11)
  assert.equal(after.corrections, 1)
  assert.deepEqual(await stored(article), before.article)

  // The immutability guards are back for the runtime's own writes.
  for (const table of ['selection', 'effective'])
    await assert.rejects(client.query(`UPDATE extraction_runtime.${table} SET digest=digest`), /immutable Extraction history/)

  assert.deepEqual((await migrate(target.url)).applied, [])
})
