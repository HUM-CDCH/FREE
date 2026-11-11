import type { Ref } from 'react'
import { createPortal } from 'react-dom'
import type { RailCounts, ValueFilter } from './reviewVocabulary'
import { Button } from './ui'
import { ApprovedGlyph, InfoGlyph, ListGlyph, MoreGlyph, OneByOneGlyph, RejectedGlyph, SpinnerGlyph } from './ui/icons'

const iconButton = 'inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-muted outline-none hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent aria-expanded:bg-surface-muted aria-expanded:text-ink'
const linkButton = 'cursor-pointer rounded px-1 text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent'

export type StatusMark = 'spinner' | 'stopped' | 'failed' | 'completed' | 'incomplete' | 'saved'

/** The status line: a mark, a bold word and a muted rest, by state. */
export type StatusLine = {
  mark: StatusMark
  word: string
  rest: string
  /** Opens the document's latest Extraction while another one is shown. */
  onLatest?: () => void
  /** A failed run's message, on a second line with "Show details". */
  failure?: string
}

function Mark({ mark }: { mark: StatusLine['mark'] }) {
  switch (mark) {
    case 'spinner': return <SpinnerGlyph />
    case 'stopped': return <RejectedGlyph className="text-ink-muted" />
    case 'failed': return <RejectedGlyph />
    case 'saved': return <ApprovedGlyph />
    case 'completed': return <span aria-hidden="true" className="mx-1 size-2 shrink-0 rounded-full bg-green" />
    case 'incomplete': return <span aria-hidden="true" className="mx-1 size-2 shrink-0 rounded-full bg-stale" />
  }
}

export type HeaderActions = {
  /** "Review one by one": disabled with its reason as title, or null when enabled. */
  oneByOne: { disabled: string | null } | null
  /** The finalization action, labelled with the result and decision cut it names; null when it is not offered. */
  saveReview: string | null
  /** In one-by-one the two give way to "List". */
  list: boolean
}

/**
 * The rail's one header, the same in every phase: the status line, the progress bar, and the filter chips (a select where they do not fit) beside the actions. In the rail the
 * status line is drawn in the rail's own header (`slot`).
 */
