import type { SchemaNode } from 'extraction/schema'
import type { ProposedCorrection } from '../shared/resultCorrection.contract'
import { reviewedValueSummary, shownValue } from './reviewVocabulary'

/** A change the chat proposes to one value (ADR 0035), as Results shows it until it is saved or discarded. */
export type ProposedChange = Pick<ProposedCorrection, 'action' | 'current' | 'value'>

const empty = (value: unknown) => value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
const text = (node: SchemaNode | null, value: unknown) =>
  value !== null && typeof value === 'object' ? reviewedValueSummary(node, value) : shownValue(value)

/**
 * The value as it is and as the chat would have it, as the Template view shows a proposed template change: what goes
 * struck through in red, what comes in green. A missing value filled in shows only what comes; a rejection strikes the
 * value and says so.
 */
export default function ProposedValueChange({ node, change }: { node: SchemaNode | null; change: ProposedChange }) {
  const current = !empty(change.current)
  return (
    <span className="block text-content font-medium [overflow-wrap:anywhere]">
      <span className="sr-only">Proposed in the chat: </span>
      {current && <s className="text-danger"><span className="sr-only">now </span>{text(node, change.current)}</s>}
      {change.action === 'EDITED' ? (
        <>
          {current && <span className="text-ink-faint" aria-hidden="true"> → </span>}
          <span className="text-green"><span className="sr-only">{current ? ', would become ' : 'filled in as '}</span>{text(node, change.value)}</span>
        </>
      ) : (
        <span className="ml-1.5 inline-block rounded bg-danger-soft px-1.5 align-middle text-overline font-semibold text-danger">rejected</span>
      )}
    </span>
  )
}
