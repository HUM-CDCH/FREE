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
