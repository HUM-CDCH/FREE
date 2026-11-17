import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { Client } from 'pg'
import { CATALOG_TREE, migrate, provisionDatabase, seedExtraction, seedResearchPins } from './postgres-fixture.js'

test('retirement adapts Article pins, deletes what no current method reads, and replays once', async t => {
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
  const isCatalog = (settings: unknown) => settings !== null && typeof settings === 'object' &&
    ['unified', 'generic', 'recipe'].some(key => key in settings)
  // An Extraction with its runtime head, producing selection and one researcher correction.
  const seed = async (settings: unknown, batch?: string) => {
    const id = await seedExtraction(client, pins), catalog = isCatalog(settings) || batch !== undefined
    if (catalog) await client.query(
      `UPDATE public.extraction SET strategy='CATALOG',"schemaRevisionId"=$2,"batchExtractionId"=$3 WHERE id=$1`,
      [id, pins.revisions.catalog, batch ?? null],
    )
    await client.query('UPDATE public.extraction SET "requestedSettings"=$2 WHERE id=$1', [id, settings])
    const selection = randomUUID()
    await client.query(`INSERT INTO extraction_runtime.head
      (id,"projectId","sourceRevisionId","sourcePin",strategy,"selectionId",intent,"controlVersion","pendingResume",acknowledgement,fence,"leaseEpoch",generation,"snapshotVersion",deleted)
      VALUES ($1,$2,$3,$4,$6,$5,'STOP',0,false,'STOPPED',0,0,1,0,false)`,
    [id, pins.projectContextId, pins.documents.d1.sourceRepresentationRevisionId,
      {}, selection, catalog ? 'CATALOG' : 'ARTICLE'])
    await client.query(`INSERT INTO extraction_runtime.selection
      (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
      VALUES ($1,$2,1,$3,$4,$5,$6,'{}',$4)`,
    [selection, id, catalog ? pins.revisions.catalog : pins.revisions.article, 'a'.repeat(64), CATALOG_TREE,
      { strategy: catalog ? 'CATALOG' : 'ARTICLE', models: null, settings }])
    await client.query('INSERT INTO extraction_runtime."feedbackHead" (id,version) VALUES ($1,0) ON CONFLICT DO NOTHING', [pins.projectContextId])
    await client.query(`INSERT INTO extraction_runtime.correction
      (id,candidate,decision,"extractionId","feedbackVersion",included,"projectId",revision,"selectionId","snapshotVersion","valueId")
      VALUES ($1,'{}','{}',$2,1,true,$3,1,$4,1,'v1')`, [randomUUID(), id, pins.projectContextId, selection])
    return id
  }
  const batch = async (settings: unknown) => {
    const id = randomUUID()
    await client.query(`INSERT INTO public."batchExtraction" (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings")
      VALUES ($1,$2,$3,'CATALOG',$4)`, [id, pins.projectContextId, pins.revisions.catalog, settings])
    return id
  }
  const refuses = async (reason: RegExp) => {
    await assert.rejects(migrate(target.url), (error: unknown) => {
      const detail = String((error as { stdout?: string }).stdout) + String((error as { stderr?: string }).stderr)
      assert.match(detail, /retired-contracts.require-current-data/)
      assert.match(detail, reason)
      return true
    })
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema='public' AND table_name='extraction' AND column_name='requestedPages'`)).rows[0].n, 1)
  }
  const settingsOf = async (id: string) => (await client.query(
    'SELECT "requestedSettings" AS s FROM public.extraction WHERE id=$1', [id])).rows[0]?.s

  const retiredArticle = { context: 'full', identity: 'reference', identity_fields: ['title'], prompt: 'old', grounding_routing: 'x' }
  const article = await seed({ article: retiredArticle })

  // Queued or running work is refused before anything changes.
  await client.query(`UPDATE extraction_runtime.head SET acknowledgement='RUNNING' WHERE id=$1`, [article])
  await refuses(/queued or running/)
  await client.query(`UPDATE extraction_runtime.head SET acknowledgement='STOPPED' WHERE id=$1`, [article])

  // Old data that no method pin explains is still refused, and the refusal rolls the adaptation back.
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
    await refuses(/only current method pins remain/)
    assert.deepEqual(await settingsOf(article), { article: retiredArticle })
    await client.query(remove, ids)
  }

  // Every pin with no current equivalent goes, with its runtime rows and corrections.
  const retired = []
  for (const settings of [null, { article: null }, { generic: null }, { recipe: null },
    { generic: { discovery_chars: 48_000 } }, { recipe: { input_tokens: 4_096 } },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, '11'].map(defaults => ({ unified: { defaults } })),
    { unified: {} }, { unified: { defaults: 11, verification: false } }, { unified: { defaults: 11, verification: true } }])
    retired.push(await seed(settings))
  const headless = await seedExtraction(client, pins)
  const sample = await seed({ unified: { defaults: 11 } })
  await client.query(`UPDATE public.extraction SET "requestedPages"='[1]' WHERE id=$1`, [sample])
  const retiredBatch = await batch({ generic: null })
  const inRetiredBatch = await seed({ unified: { defaults: 11 } }, retiredBatch)
  // A current pin whose earlier selection ran a retired method.
  const reselected = await seed({ unified: { defaults: 11 } })
  await client.query(`INSERT INTO extraction_runtime.selection
    (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest) VALUES ($1,$2,2,$3,$4,$5,$6,'{}',$4)`,
  [randomUUID(), reselected, pins.revisions.catalog, 'a'.repeat(64), CATALOG_TREE,
    { strategy: 'CATALOG', models: null, settings: { unified: { defaults: 5 } } }])
  retired.push(headless, sample, inRetiredBatch, reselected)

  // Retired Article keys and the verification switch leave account preferences; the rest of them stays.
  await client.query('INSERT INTO public."modelConfiguration" ("researcherAccountId",document) VALUES ($1,$2)', [pins.accountId,
    { extractionSettings: { article: { identity: 'reference', context: 'full' }, catalog: { unified: { defaults: 11, verification: false } } }, roles: { keep: true } }])
  const other = await seedResearchPins(client)
  await client.query('INSERT INTO public."modelConfiguration" ("researcherAccountId",document) VALUES ($1,$2)', [other.accountId,
    { extractionSettings: { article: null, catalog: { unified: { defaults: 11 } } } }])

  const articleBatch = await batch({ article: { context: 'full', prompt: 'old' } })
  const current = [await seed({ unified: { defaults: 11 } }), await seed({ unified: { defaults: 11, overlap: 0 } }),
    await seed({ article: { context: 'full' } })]
  const before = (await client.query('SELECT id,"requestedSettings" FROM public.extraction WHERE id = ANY($1) ORDER BY id', [current])).rows
  // A merge may currently omit a source suggestion: combined=false is a valid declaration.
  const coverage = [{ sourceDocumentId: pins.documents.d1.sourceDocumentId, sourceCoverage: { complete: true }, combined: false }]
  const suggestionId = randomUUID()
  await client.query('INSERT INTO public."batchSchemaSuggestion" (id,"projectContextId","selectionKey",coverage) VALUES ($1,$2,$3,$4)',
    [suggestionId, pins.projectContextId, randomBytes(32).toString('hex'), JSON.stringify(coverage)])

  assert.deepEqual((await migrate(target.url)).applied, ['20261116T0040_retire_legacy_contracts', '20261116T0847_unified_catalog'])

  const count = async (sql: string, ids: string[]) => (await client.query(sql, [ids])).rows[0].n
  assert.equal(await count('SELECT count(*)::int AS n FROM public.extraction WHERE id = ANY($1)', retired), 0)
  assert.equal(await count('SELECT count(*)::int AS n FROM extraction_runtime.head WHERE id = ANY($1)', retired), 0)
  assert.equal(await count('SELECT count(*)::int AS n FROM extraction_runtime.selection WHERE "extractionId" = ANY($1)', retired), 0)
  assert.equal(await count('SELECT count(*)::int AS n FROM extraction_runtime.correction WHERE "extractionId" = ANY($1)', retired), 0)
  assert.equal(await count('SELECT count(*)::int AS n FROM public."batchExtraction" WHERE id = ANY($1)', [retiredBatch]), 0)

  // The Article run stays, with its correction, minus the controls the UI no longer offers.
  assert.deepEqual(await settingsOf(article), { article: { context: 'full' } })
  assert.deepEqual((await client.query('SELECT method->\'settings\' AS s FROM extraction_runtime.selection WHERE "extractionId"=$1', [article])).rows[0].s,
    { article: { context: 'full' } })
  assert.equal(await count('SELECT count(*)::int AS n FROM extraction_runtime.correction WHERE "extractionId" = ANY($1)', [article, ...current]), 4)
  assert.deepEqual((await client.query('SELECT "requestedSettings" AS s FROM public."batchExtraction" WHERE id=$1', [articleBatch])).rows[0].s,
    { article: { context: 'full' } })
  assert.deepEqual((await client.query('SELECT id,"requestedSettings" FROM public.extraction WHERE id = ANY($1) ORDER BY id', [current])).rows, before)
  const preference = async (account: string) => (await client.query(
    'SELECT document FROM public."modelConfiguration" WHERE "researcherAccountId"=$1', [account])).rows[0].document
  assert.deepEqual(await preference(pins.accountId),
    { extractionSettings: { article: { context: 'full' }, catalog: { unified: { defaults: 11 } } }, roles: { keep: true } })
  assert.deepEqual(await preference(other.accountId), { extractionSettings: { catalog: { unified: { defaults: 11 } } } })
  assert.deepEqual((await client.query('SELECT coverage FROM public."batchSchemaSuggestion" WHERE id=$1', [suggestionId])).rows[0].coverage, coverage)

  const tables = (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public'`)).rows.map(r => r.table_name)
  for (const table of ['annotationSetRevision', 'extractionReview', 'reviewDecision']) assert.ok(!tables.includes(table), table)
  const required = (await client.query(`SELECT table_name,column_name,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND ((table_name IN ('extraction','batchExtraction') AND column_name='requestedSettings')
      OR (table_name='projectSpreadsheetVersion' AND column_name='rows'))`)).rows
  assert.equal(required.length, 3)
  assert.ok(required.every(row => row.is_nullable === 'NO'))
  assert.deepEqual((await migrate(target.url)).applied, [])
})
