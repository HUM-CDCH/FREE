import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from 'react'
import { isDecidable, passesFilter, type RailModel, type RailRecord, type RailRow, type ValueFilter } from './reviewVocabulary'
import { ApprovedGlyph, DisclosureGlyph, SpinnerGlyph } from './ui/icons'
import { observeEvidenceHover } from './evidenceHover'
import { Button, Overline } from './ui'
import type { ReviewMove } from './reviewLearning'
import { checkFirst, reviewReason, type QueueItem } from './reviewQueue'
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

/** Says that a kind of reason changed place because of what the researcher decided, in the list and on the next
 *  one-by-one card: never a toast, and with the way to have those values first again. */
export function ReviewMoveLine({ move, onKeep }: { move: ReviewMove; onKeep?: ((reason: string) => void) | undefined }) {
  const one = move.left === 1
  return move.kind === 'returned' ? (
    <p role="status" className="m-0 rounded-md border-l-[3px] border-l-stale bg-stale-soft px-2.5 py-1.5 text-compact text-ink">
      You edited or rejected one, so the <b className="tabular-nums">{move.left}</b> marked “{move.reason}” left {one ? 'comes' : 'come'} first again.
    </p>
  ) : (
    <div role="status" className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 rounded-md bg-surface-muted px-2.5 py-1.5 text-compact text-ink-muted">
      <span>You approved <b className="tabular-nums text-ink">{move.fine}</b> marked “{move.reason}” as they were. The other <span className="tabular-nums">{move.left}</span> {one ? 'is back in its place' : 'are back in their place'}.</span>
      {onKeep && <Button variant="ghost" className="-mx-2.5" onClick={() => onKeep(move.reason)}>Show them first again</Button>}
    </div>
  )
}

const section = 'overflow-hidden rounded-lg border border-line bg-surface'
const NOTHING = <p className="m-0 px-4 pt-1 pb-3 text-secondary text-ink-muted">Nothing in this record for this filter.</p>

/**
 * The list: one component for both phases, records keyed by their index, in reading order while running and
 * document order once settled; a document's fields once above them; an Article's one record flat. The caller renders each row.
 * The values to check first lead the list as one sheet with no heading of its own: a fact about the source stands
 * filled, what an automatic check says is dashed, and one of the rest between them is plain.
 */
