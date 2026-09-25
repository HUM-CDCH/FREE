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

/**
 * Hold `SELECT … FOR UPDATE` on one Source Document row from a second connection, start
 * `operation`, wait until one backend is blocked on an UPDATE of "sourceDocument" (the
 * product lock is a no-op update), run `whileBlocked` on the holding connection, then
 * commit and return the operation's result.
 */
export async function withHeldSourceDocumentLock<T>(
  databaseUrl: string,
  sourceDocumentId: string,
  operation: () => Promise<T>,
  whileBlocked: (run: (sql: string, params?: unknown[]) => Promise<void>) => Promise<void>,
): Promise<T> {
  validateDisposableTestDatabaseTarget(databaseUrl)
  const holder = new Client({ connectionString: databaseUrl })
  await holder.connect()
  let result: Promise<T> | undefined
  try {
    await holder.query('BEGIN')
    await holder.query('SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE', [sourceDocumentId])
    result = operation()
    void result.catch(() => {})
    const deadline = Date.now() + 10_000
    while (true) {
      await holder.query('SELECT pg_stat_clear_snapshot()')
      const waiting = await holder.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE $1
      `, ['%UPDATE%"sourceDocument"%'])
      if (waiting.rows[0]!.count >= 1) break
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for a blocked Source Document update.')
      await setTimeout(10)
    }
    await whileBlocked(async (sql, params) => { await holder.query(sql, params) })
    await holder.query('COMMIT')
    return await result
  } finally {
    try {
      await holder.query('ROLLBACK')
    } finally {
      await holder.end()
      await result?.catch(() => {})
    }
  }
}
