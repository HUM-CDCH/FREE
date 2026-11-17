import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { CATALOG_TREE, migrate, provisionDatabase, seedExtraction, seedResearchPins } from './postgres-fixture.js'

test('retirement refuses historical pins before changes, preserves current pins, and replays once', async t => {
  const base = process.env.PROJECT_STORE_POSTGRES_URL
  if (!base) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a guarded disposable database.')
  const target = await provisionDatabase(base, `free_test_retirement_${randomBytes(5).toString('hex')}`)
  const client = new Client({ connectionString: target.url })
  t.after(async () => { await client.end(); await target.drop() })
  // The previous release's ref includes its data-only runtime invariants, not just its structural endpoint.
  const previous = mkdtempSync(resolve(tmpdir(), 'free-previous-release-'))
  const packageRoot = resolve(import.meta.dirname, '..')
  t.after(() => rmSync(previous, { recursive: true }))
  for (const name of ['prisma-next.config.ts', 'src/prisma', 'migrations'])
    cpSync(resolve(packageRoot, name), resolve(previous, name), { recursive: true })
  const { symlinkSync } = await import('node:fs')
  symlinkSync(resolve(packageRoot, 'node_modules'), resolve(previous, 'node_modules'), 'junction')
  writeFileSync(resolve(previous, 'migrations/app/refs/db.json'), JSON.stringify({
    hash: 'sha256:9a5c9519c9e620a2582782734688ad87aed2929ece762be272eeea4435ed1142',
    invariants: ['extraction-runtime.article-resolution-recovery', 'extraction-runtime.catalog-whitespace-recovery',
      'extraction-runtime.claude-code-extraction', 'extraction-runtime.codex-extraction', 'extraction-runtime.value-disagreement'],
  }))
  await migrate(target.url, 'db', previous)
  await client.connect()
  const pins = await seedResearchPins(client)
  const seed = async (settings: unknown) => {
    const id = await seedExtraction(client, pins)
    const catalog = settings !== null && typeof settings === 'object' &&
      ['unified', 'generic', 'recipe'].some(key => key in settings)
    if (catalog) await client.query(
      `UPDATE public.extraction SET strategy='CATALOG',"schemaRevisionId"=$2 WHERE id=$1`,
      [id, pins.revisions.catalog],
    )
    await client.query('UPDATE public.extraction SET "requestedSettings"=$2 WHERE id=$1', [id, settings])
    await client.query(`INSERT INTO extraction_runtime.head
      (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"controlVersion","pendingResume",acknowledgement,fence,"leaseEpoch",generation,"snapshotVersion",deleted)
      VALUES ($1,$2,$3,$4,$6,$5,'STOP',0,false,'STOPPED',0,0,1,0,false)`,
    [id, pins.projectContextId, pins.documents.d1.sourceRepresentationRevisionId,
      {}, randomUUID(), catalog ? 'CATALOG' : 'ARTICLE'])
    return id
  }
  const refuses = async () => {
    await assert.rejects(migrate(target.url), (error: unknown) => {
      const detail = String((error as { stdout?: string }).stdout) + String((error as { stderr?: string }).stderr)
      assert.match(detail, /retired-contracts.require-current-data/)
      assert.match(detail, /guarded local pnpm db:reset/)
      return true
    })
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='extraction' AND column_name='requestedPages'`)).rows[0].n, 1)
  }
  for (const settings of [null, { article: null }, { generic: null }, { recipe: null },
    { generic: { discovery_chars: 48_000 } }, { recipe: { input_tokens: 4_096 } },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, '11'].map(defaults => ({ unified: { defaults } })),
    { unified: {} }, { unified: { defaults: 11, verification: false } }, { unified: { defaults: 11, verification: true } },
    ...['identity', 'identity_fields', 'prompt', 'selection', 'grounding_schedule', 'grounding_routing'].map(key => ({ article: { [key]: null } }))]) {
    const id = await seed(settings)
    await refuses()
    await client.query('DELETE FROM public.extraction WHERE id=$1', [id])
    await client.query('DELETE FROM extraction_runtime.head WHERE id=$1', [id])
  }
  // Historical methods also live on batches and producing selections, independently of the public Extraction pin.
  const current = await seed({ unified: { defaults: 11 } })
  for (const settings of [{ generic: null }, { recipe: null }]) {
    const batch = randomUUID()
    await client.query(`INSERT INTO public."batchExtraction"
      (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings")
      VALUES ($1,$2,$3,'CATALOG',$4)`,
      [batch, pins.projectContextId, pins.revisions.catalog, settings])
    await refuses()
    await client.query('DELETE FROM public."batchExtraction" WHERE id=$1', [batch])
    await client.query(`INSERT INTO extraction_runtime.selection
      (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
      SELECT "selectionId",id,1,$2,$3,$4,$5,'{}',$3 FROM extraction_runtime.head WHERE id=$1`,
    [current, pins.revisions.catalog, 'a'.repeat(64), CATALOG_TREE,
      { strategy: 'CATALOG', models: null, settings }])
    await refuses()
    await client.query('DELETE FROM extraction_runtime.selection WHERE "extractionId"=$1', [current])
  }
  for (const settings of [{ article: null }, { article: { identity: 'reference' } }, { catalog: { unified: { verification: false } } }]) {
    await client.query('INSERT INTO public."modelConfiguration" ("researcherAccountId",document) VALUES ($1,$2)',
      [pins.accountId, { extractionSettings: settings }])
    await refuses()
    await client.query('DELETE FROM public."modelConfiguration" WHERE "researcherAccountId"=$1', [pins.accountId])
  }
  const cases: Array<[string, unknown[], string, unknown[]]> = [
    ['UPDATE public."schemaRevision" SET "modelAttribution"=$2 WHERE id=$1',
      [pins.revisions.article, { model: 'old' }],
      'UPDATE public."schemaRevision" SET "modelAttribution"=NULL WHERE id=$1', [pins.revisions.article]],
    ['INSERT INTO public."projectChatEntry" (id,"projectContextId",position,entry) VALUES ($1,$2,0,$3)',
      [randomUUID(), pins.projectContextId, { kind: 'legacy' }],
      'DELETE FROM public."projectChatEntry" WHERE "projectContextId"=$1', [pins.projectContextId]],
    ...[
      { coverage: [{ sourceDocumentId: pins.documents.d1.sourceDocumentId }], phase: null, draft: null },
      { coverage: null, phase: 'READY', draft: { fields: [] } },
    ].map(({ coverage, phase, draft }) => [
      'INSERT INTO public."batchSchemaSuggestion" (id,"projectContextId","selectionKey",coverage,phase,draft) VALUES ($1,$2,$3,$4,$5,$6)',
      [randomUUID(), pins.projectContextId, randomBytes(32).toString('hex'), coverage, phase, draft],
      'DELETE FROM public."batchSchemaSuggestion" WHERE "projectContextId"=$1', [pins.projectContextId],
    ] as [string, unknown[], string, unknown[]]),
    ...[null, []].map(rows => [
      'INSERT INTO public."projectSpreadsheetVersion" (id,"projectContextId","revisionNumber","originalFilename",columns,rows) VALUES ($1,$2,1,$3,$4,$5)',
      [randomUUID(), pins.projectContextId, 'current.xlsx', rows === null ? [] : [{ columnName: 'name', values: [] }], rows],
      'DELETE FROM public."projectSpreadsheetVersion" WHERE "projectContextId"=$1', [pins.projectContextId],
    ] as [string, unknown[], string, unknown[]]),
  ]
  for (const [insert, values, remove, ids] of cases) {
    await client.query(insert, values.map(value => Array.isArray(value) ? JSON.stringify(value) : value))
    await refuses()
    await client.query(remove, ids)
  }
  // A merge may currently omit a source suggestion: combined=false is a valid declaration.
  const coverage = [{ sourceDocumentId: pins.documents.d1.sourceDocumentId, sourceCoverage: { complete: true }, combined: false }]
  const suggestionId = randomUUID()
  await client.query('INSERT INTO public."batchSchemaSuggestion" (id,"projectContextId","selectionKey",coverage) VALUES ($1,$2,$3,$4)',
    [suggestionId, pins.projectContextId, randomBytes(32).toString('hex'), JSON.stringify(coverage)])
  const ids = [current, ...await Promise.all([
    seed({ unified: { defaults: 11 } }), seed({ unified: { defaults: 11, overlap: 0 } }),
  ])]
  const before = (await client.query('SELECT id,"requestedSettings" FROM public.extraction ORDER BY id')).rows
  assert.deepEqual((await migrate(target.url)).applied, ['20261116T0040_retire_legacy_contracts', '20261116T0847_unified_catalog'])
  assert.deepEqual((await client.query('SELECT id,"requestedSettings" FROM public.extraction ORDER BY id')).rows, before)
  assert.deepEqual((await client.query('SELECT coverage FROM public."batchSchemaSuggestion" WHERE id=$1', [suggestionId])).rows[0].coverage, coverage)
  assert.equal(ids.length, 3)

  const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map(r => r.table_name)
  for (const table of ['annotationSetRevision', 'extractionReview', 'reviewDecision']) assert.ok(!tables.includes(table), table)
  const required = (await client.query(`SELECT table_name,column_name,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND ((table_name IN ('extraction','batchExtraction') AND column_name='requestedSettings')
      OR (table_name='projectSpreadsheetVersion' AND column_name='rows'))`)).rows
  assert.equal(required.length, 3)
  assert.ok(required.every(row => row.is_nullable === 'NO'))
  assert.deepEqual((await migrate(target.url)).applied, [])
})