export default function ReviewList({
  model, article, finding, filter, selectedKey, linkedKeys, selection, isOpen, onToggle, renderRow, prioritized = [], order, documentRecords = Boolean(order), moves = [], onKeep, children,
}: {
  /** The open value's review, portalled into its row: rendered here it stays one instance wherever that row is shown. */
  children?: ReactNode
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
  /** The values that lead the list, in their sequence: those to check first and the few of the rest among them. */
  prioritized?: readonly QueueItem[]
  /** Whether the values to check first lead (`priority`) or stay in their place, with how many are left and done. */
  order?: { priority: boolean; onToggle: () => void; left: number; done: number }
  /** Whether records follow document order (`index`), independent of whether the priority toggle is shown. */
  documentRecords?: boolean
  /** The kinds of reason that changed place because of what the researcher decided. */
  moves?: readonly ReviewMove[]
  onKeep?: (reason: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  // Subscribe here, not in Results or the workspace. Hover changes only the affected wrappers and collapsed headers;
  // it never renders a value row again. Rebind after React changes the list or opens a record.
  useLayoutEffect(() => observeEvidenceHover(selection, [root.current], true))
  const priorityKeys = new Set(prioritized.map((item) => item.key))
  const render = (row: RailRow, context?: string, tone = '') => {
    const passes = passesFilter(row, filter)
    const linked = linkedKeys.has(row.key)
    return passes || row.key === selectedKey || linked ? [
      <div key={row.key} data-result-key={row.key} data-hover-keys={JSON.stringify([row.key])} data-evidence-linked={linked || undefined}
        className={`${row.key !== selectedKey ? '[&.hovered]:rounded-md [&.hovered]:bg-surface-muted [&.hovered]:shadow-none' : ''} ${linked ? 'rounded-md bg-ev-ghost shadow-[inset_2px_0_0_var(--color-ev)]' : tone}`}>
        {linked && <span className="sr-only">Linked to the selected passage</span>}
        {context && <p className="m-0 px-8 pt-1 text-compact text-ink-muted">{context}</p>}
        {renderRow(row, !passes)}
      </div>,
    ] : []
  }
  const rowsOf = (rows: readonly RailRow[]) =>
    rows.flatMap((row) => priorityKeys.has(row.key) ? [] : render(row))
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
    const lit = hovered?.length === 1 ? hovered[0] : hovered ? undefined : null
    if (key !== lit) selection.hover(key ? [key] : null)
  }
  const records = documentRecords
    ? [...model.records].sort((first, second) => first.index - second.index)
    : model.records
  const first = prioritized.flatMap((item) => {
    const { row } = item
    const place = article ? null : item.record?.label ?? 'Document'
    const reason = row.kind === 'to-check' && checkFirst(row) ? reviewReason(row) : null
    // Amber is the rail's colour for "look again"; the three steps also differ without it: filled with a solid edge,
    // unfilled with a dashed edge, plain.
    const tone = `border-t border-line/60 border-l-[3px] first:border-t-0 ${!reason ? 'border-l-transparent'
      : reason.caveat ? 'border-l-stale [border-left-style:dashed]' : 'border-l-stale bg-stale-soft'}`
    // Its record is said on the row's own name line, so no line of its own stands between two values.
    return render(place ? { ...row, place } : row, undefined, tone)
  })
  const failed = [...model.document, ...model.records.flatMap((record) => record.rows)]
    .flatMap((row) => row.parts?.length ? row.parts : [row]).filter((row) => row.priority === 'failed').length
  const strip = 'flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 px-1 text-compact text-ink-muted'
  return (
    <div ref={root} className="flex flex-col gap-2" onMouseMove={onMouseMove} onMouseLeave={() => selection.hover(null)}>
      {children}
      {order && order.left > 0 && <div className={strip}>
        <span><b className="tabular-nums text-ink">{order.left}</b> to check first, {order.priority ? 'then the rest' : article ? 'below' : 'in their records'}</span>
        <Button variant="ghost" className="-mx-2.5" onClick={order.onToggle}>{order.priority ? 'Show in their place' : 'Show them first'}</Button>
      </div>}
      {order && order.left === 0 && order.done > 0 && model.counts.toCheck > 0 && (
        <p className={`m-0 ${strip}`}><span>First <b className="tabular-nums text-ink">{order.done}</b> checked · <span className="tabular-nums">{model.counts.toCheck}</span> left in the document</span></p>
      )}
      {moves.map((move) => <ReviewMoveLine key={`${move.kind}:${move.reason}`} move={move} onKeep={onKeep} />)}
      {failed > 0 && <p className="m-0 px-1 text-compact text-ink-muted">Automatic checks could not run for {failed} {failed === 1 ? 'value' : 'values'}. That says nothing about {failed === 1 ? 'it' : 'them'}.</p>}
      {first.length > 0 && <section aria-label="Check first" className={section}>{first}</section>}
      {first.length > 0 && <Overline as="h3" className="m-0 px-1 pt-1">The rest, in the document</Overline>}
      {model.document.some((row) => !priorityKeys.has(row.key)) && (
        <section aria-label="Document" className={`${section} p-1`}>
          <h3 className="m-0 px-2 pt-1.5 pb-1 text-content font-bold text-ink">Document</h3>
          {rowsOf(model.document)}
        </section>
      )}
      {article ? (
        <div className={`${section} p-1`}>{records.flatMap((record) => rowsOf(record.rows))}</div>
      ) : records.map((record) => {
        const state = recordState(record)
        const open = record.state !== 'queued' && isOpen(record)
        const remaining = record.rows.filter(row => !priorityKeys.has(row.key))
        const rows = open ? remaining.flatMap(row => render(row)) : []
        return (
          <section key={record.key ?? record.index} aria-label={`${record.label}, ${state.text}`} className={section}>
            <button type="button" aria-expanded={open} disabled={record.state === 'queued'} onClick={() => onToggle(record)}
              data-hover-keys={JSON.stringify(open ? [] : remaining.map(row => row.key))}
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
