import type { DurablePage } from 'extraction/durable-types'
import type { SchemaNode } from 'extraction/schema'
import { reviewDraft } from './durableReviewMachine'

/** One saved value of a member's latest results, as the durable reader returns it. */
export type GridValue = DurablePage['values'][number]
export type GridAction = 'APPROVED' | 'EDITED' | 'REJECTED' | 'PENDING'

/** One top-level field across the batch. A document field (`valueSource`) holds one value per document, shown once
 *  across its records. */
export type GridColumn = { fieldId: string; name: string; document: boolean }

/** One record of one member: its values by field. */
export type GridRecord = { key: string; index: number; values: ReadonlyMap<string, GridValue> }

/** A member's latest results laid out for the grid: its document values and its records in reading order. */
export type GridLayout = { document: ReadonlyMap<string, GridValue>; records: GridRecord[] }

/** The pinned template's top-level fields in schema order, then any field only a saved value names (its own producing
 *  field), document fields first. */
export function gridColumns(pages: Iterable<DurablePage>, schemaNodes: readonly SchemaNode[]): GridColumn[] {
  const columns = new Map<string, GridColumn>()
  for (const page of pages)
    for (const value of page.values)
      if (!columns.has(value.fieldId))
        columns.set(value.fieldId, { fieldId: value.fieldId, name: value.node.name, document: Boolean(value.node.valueSource) })
  const rank = (column: GridColumn) => {
    const at = schemaNodes.findIndex((node) => node.id === column.fieldId || node.name === column.name)
    return at < 0 ? schemaNodes.length : at
  }
  return [...columns.values()].sort((a, b) => Number(b.document) - Number(a.document) || rank(a) - rank(b))
}

/** A member's values grouped into its records (by the ordinal their path names) and its document values. */
export function gridLayout(page: DurablePage): GridLayout {
  const document = new Map<string, GridValue>()
  const records = new Map<string, { key: string; index: number; values: Map<string, GridValue> }>()
  for (const value of page.values) {
    if (value.node.valueSource) { document.set(value.fieldId, value); continue }
    let record = records.get(value.recordId)
    if (!record) {
      const index = typeof value.path[1] === 'number' ? value.path[1] : records.size
      record = { key: value.recordId, index, values: new Map() }
      records.set(value.recordId, record)
    }
    record.values.set(value.fieldId, value)
  }
  return { document, records: [...records.values()].sort((a, b) => a.index - b.index) }
}

/** A saved value a decision applies to: reviewable, unlike a missing or unread one. */
export const reviewable = (value: GridValue) => value.processing === 'saved'

/** A reviewable value with no decision yet (or one set back to To check). */
export const toCheck = (value: GridValue) =>
  reviewable(value) && (!value.correction || value.correction.decision.action === 'PENDING')

/** A value a bulk Approve may decide: To check and with one reading. A Value Disagreement is approved only by
 *  choosing a reading, which the document's review offers. */
export const bulkApprovable = (value: GridValue) => toCheck(value) && !value.disagreement

/** A value the researcher has decided: approved, edited or rejected. */
export const decided = (value: GridValue) => reviewable(value) && !toCheck(value)

/** Every value of a layout, its document values included. */
export const layoutValues = (layout: GridLayout): GridValue[] =>
  [...layout.document.values(), ...layout.records.flatMap((record) => [...record.values.values()])]

/** The correction a grid decision saves: the same body the document's review saves (`durableReviewMachine`), bound to
 *  the value's latest revision so a concurrent decision reports a conflict instead of being overwritten. Setting a
 *  value back to To check (`PENDING`) keeps its model value and guides nothing. */
export function decisionBody(value: GridValue, snapshotVersion: number, action: GridAction, edited?: unknown) {
  const draft = reviewDraft(value)
  const expectedRevision = value.correction?.revision ?? value.historicalCorrection?.revision ?? 0
  if (action === 'PENDING')
    return { expectedRevision, snapshotVersion, action, value: value.modelValue, included: false, evidence: [] }
  return {
    expectedRevision, snapshotVersion, action,
    value: action === 'EDITED' ? edited : draft.value,
    included: draft.included, evidence: draft.evidence,
    ...(action === 'APPROVED' && draft.choices ? { choices: draft.choices } : {}),
  }
}

/** Whether a member's latest results can be finalized now: every saved value decided, and not finalized already. */
export const finalizable = (page: DurablePage) =>
  page.finalization === null && page.total > 0 && page.reviewCounts.toCheck === 0
