import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { isDecidable, passesFilter, type RailModel, type RailRecord, type RailRow, type ValueFilter } from './reviewVocabulary'
import { ApprovedGlyph, DisclosureGlyph, SpinnerGlyph } from './ui/icons'
import { observeEvidenceHover } from './evidenceHover'
import { markValueId } from './durableRailModel'
import type { SelectionChannel } from './selectionChannel'

/** A record header's right-hand state, as text and as the section's accessible name. */
function recordState(record: RailRecord): { text: string; busy: boolean; done: boolean } {
  if (record.state === 'queued') return { text: 'Queued', busy: false, done: false }
  if (record.state === 'reading') return { text: 'Reading…', busy: true, done: false }
  if (record.state === 'checking') return { text: `Checking ${record.rows.length} values`, busy: true, done: false }
  if (record.toCheck > 0) return { text: `${record.toCheck} to check`, busy: false, done: false }
  // Only a decision checks a value: a record of missing or unread values has nothing checked.
  if (!record.rows.some((row) => isDecidable(row.kind)))
    return { text: record.rows.every((row) => row.kind === 'missing') ? 'no values' : 'nothing to check', busy: false, done: false }
  return { text: 'all checked', busy: false, done: true }
}

const section = 'overflow-hidden rounded-lg border border-line bg-surface'
const NOTHING = <p className="m-0 px-4 pt-1 pb-3 text-secondary text-ink-muted">Nothing in this record for this filter.</p>

/**
 * The list: one component for both phases, records keyed by their index so settlement
 * moves nothing; a document's fields once above them; an Article's one record flat. The caller renders each row.
 */
export default function ReviewList({ model, article, finding, filter, selectedKey, linkedKeys, selection, isOpen, onToggle, renderRow }: {
  model: RailModel
  article: boolean
  /** Before discovery: the one block that becomes the list. */
  finding: boolean
  filter: ValueFilter
  selectedKey: string | null
  linkedKeys: ReadonlySet<string>
  /** The values under the pointer, on a mark or a row: their rows are lit, a collapsed record's header for its own. */
  selection: SelectionChannel
  isOpen: (record: RailRecord) => boolean
  onToggle: (record: RailRecord) => void
  renderRow: (row: RailRow, pinned: boolean) => ReactNode
}) {
  const root = useRef<HTMLDivElement>(null)
  // Subscribe here, not in Results or the workspace. Hover changes only the affected wrappers and collapsed headers;
  // it never renders a value row again. Rebind after React changes the list or opens a record.
  useLayoutEffect(() => observeEvidenceHover(selection, [root.current], true))
  const rowsOf = (rows: readonly RailRow[]) => rows.flatMap((row) => {
    const passes = passesFilter(row, filter)
    const linked = linkedKeys.has(row.key)
    return passes || row.key === selectedKey || linked ? [
      <div key={row.key} data-result-key={row.key} data-hover-keys={JSON.stringify([row.key])} data-evidence-linked={linked || undefined}
        className={`${row.key !== selectedKey ? '[&.hovered]:rounded-md [&.hovered]:bg-surface-muted [&.hovered]:shadow-none' : ''} ${linked ? 'rounded-md bg-ev-ghost shadow-[inset_2px_0_0_var(--color-ev)]' : ''}`}>
        {linked && <span className="sr-only">Linked to the selected passage</span>}
        {renderRow(row, !passes)}
      </div>,
    ] : []
  })
  if (finding) return (
    <div className={`${section} flex flex-col gap-2.5 p-3`}>
      <span className="flex items-center gap-1.5 text-secondary text-ink"><SpinnerGlyph />Finding the records in the source…</span>
      <span className="h-3 w-[70%] rounded-sm bg-line motion-safe:animate-pulse" />
      <span className="h-3 w-[45%] rounded-sm bg-line motion-safe:animate-pulse" />
    </div>
  )
  if (model.records.length === 0 && model.document.length === 0)
    return <p className="m-0 px-1 py-6 text-center text-secondary text-ink-muted">No records were found in the source.</p>
  // One listener for the list: a row a decision drops from under the pointer is let go at its next move. It follows
  // the pointer's own movement, so a row that scrolls in under a still pointer is not lit.
  const onMouseMove = (event: MouseEvent) => {
    const key = (event.target as Element).closest<HTMLElement>('[data-result-key]')?.dataset.resultKey ?? null
    const hovered = selection.snapshot().hover
    const lit = hovered?.length === 1 ? markValueId(hovered[0]!) : hovered ? undefined : null
    if (key !== lit) selection.hover(key ? [key] : null)
  }
  return (
    <div ref={root} className="flex flex-col gap-2" onMouseMove={onMouseMove} onMouseLeave={() => selection.hover(null)}>
      {model.document.length > 0 && (
        <section aria-label="Document" className={`${section} p-1`}>
          <h3 className="m-0 px-2 pt-1.5 pb-1 text-content font-bold text-ink">Document</h3>
          {rowsOf(model.document)}
        </section>
      )}
      {article ? (
        <div className={`${section} p-1`}>{model.records.flatMap((record) => rowsOf(record.rows))}</div>
      ) : model.records.map((record) => {
        const state = recordState(record)
        const open = record.state !== 'queued' && isOpen(record)
        const rows = open ? rowsOf(record.rows) : []
        return (
          <section key={record.key ?? record.index} aria-label={`${record.label}, ${state.text}`} className={section}>
            <button type="button" aria-expanded={open} disabled={record.state === 'queued'} onClick={() => onToggle(record)}
              data-hover-keys={JSON.stringify(open ? [] : record.rows.map(row => row.key))}
              className="flex h-9.5 w-full cursor-pointer items-center gap-1.5 px-2.5 text-left outline-none hover:bg-surface-muted [&.hovered]:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default">
              <DisclosureGlyph open={open} />
              <b className="min-w-10 truncate text-content text-ink">{record.label}</b>
              <span className="min-w-0 truncate text-secondary text-ink-muted">
                {[record.label === `Record ${record.index + 1}` ? null : `Record ${record.index + 1}`, record.page === null ? null : `p.${record.page}`].filter(Boolean).join(' · ')}
              </span>
              <span className="flex-1" />
              <span className={`flex shrink-0 items-center gap-1 text-compact tabular-nums ${state.busy || record.state === 'queued' ? 'font-medium text-ink-muted' : 'text-ink'}`}>
                {state.busy && <SpinnerGlyph className="size-3.5 text-ink" />}{state.done && <ApprovedGlyph />}{state.text}
              </span>
            </button>
            {open && <div className="px-1 pb-1">{rows.length > 0 ? rows : NOTHING}</div>}
          </section>
        )
      })}
    </div>
  )
}
