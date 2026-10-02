import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { Client } from 'pg'
import {
  ARTICLE_TREE, CATALOG_TREE, migrate, provisionDatabase, RECORD_SCOPE_MIGRATION, recordScopeColumnExists,
  recordScopeDataOperation, seedPreMigrationHistory, snapshotHistory,
} from './record-scope-history-fixture.js'

/** The record-scope release on the history it meets: a fresh database migrated by the real runner to the migration
 *  before it, seeded as the previous release stored it, then migrated forward. Its own database beside
 *  PROJECT_STORE_POSTGRES_URL's, created and dropped here. */
const baseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('the record-scope migration backfills legacy revisions and leaves every historical row byte-identical', async () => {
  if (!baseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database on the test server.')
  const database = await provisionDatabase(baseUrl, 'free_test_record_scope_history')
  const client = new Client({ connectionString: database.url })
  after(async () => {
    await client.end()
    await database.drop()
  })
  const before = await migrate(database.url, `${RECORD_SCOPE_MIGRATION}^`)
  assert.ok(before.applied.length > 0 && !before.applied.includes(RECORD_SCOPE_MIGRATION))
  await client.connect()
  assert.equal(await recordScopeColumnExists(client), false)
  const history = await seedPreMigrationHistory(client)
  const seeded = await snapshotHistory(client)
  assert.deepEqual(Object.fromEntries(Object.entries(seeded).map(([table, rows]) => [table, rows.length])),
    { schemaRevision: 6, extraction: 11, batchExtraction: 2, extractionReview: 3, reviewDecision: 9 })

  const forward = await migrate(database.url)
  assert.deepEqual(forward.applied, [RECORD_SCOPE_MIGRATION])
  assert.equal(await recordScopeColumnExists(client), true)

  const scopes = async () => Object.fromEntries((await client.query<{ id: string; recordScope: string | null }>(
    'SELECT id, "recordScope" FROM "schemaRevision"')).rows.map((row) => [row.id, row.recordScope]))
  const { revisions } = history
  // (1) One strategy declares its scope, the in-flight Extraction included; both or none stay undeclared.
  assert.deepEqual(await scopes(), {
    [revisions.article]: 'document',
    [revisions.catalog]: 'records',
    [revisions.catalogBatch]: 'records',
    [revisions.both]: null,
    [revisions.never]: null,
    [revisions.disagree]: 'document',
  })
  // (1, 2) Trees, Extractions with their requests, results and review state, reviews, decisions and batches: unchanged.
  assert.deepEqual(await snapshotHistory(client), seeded)
  const trees = (await client.query<{ id: string; tree: string }>('SELECT id, "schemaTree"::text AS tree FROM "schemaRevision"')).rows
  for (const row of trees)
    assert.deepEqual(JSON.parse(row.tree), [revisions.catalog, revisions.catalogBatch].includes(row.id) ? CATALOG_TREE : ARTICLE_TREE)

  // A declared scope, even one its history disagrees with, is never rewritten by a replay of the transform, and the
  // migration's check finds nothing to do for it.
  await client.query('UPDATE "schemaRevision" SET "recordScope" = $1 WHERE id = $2', ['records', revisions.disagree])
  await client.query('UPDATE "schemaRevision" SET "recordScope" = $1 WHERE id = $2', ['document', revisions.never])
  const declared = await scopes()
  const data = recordScopeDataOperation()
  const check = async (steps: typeof data.precheck) => {
    for (const step of steps) return (await client.query(step.sql, step.params ?? [])).rows[0]?.ok as boolean
    throw new Error('The data operation has no check.')
  }
  assert.equal(await check(data.precheck), false, 'the check selects no declared or ambiguous revision')
  for (const step of data.execute) await client.query(step.sql, step.params ?? [])
  assert.equal(await check(data.postcheck), true)
  assert.deepEqual(await scopes(), declared)
  assert.deepEqual(await snapshotHistory(client), seeded)
  // The runner itself has nothing left to apply.
  assert.deepEqual((await migrate(database.url)).applied, [])
})
