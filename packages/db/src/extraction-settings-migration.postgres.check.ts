import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/** The backfill on populated data: the migration's own data SQL, run against documents shaped as they were stored
 *  before this release, a document that already has the member, and a malformed one. */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('the extraction-settings backfill adds only the empty member to valid stored documents', async () => {
  if (!databaseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a migrated disposable free_test_* database.')
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl
  const [{ db, pool }, { createModelConfigurationStore }] = await Promise.all([
    import('./prisma/db.js'), import('./model-configuration-store.js'),
  ])
  const ids: string[] = []
  after(async () => {
    try { for (const id of ids) await db.orm.public.ResearcherAccount.where({ id }).delete() }
    finally { await db.close(); await pool.end() }
  })
  const account = async () => {
    const created = await db.orm.public.ResearcherAccount.create({ tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Migrated' })
    ids.push(created.id)
    return created.id
  }
  const store = createModelConfigurationStore(db)
  const before = {
    connections: [{ id: randomUUID(), name: 'Lab', provider: 'vllm', baseUrl: 'http://lab.example/v1', hasKey: true }],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: { fields: 'nuextract', reasoning: 'instruct' },
    ingestionModels: { ocr: 'surya' },
  }
  const saved = { ...before, extractionSettings: { article: { context: 'bounded' } } }
  const [old, current, malformed] = [await account(), await account(), await account()]
  await store.apply(old, () => before)
  await store.apply(current, () => saved)
  await store.apply(malformed, () => ['not', 'an', 'object'])

  const migrations = resolve(import.meta.dirname, '../migrations/app')
  const directory = readdirSync(migrations).find((name) => name.endsWith('_extraction_settings'))!
  const operations = JSON.parse(readFileSync(resolve(migrations, directory, 'ops.json'), 'utf8')) as
    Array<{ operationClass: string; execute: Array<{ sql: string; params: unknown[] }>; postcheck: Array<{ sql: string; params: unknown[] }> }>
  const data = operations.find((operation) => operation.operationClass === 'data')!
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    for (const step of data.execute) await client.query(step.sql, step.params)
    for (const step of data.postcheck) assert.equal((await client.query(step.sql, step.params)).rows[0]?.ok, true)
    // Running it again changes nothing: a replay of the transform is harmless.
    for (const step of data.execute) await client.query(step.sql, step.params)
  } finally {
    await client.end()
  }
  assert.deepEqual(await store.read(old), { ...before, extractionSettings: {} })
  assert.deepEqual(await store.read(current), saved)
  assert.deepEqual(await store.read(malformed), ['not', 'an', 'object'])
})
