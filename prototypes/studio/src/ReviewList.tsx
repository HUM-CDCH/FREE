import type { ReactNode } from 'react'
import { passesFilter, type RailModel, type RailRecord, type RailRow, type ValueFilter } from './reviewVocabulary'
import { ApprovedGlyph, DisclosureGlyph, SpinnerGlyph } from './ui/icons'

/** A record header's right-hand state (§3.1), as text and as the section's accessible name. */
function recordState(record: RailRecord): { text: string; busy: boolean; done: boolean } {
  if (record.state === 'queued') return { text: 'Queued', busy: false, done: false }
  if (record.state === 'reading') return { text: 'Reading…', busy: true, done: false }
  if (record.state === 'checking') return { text: `Checking ${record.rows.length} values`, busy: true, done: false }
  return record.toCheck > 0 ? { text: `${record.toCheck} to check`, busy: false, done: false }
    : record.retained ? {text:'saved values checked',busy:false,done:record.rows.every(row=>row.retained?.reviewable)}
    : { text: 'all checked', busy: false, done: true }
}

const section = 'overflow-hidden rounded-lg border border-line bg-surface'
const NOTHING = <p className="m-0 px-4 pt-1 pb-3 text-secondary text-ink-muted">Nothing in this record for this filter.</p>

/**
 * The list (results review redesign §3): one component for both phases, records keyed by their index so settlement
 * moves nothing; a document's fields once above them; an Article's one record flat. The caller renders each row.
 */
export default function ReviewList({ model, article, finding, filter, selectedKey, isOpen, onToggle, renderRow }: {
  model: RailModel
  article: boolean
  /** Before discovery: the one block that becomes the list. */
  finding: boolean
  filter: ValueFilter
  selectedKey: string | null
  isOpen: (record: RailRecord) => boolean
  onToggle: (record: RailRecord) => void
  renderRow: (row: RailRow, pinned: boolean) => ReactNode
}) {
  const rowsOf = (rows: readonly RailRow[]) => rows.flatMap((row) => {
    const passes = passesFilter(row, filter)
    return passes || row.key === selectedKey ? [<div key={row.key}>{renderRow(row, !passes)}</div>] : []
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
  return (
    <div className="flex flex-col gap-2">
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
              className="flex h-9.5 w-full cursor-pointer items-center gap-1.5 px-2.5 text-left outline-none hover:bg-accent-ghost focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default">
              <DisclosureGlyph open={open} />
              <b className="min-w-10 truncate text-content text-ink">{record.label}</b>
              <span className="min-w-0 truncate text-secondary text-ink-muted">Record {record.index + 1}{record.page === null ? '' : ` · p.${record.page}`}</span>
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
