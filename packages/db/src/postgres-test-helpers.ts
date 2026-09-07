import { setTimeout } from 'node:timers/promises'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/** Hold writes after their reads so competing updates reach the same row. */
export async function withBlockedUpdates<T>(
  databaseUrl: string,
  table: 'BatchSchemaSuggestion' | 'ExtractionJob',
  id: string,
  count: number,
  operation: () => Promise<T>,
): Promise<T> {
  validateDisposableTestDatabaseTarget(databaseUrl)
  const tableName = table === 'BatchSchemaSuggestion' ? 'batchSchemaSuggestion' : 'extractionJob'
  const blocker = new Client({ connectionString: databaseUrl })
  await blocker.connect()
  let result: Promise<T> | undefined
  try {
    await blocker.query('BEGIN')
    await blocker.query(`SELECT id FROM "${tableName}" WHERE id = $1 FOR UPDATE`, [id])
    result = operation()
    // The blocker must always be released, including when an operation fails early.
    void result.catch(() => {})
    const deadline = Date.now() + 10_000
    while (true) {
      await blocker.query('SELECT pg_stat_clear_snapshot()')
      const waiting = await blocker.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE $1
      `, [`%UPDATE%"${tableName}"%`])
      if (waiting.rows[0]!.count >= count) break
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for ${count} blocked ${table} updates.`)
      await setTimeout(10)
    }
    await blocker.query('COMMIT')
    return await result
  } finally {
    try {
      await blocker.query('ROLLBACK')
    } finally {
      await blocker.end()
      await result?.catch(() => {})
    }
  }
}