export default function ResultsHeader({
  status, counts, running, reviewSaved = false, readOnlyNote, actions, chips, filter, onFilter,
  detailsOpen, menuOpen, menuRef, slot = null, onDetails, onMenu, onShowDetails,
  onOneByOne, onSaveReview, onList,
}: {
  status: StatusLine
  counts: RailCounts
  running: boolean
  /** The review of the results shown is saved: said beside the count, whatever the run's own status. */
  reviewSaved?: boolean
  /** In the saved and read-only states the number line gives way to this note; null hides the count's number line. */
  readOnlyNote: string | null | undefined
  actions: HeaderActions
  chips: boolean
  filter: ValueFilter
  onFilter: (filter: ValueFilter) => void
  detailsOpen: boolean
  menuOpen: boolean
  menuRef?: Ref<HTMLButtonElement>
  /** The rail header's free width: the status line and ⓘ ⋯ are drawn there, leaving the panel to the values. */
  slot?: HTMLElement | null
  onDetails: () => void
  onMenu: () => void
  onShowDetails: () => void
  onOneByOne: () => void
  onSaveReview: () => void
  onList: () => void
}) {
  const fraction = (count: number) => counts.required === 0 ? 0 : count / counts.required * 100
  const checked = counts.approved + counts.edited + counts.rejected
  const progress = `of ${checked + counts.toCheck} checked${running ? ' so far' : ''}${reviewSaved ? ' · review saved' : ''}`
  // A filter with nothing behind it is not offered, unless it is the one in use.
  const chipList = ([
    { value: 'check', label: 'To check' },
    { value: 'doubt', label: 'Uncertain', count: counts.doubtful },
    { value: 'notrev', label: 'Not reviewable', count: counts.notReviewable },
    { value: 'all', label: 'All' },
  ] satisfies Array<{ value: ValueFilter; label: string; count?: number }>).filter((chip) => chip.count !== 0 || chip.value === filter)
  // The header's content width under which the chips no longer share a line with "Review one by one": the select
  // stands in.
  const [chipsNarrow, selectNarrow] = chipList.length <= 2 ? ['@max-[280px]:hidden', '@max-[280px]:block']
    : chipList.length === 3 ? ['@max-[400px]:hidden', '@max-[400px]:block'] : ['@max-[492px]:hidden', '@max-[492px]:block']
  // Neither text shrinks: where the two do not fit a line the count takes the next, so they never overlap.
  const statusLine = (
    <>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
        <div className="flex items-center gap-1.5 text-secondary">
          <Mark mark={status.mark} />
          <p role="status" aria-atomic="true" className="m-0 flex flex-wrap items-baseline gap-x-1">
            <b className="text-content text-ink">{status.word}</b>
            {status.rest && <span className="text-ink-muted tabular-nums">{status.rest}</span>}
            {status.onLatest && <button type="button" className={linkButton} onClick={status.onLatest}>Open latest</button>}
          </p>
        </div>
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 text-compact text-ink-muted">
          {readOnlyNote === undefined
            ? <span className="tabular-nums"><b className="mr-1 text-ink">{checked}</b>{progress}</span>
            : <>{readOnlyNote && <span>{readOnlyNote}</span>}<span className="tabular-nums">{checked} {progress}</span></>}
        </p>
      </div>
      <button type="button" aria-label="Run details" aria-expanded={detailsOpen} className={iconButton} onClick={onDetails}><InfoGlyph /></button>
      <button ref={menuRef} type="button" aria-label="More result actions" aria-haspopup="menu" aria-expanded={menuOpen} className={iconButton} onClick={onMenu}><MoreGlyph /></button>
    </>
  )
  return (
    <div className="@container flex shrink-0 flex-col gap-2 border-b border-line bg-surface px-3 py-2">
      {slot ? createPortal(statusLine, slot) : <div className="flex min-h-8 items-center gap-1">{statusLine}</div>}
      {status.failure && (
        <p className="m-0 text-secondary text-ink-muted">{status.failure} <button type="button" className={linkButton} onClick={onShowDetails}>Show details</button></p>
      )}
      <div role="img" className="flex h-1.5 shrink-0 overflow-hidden rounded-full bg-line"
        aria-label={`${counts.approved} approved, ${counts.edited} edited, ${counts.rejected} rejected, ${counts.toCheck} to check, of ${counts.required}`}>
        <span className="bg-green" style={{ width: `${fraction(counts.approved)}%` }} />
        <span className="bg-ink-muted" style={{ width: `${fraction(counts.edited)}%` }} />
        <span className="bg-danger" style={{ width: `${fraction(counts.rejected)}%` }} />
      </div>
      {/* The filters and the review's actions share a line; the actions take the next where the rail is narrow. */}
      <div className="flex flex-wrap items-center gap-2">
        {chips && (
          <>
            <div role="group" aria-label="Show values" className={`scrollbar-subtle flex min-w-0 grow gap-1.5 overflow-x-auto ${chipsNarrow}`}>
              {chipList.map((chip) => (
                <button key={chip.value} type="button" aria-pressed={filter === chip.value} onClick={() => onFilter(chip.value)}
                  className="h-6 shrink-0 cursor-pointer rounded-full border border-line px-2.5 text-compact font-semibold whitespace-nowrap text-ink-muted outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-canvas">
                  {chip.label}{chip.count !== undefined && <span className="ml-1 tabular-nums">{chip.count}</span>}
                </button>
              ))}
            </div>
            {/* Narrow enough to share the line with "Review one by one" down to the 264px rail. */}
            <select aria-label="Show" value={filter} onChange={(event) => onFilter(event.target.value as ValueFilter)}
              className={`hidden h-8 min-w-16 flex-1 rounded-md border border-line-strong bg-surface px-1.5 text-compact text-ink ${selectNarrow}`}>
              {chipList.map((chip) => <option key={chip.value} value={chip.value}>{chip.label}{chip.count !== undefined ? ` (${chip.count})` : ''}</option>)}
            </select>
          </>
        )}
        <div className="flex flex-wrap gap-2 empty:hidden">
          {actions.list && (
            <Button size="md" className="h-8 font-semibold" aria-label="Leave one-by-one review, back to the list" onClick={onList}>
              <ListGlyph />List <kbd aria-hidden="true" className="rounded border border-line px-1 font-mono text-compact">Esc</kbd>
            </Button>
          )}
          {actions.oneByOne && (
            // Checking each value against its source is the review's main action: filled while any is left.
            <Button size="md" variant={actions.oneByOne.disabled === null ? 'positive' : 'secondary'} className="h-8 font-semibold"
              disabled={actions.oneByOne.disabled !== null}
              title={actions.oneByOne.disabled ?? undefined}
              onClick={onOneByOne}><OneByOneGlyph />Review one by one</Button>
          )}
          {actions.saveReview && (
            <Button size="md" variant={actions.oneByOne?.disabled === null ? 'outline-positive' : 'positive'} className="h-8 font-semibold" onClick={onSaveReview}>{actions.saveReview}</Button>
          )}
        </div>
      </div>
    </div>
  )
}
