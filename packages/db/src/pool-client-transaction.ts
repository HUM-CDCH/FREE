import type { Client, Pool, PoolClient } from 'pg'
import postgres from '@prisma-next/postgres/runtime'
import type { Contract } from './prisma/contract.d'
import contractJson from './prisma/contract.json' with { type: 'json' }
import { pool as sharedPool, type DatabaseTransaction } from './prisma/db.js'

/** A Studio workflow to enqueue inside a domain transaction (DBOSClient.enqueueInTransaction's options, by name). */
export type AdmittedWorkflow = Readonly<{
  workflowName: string
  workflowID: string
  queueName: string
  /** The Project Context owner's Researcher Account; locates the scope, never authorizes it. */
  authenticatedUser: string
  attributes: Readonly<Record<string, unknown>>
}>

/** The enqueue half of a row-backed admission: writes the workflow row through `client`, inside its open
 *  transaction, so the row and the workflow commit or roll back together. Studio implements it with its admission
 *  client; `packages/db` imports no DBOS runtime. */
export type TransactionalEnqueue = (client: PoolClient, workflow: AdmittedWorkflow, input: unknown) => Promise<void>

/**
 * Runs `work` in one transaction on one client checked out of the shared pool, and hands it both Prisma Next's
 * transaction context and that client, so an ORM write and DBOSClient.enqueueInTransaction(client, …) share the
 * transaction (spec, *Admission → Binding*; pool-client-transaction.postgres.check.ts proves it on Prisma Next 0.16 and
 * DBOS 5.1.10).
 *
 * This helper alone owns the checkout. After a commit the client goes back to the pool; after any failure, a failed
 * BEGIN included, it is destroyed instead, so a connection in an unknown state is never reused. The facade is never
 * closed, and it is bound to a view of the client that carries its queries but not its lifecycle (clientView).
 */
export async function withPoolClientTransaction<T>(
  work: (transaction: DatabaseTransaction, client: PoolClient) => Promise<T>,
  source: Pool = sharedPool,
): Promise<T> {
  const client = await source.connect()
  // pg-pool detaches its own listener from a checked-out client; without one, a server-side disconnect during the
  // admission would crash the process instead of failing the next query.
  const ignoreDisconnect = () => {}
  client.on('error', ignoreDisconnect)
  let failed = false
  try {
    const bound = postgres<Contract>({ contractJson, pg: clientView(client), verifyMarker: false })
    return await bound.transaction((transaction) => work(transaction, client))
  } catch (error) {
    failed = true
    throw error
  } finally {
    client.removeListener('error', ignoreDisconnect)
    client.release(failed)
  }
}

/**
 * What Prisma Next's `pgClient` binding may touch. It picks that binding by duck typing (`escapeIdentifier`,
 * `escapeLiteral`), calls `connect()` (a connected client's "already connected" error is ignored), runs every statement
 * through `query`, and calls `end()` when a ROLLBACK fails. It also releases, itself, any bound object that has a
 * `release` method once its transaction ends, and never releases one whose BEGIN failed: bound to the pooled client
 * directly, it would hand the client back before this helper could, and would leak it on a failed BEGIN. The view has
 * no `release`, and its `connect` and `end` do nothing: the checkout is the helper's.
 *
 * Every facade starts its prepared-statement names at `pn_1`, which could clash on a reused connection with another
 * facade's; nothing in FREE uses `prepare()`, and the ORM's statements are unnamed.
 */
function clientView(client: PoolClient): Client {
  const view: Pick<Client, 'escapeIdentifier' | 'escapeLiteral' | 'query'> & Record<'connect' | 'end', () => Promise<void>> = {
    escapeIdentifier: (value) => client.escapeIdentifier(value),
    escapeLiteral: (value) => client.escapeLiteral(value),
    connect: async () => {},
    end: async () => {},
    query: client.query.bind(client),
  }
  return view as unknown as Client
}

/** A PostgreSQL unique violation (23505), optionally on one named constraint. Prisma Next's SqlQueryError carries
 *  `sqlState` and `constraint`, a raw pg error (DBOS's, or one from `client.query`) `code` and `constraint`, and a
 *  wrapper such as a failed commit keeps either as its `cause`. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  for (let current = error; current && typeof current === 'object'; current = (current as { cause?: unknown }).cause) {
    const candidate = current as { code?: unknown; sqlState?: unknown; constraint?: unknown }
    if (candidate.code === '23505' || candidate.sqlState === '23505')
      return constraint === undefined || candidate.constraint === constraint
  }
  return false
}
