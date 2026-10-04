import type { ReactNode, Ref } from 'react'
import type { RailCounts, ValueFilter } from './reviewVocabulary'
import type { StatusLine } from './resultsHeaderCopy'
import { Button, Pill } from './ui'
import { ApprovedGlyph, InfoGlyph, ListGlyph, MoreGlyph, OneByOneGlyph, RejectedGlyph, SpinnerGlyph } from './ui/icons'

const iconButton = 'inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-ink-muted outline-none hover:bg-surface-muted hover:text-ink focus-visible:ring-2 focus-visible:ring-accent aria-expanded:bg-surface-muted aria-expanded:text-ink'
const linkButton = 'cursor-pointer rounded px-1 text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent'

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
  /** "One by one": disabled with its reason as title, or null when enabled. */
  oneByOne: { disabled: string | null } | null
  /** "Approve rest…", or in its place "Save review". */
  approveRest: { disabled: string | null; expanded: boolean } | null
  saveReview: boolean
  /** In one-by-one the two give way to "List". */
  list: boolean
}

/**
 * The rail's one header, the same in every phase (results review redesign §2): the status line, a transient alert
 * line, the count block and the filter chips (a select at 264px, §9).
 */
export default function ResultsHeader({
  status, extras, schemaNote, alert, counts, running, readOnlyNote, actions, breakdown, chips, filter, onFilter,
  detailsOpen, menuOpen, detailsRef, menuRef, exportButton, onDetails, onMenu, onSchema, onWhy, onShowDetails,
  onOneByOne, onApproveRest, onSaveReview, onList,
}: {
  status: StatusLine
  extras?: ReactNode
  schemaNote?: { revision: number; current: number } | null
  alert?: ReactNode
  counts: RailCounts
  running: boolean
  /** In the saved and read-only states the number line gives way to this note; null hides the count's number line. */
  readOnlyNote: string | null | undefined
  actions: HeaderActions
  breakdown: ReactNode
  chips: boolean
  filter: ValueFilter
  onFilter: (filter: ValueFilter) => void
  detailsOpen: boolean
  menuOpen: boolean
  detailsRef?: Ref<HTMLButtonElement>
  menuRef?: Ref<HTMLButtonElement>
  exportButton?: ReactNode
  onDetails: () => void
  onMenu: () => void
  onSchema: () => void
  onWhy: () => void
  onShowDetails: () => void
  onOneByOne: () => void
  onApproveRest: () => void
  onSaveReview: () => void
  onList: () => void
}) {
  const fraction = (count: number) => counts.required === 0 ? 0 : count / counts.required * 100
  const chipList: Array<{ value: ValueFilter; label: string; count?: number }> = [
    { value: 'check', label: 'To check' },
    { value: 'doubt', label: 'Doubtful', count: counts.doubtful },
    { value: 'notrev', label: 'Not reviewable', count: counts.notReviewable },
    { value: 'all', label: 'All' },
  ]
  return (
    <div className="@container flex shrink-0 flex-col gap-2.5 border-b border-line bg-surface px-3 pt-1 pb-2.5">
      <div className="flex min-h-8 items-center gap-1.5 text-secondary">
        <Mark mark={status.mark} />
        <p role="status" aria-atomic="true" className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-1" title={status.title}>
          <b className="text-content text-ink">{status.word}</b>
          {status.rest && <span className="text-ink-muted tabular-nums">{status.mark === 'completed'
            ? <><span className="@max-[344px]:hidden">{status.rest}</span><span className="hidden @max-[344px]:inline">{status.rest.replace(/^· Catalog /, '').replace(/ ·$/, '')}</span></>
            : status.rest}</span>}
          {status.schemaRevision !== undefined && <button type="button" className={`${linkButton} @max-[344px]:hidden`} onClick={onSchema}>Schema rev {status.schemaRevision}</button>}
          {status.why && <button type="button" className={linkButton} onClick={onWhy}>Why?</button>}
        </p>
        {schemaNote && <Pill tone="stale" outline>Rev {schemaNote.revision} · current is {schemaNote.current}</Pill>}
        <span className="flex-1" />
        {extras}
        {exportButton}
        <button ref={detailsRef} type="button" aria-label="Run details" aria-expanded={detailsOpen} className={iconButton} onClick={onDetails}><InfoGlyph /></button>
        <button ref={menuRef} type="button" aria-label="More result actions" aria-haspopup="menu" aria-expanded={menuOpen} className={iconButton} onClick={onMenu}><MoreGlyph /></button>
      </div>
      {status.failure && (
        <p className="-mt-1.5 m-0 text-secondary text-ink-muted">{status.failure} <button type="button" className={linkButton} onClick={onShowDetails}>Show details</button></p>
      )}
      {schemaNote && (
        <p className="-mt-1.5 m-0 text-secondary text-ink-muted">
          This review applies to Schema revision {schemaNote.revision}. Run extraction again to use revision {schemaNote.current}; this review stays saved.
        </p>
      )}
      {alert}
      <div>
        <div className="flex flex-wrap items-end gap-2.5">
          <div className="min-w-40 flex-1">
            {readOnlyNote === undefined ? (
              <p className="m-0 mb-1.5 text-secondary text-ink-muted">
                <b className="mr-1 text-display text-ink tabular-nums">{counts.toCheck}</b>{running ? 'to check so far' : 'to check'}
              </p>
            ) : readOnlyNote && <p className="m-0 mb-1.5 text-secondary text-ink-muted">{readOnlyNote}</p>}
            <div role="img" className="flex h-2 overflow-hidden rounded-full bg-line"
              aria-label={`${counts.approved} approved, ${counts.edited} edited, ${counts.rejected} rejected, ${counts.toCheck} to check, of ${counts.required}`}>
              <span className="bg-green" style={{ width: `${fraction(counts.approved)}%` }} />
              <span className="bg-ink-muted" style={{ width: `${fraction(counts.edited)}%` }} />
              <span className="bg-danger" style={{ width: `${fraction(counts.rejected)}%` }} />
            </div>
          </div>
          <div className="flex gap-2 @max-[264px]:w-full @max-[264px]:flex-col">
            {actions.list && (
              <Button size="md" className="h-8 font-semibold" aria-label="Leave one-by-one review, back to the list" onClick={onList}>
                <ListGlyph />List <kbd aria-hidden="true" className="rounded border border-line px-1 font-mono text-compact">Esc</kbd>
              </Button>
            )}
            {actions.oneByOne && (
              <Button size="md" className="h-8 font-semibold" disabled={actions.oneByOne.disabled !== null}
                title={actions.oneByOne.disabled ?? undefined} onClick={onOneByOne}><OneByOneGlyph />One by one</Button>
            )}
            {actions.saveReview ? (
              <Button size="md" variant="outline-positive" className="h-8 font-semibold" onClick={onSaveReview}>Save review</Button>
            ) : actions.approveRest && (
              <Button size="md" variant="outline-positive" className="h-8 font-semibold" aria-expanded={actions.approveRest.expanded}
                disabled={actions.approveRest.disabled !== null} title={actions.approveRest.disabled || undefined} onClick={onApproveRest}>Approve rest…</Button>
            )}
          </div>
        </div>
        <p aria-live="off" className="m-0 mt-1.5 text-compact text-ink-muted tabular-nums">{breakdown}</p>
      </div>
      {chips && (
        <>
          <div role="group" aria-label="Show values" className="scrollbar-subtle flex gap-1.5 overflow-x-auto @max-[264px]:hidden">
            {chipList.map((chip) => (
              <button key={chip.value} type="button" aria-pressed={filter === chip.value} onClick={() => onFilter(chip.value)}
                className="h-7 shrink-0 cursor-pointer rounded-full border border-line px-2.5 text-compact font-semibold whitespace-nowrap text-ink-muted outline-none hover:border-accent/50 focus-visible:ring-2 focus-visible:ring-accent aria-pressed:border-ink aria-pressed:bg-ink aria-pressed:text-canvas">
                {chip.label}{chip.count !== undefined && <span className="ml-1 tabular-nums">{chip.count}</span>}
              </button>
            ))}
          </div>
          <label className="hidden items-center gap-2 text-compact font-semibold text-ink-muted @max-[264px]:flex">
            Show
            <select value={filter} onChange={(event) => onFilter(event.target.value as ValueFilter)}
              className="h-7 flex-1 rounded-md border border-line-strong bg-surface px-1.5 text-compact text-ink">
              {chipList.map((chip) => <option key={chip.value} value={chip.value}>{chip.label}{chip.count !== undefined ? ` (${chip.count})` : ''}</option>)}
            </select>
          </label>
        </>
      )}
    </div>
  )
}
