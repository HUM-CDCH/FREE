import type { PoolClient } from 'pg'
import type { DatabaseTransaction } from './prisma/db.js'

/**
 * Serializes writers on one Source Document for the rest of the current transaction.
 *
 * The Prisma Next runtime executes only prepared builder statements, and the builder has
 * no `FOR UPDATE` clause, so the lock is a no-op UPDATE of the document row: it takes the
 * same row-level lock, and any other transaction that updates or `FOR UPDATE`-selects the
 * row waits until this one commits or rolls back. The parameter is the transaction context
 * that `database.transaction` hands its callback, not the root client: on the root client
 * the update would commit at once and release the lock.
 *
 * Returns false when the document does not exist, or was deleted while this call waited
 * for the lock, so callers keep their "missing" path.
 */
export async function lockSourceDocumentRow(
  transaction: DatabaseTransaction,
  sourceDocumentId: string,
): Promise<boolean> {
  const document = await transaction.orm.public.SourceDocument.select(
    'id',
    'originalName',
  ).first({ id: sourceDocumentId })
  if (!document) return false
  return (
    (await transaction.orm.public.SourceDocument.where({
      id: sourceDocumentId,
    }).update({ originalName: document.originalName })) !== null
  )
}

/**
 * Orders an admission against its Researcher Account's configuration applies for the rest of the admission's
 * transaction, and returns the committed document (null before the account's first apply). `client` is the pooled
 * client withPoolClientTransaction hands its work, so the lock belongs to that transaction.
 *
 * FOR SHARE conflicts with the lock `ModelConfigurationStore.apply` holds (its upsert's ON CONFLICT DO UPDATE): an
 * apply in flight commits first and this reads what it committed, and an apply that starts later waits for this
 * transaction. Admissions do not block one another. An account that never applied has no row: nothing is locked or
 * created, and a first apply racing this transaction is ordered after it, since nothing it writes was read here.
 * Callers lock Source Document rows first; `apply` takes no other lock, so the order has no cycle.
 */
export async function lockModelConfiguration(
  client: Pick<PoolClient, 'query'>,
  researcherAccountId: string,
): Promise<unknown | null> {
  const { rows } = await client.query<{ document: unknown }>(
    'SELECT "document" FROM "public"."modelConfiguration" WHERE "researcherAccountId" = $1 FOR SHARE',
    [researcherAccountId],
  )
  return rows[0]?.document ?? null
}
