import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { planTwoMigrations } from './migration-snapshots-fixture.js'
import { migrate, provisionDatabase } from './record-scope-history-fixture.js'

/** Migrations sharing their start contracts replay like copied ones: onto a database at the current history's head,
 *  and onto an empty one. Its own database beside PROJECT_STORE_POSTGRES_URL's, created and dropped here. */
const baseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('migrations that share start contracts replay onto upgraded and empty databases', async () => {
  if (!baseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database on the test server.')
  const scratch = planTwoMigrations()
  after(scratch.remove)
  const { first, second } = scratch
  const replay = async (upgrade: boolean) => {
    const database = await provisionDatabase(baseUrl, `free_test_migration_snapshots_${randomBytes(5).toString('hex')}`)
    const client = new Client({ connectionString: database.url })
    try {
      if (upgrade) assert.ok((await migrate(database.url, first.from, scratch.packageDirectory)).applied.length > 0)
      const { applied } = await migrate(database.url, undefined, scratch.packageDirectory)
      assert.deepEqual(upgrade ? applied : applied.slice(-2), [first.directory, second.directory])
      if (!upgrade) assert.ok(applied.length > 2)
      await client.connect()
      const columns = await client.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'evaluationRound' AND column_name LIKE 'snapshotProbe%' ORDER BY 1`)
      assert.deepEqual(columns.rows.map((row) => row.column_name), ['snapshotProbeA', 'snapshotProbeB'])
      assert.equal((await client.query('SELECT core_hash FROM prisma_contract.marker')).rows[0].core_hash, second.to)
      // The runner still records each reached contract, read from the migration's own end contract.
      const stored = await client.query<{ core_hash: string; hash: string }>(`SELECT core_hash,
        contract_json -> 'storage' ->> 'storageHash' AS hash FROM prisma_contract.contract WHERE core_hash = ANY($1)`,
        [[first.to, second.to]])
      assert.deepEqual(stored.rows.map((row) => [row.core_hash, row.hash]).sort(), [[first.to, first.to], [second.to, second.to]].sort())
    } finally {
      await client.end()
      await database.drop()
    }
  }
  await replay(true)
  await replay(false)
})
