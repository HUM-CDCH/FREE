import { setTimeout } from 'node:timers/promises'
import { Client, type Pool } from 'pg'
import postgres from '@prisma-next/postgres/runtime'
import contractJson from './prisma/contract.json' with {type:'json'}
import type { Contract } from './prisma/contract.d'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/** Construct the typed ORM on an already owned, explicitly disposable pool. */
export function createDisposableRuntime(pg:Pool) {
  if(!pg.options.connectionString)throw new Error('An explicit disposable database URL is required.')
  validateDisposableTestDatabaseTarget(pg.options.connectionString)
  return postgres<Contract>({contractJson,pg})
}

/** Hold writes after their reads so competing updates reach the same row. */
export async function withBlockedUpdates<T>(
  databaseUrl: string,
  table: 'BatchSchemaSuggestion' | 'Extraction' | 'ExtractionSchema',
  id: string,
  count: number,
  operation: () => Promise<T>,
): Promise<T> {
  validateDisposableTestDatabaseTarget(databaseUrl)
  const tableName = { BatchSchemaSuggestion: 'batchSchemaSuggestion', Extraction: 'extraction', ExtractionSchema: 'extractionSchema' }[table]
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
    // An operation that settles before it blocks (an early rejection or result) ends the wait,
    // so its own outcome surfaces instead of the timeout.
    let settled = false
    const settlement = result.then(() => { settled = true }, () => { settled = true })
    const deadline = Date.now() + 10_000
    while (!settled) {
      await holder.query('SELECT pg_stat_clear_snapshot()')
      const waiting = await holder.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query ILIKE $1
      `, ['%UPDATE%"sourceDocument"%'])
      if (waiting.rows[0]!.count >= 1) break
      if (settled) break
      if (Date.now() >= deadline)
        throw new Error('Timed out waiting for a blocked Source Document update.')
      await Promise.race([setTimeout(10), settlement])
    }
    if (!settled) await whileBlocked(async (sql, params) => { await holder.query(sql, params) })
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
