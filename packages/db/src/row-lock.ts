import type { DatabaseOrm } from './prisma/db.js'

/**
 * Serializes writers on one Source Document for the rest of the current transaction.
 *
 * The Prisma Next runtime executes only prepared builder statements, and the builder has
 * no `FOR UPDATE` clause, so the lock is a no-op UPDATE of the document row: it takes the
 * same row-level lock, and any other transaction that updates or `FOR UPDATE`-selects the
 * row waits until this one commits or rolls back. Call it inside `database.transaction`
 * before reading the document's current Source Representation Revision.
 *
 * Returns false when the document does not exist, so callers keep their "missing" path.
 */
export async function lockSourceDocumentRow(
  orm: DatabaseOrm,
  sourceDocumentId: string,
): Promise<boolean> {
  const document = await orm.public.SourceDocument.select('id', 'originalName').first({
    id: sourceDocumentId,
  })
  if (!document) return false
  await orm.public.SourceDocument.where({ id: sourceDocumentId }).update({
    originalName: document.originalName,
  })
  return true
}
