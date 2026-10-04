import type { Ref } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { ReviewDecisionAction, ReviewDecisionInput } from '../shared/extraction.contract'
import type { EvidenceQuote } from './evidenceQuote'
import { linkOrigin } from './claimStates'
import { DECISION_WORD, groundingDetail, shownValue, stateLabel, type RailRow } from './reviewVocabulary'
import {
  ApprovedGlyph, ContestedGlyph, DoubtGlyph, EditedGlyph, EvidenceGlyph, MissingGlyph, NotReviewableGlyph, OneByOneGlyph,
  RejectedGlyph, SpinnerGlyph, ToCheckGlyph, UndoGlyph,
} from './ui/icons'
import { Button } from './ui'
import ReviewedValueEditor from './ui/ReviewedValueEditor'

function RowGlyph({ row }: { row: RailRow }) {
  switch (row.kind) {
    case 'to-check': return <ToCheckGlyph />
    case 'approved': return <ApprovedGlyph />
    case 'edited': return <EditedGlyph />
    case 'rejected': return <RejectedGlyph />
    case 'missing': return <MissingGlyph />
    case 'contested': return <ContestedGlyph />
    case 'checking': return <SpinnerGlyph className="size-3.5 text-ink-faint" />
    case 'reading': case 'queued': return <span className="size-4" />
    default: return <NotReviewableGlyph />
  }
}

const chipStyles = {
  link: 'border-transparent bg-ev-ghost text-ink',
  rule: 'border-dotted border-ev bg-ev-ghost text-ink',
  doubtful: 'border-dashed border-ev bg-ev-ghost text-ink',
  neutral: 'border-transparent bg-surface-muted text-ink-muted',
} as const
const markStyles = { link: 'border-solid', rule: 'border-dotted', doubtful: 'border-dashed', neutral: 'border-solid' } as const

const grid = 'grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-md px-2 py-1.5 text-left'

/** A row while the run reads (§3.2, §5.2): the review row's height, a placeholder or a muted candidate, never a value. */
function ProgressRow({ row }: { row: RailRow }) {
  return (
    <div className={`${grid} animate-fadeup`}>
      <span className="flex h-4.5 items-center"><RowGlyph row={row} /><span className="sr-only">{stateLabel(row)}</span></span>
      <span className="min-w-0">
        <span className="block truncate font-mono text-compact text-ink-faint">{row.name}</span>
        {row.kind === 'checking'
          ? <span className="line-clamp-2 text-content font-medium text-ink-faint italic" title="Candidate · being checked against the source">{shownValue(row.value)}</span>
          : <span role="img" aria-label={row.kind === 'reading' ? 'Reading' : 'Queued'} className="mt-1 block h-3 w-24 rounded-sm bg-line motion-safe:animate-pulse" />}
      </span>
      {row.kind === 'checking' ? <span className="h-5.5 text-compact font-medium text-ink-muted">checking</span> : <span />}
    </div>
  )
}

export type ReviewRowProps = {
  row: RailRow
  selected: boolean
  pinned: boolean
  rowRef?: Ref<HTMLButtonElement>
  onSelect: () => void
  quote: EvidenceQuote | null
  /** Decisions are open here: not saved, not saving, not a read-only attempt. */
  canDecide: boolean
  saved: boolean
  /** This is the last value to check and its decision saves the review (§3.3 item 5). */
  last: boolean
  editing: boolean
  node: SchemaNode | null
  onDecide: (action: ReviewDecisionAction, value?: ReviewDecisionInput['reviewedValue']) => void
  onEdit: () => void
  onCancelEdit: () => void
  onUndo: () => void
  onReviewFromHere?: () => void
  onTypedEdit?: (value: unknown) => void
}

/** One value (results review redesign §3.2), and when selected its expansion (§3.3): one tinted surface, no card. */
export default function ReviewRow({ row, selected, pinned, rowRef, onSelect, quote, canDecide, saved, last, editing, node,
  onDecide, onEdit, onCancelEdit, onUndo, onReviewFromHere, onTypedEdit }: ReviewRowProps) {
  if (row.kind === 'reading' || row.kind === 'checking' || row.kind === 'queued') return <ProgressRow row={row} />
  const expansionId = `expansion-${row.key}`
  const linked = row.decision !== null && row.link !== null
  const reviewable = row.retained?.reviewable ?? linked
  const decided = row.kind === 'approved' || row.kind === 'edited' || row.kind === 'rejected'
  const word = row.decision ? DECISION_WORD[row.decision.action] : ''
  const origin = row.link && linkOrigin(row.link) === 'rule' ? 'Linked by rule; no verifier checked it' : 'Verifier-supported'
  const precision = row.link?.precision === 'input' ? ' · located to the whole page only' : row.link?.precision === 'cell' ? ' · a table cell' : ''
  const source = row.retained?.source ?? `${row.kind === 'edited' || row.kind === 'rejected' ? 'Evidence for the extracted value · ' : ''}${row.page === null ? '' : `p.${row.page} · `}${origin}${precision}`
  const style = row.chip?.style ?? 'neutral'
  return (
    <div className={`rounded-md ${selected ? 'bg-accent-ghost shadow-[inset_2px_0_0_var(--color-accent)]' : ''}`}>
      <button ref={rowRef} type="button" aria-expanded={selected} aria-controls={expansionId} onClick={onSelect}
        aria-label={`${stateLabel(row)} ${row.name} ${shownValue(row.value)}${row.chip ? ` ${row.chip.text}` : ''}${pinned ? ', outside the current filter' : ''}${row.changed ? ', changed after you reviewed it' : ''}`}
        className={`${grid} min-h-7.5 cursor-pointer outline-none hover:bg-accent-ghost focus-visible:ring-2 focus-visible:ring-accent animate-fadeup`}>
        <span className="flex h-4.5 items-center"><RowGlyph row={row} /><span className="sr-only">{stateLabel(row)}</span></span>
        <span className="min-w-0">
          <span className="block truncate font-mono text-compact text-ink-faint">{row.name}</span>
          <span className="line-clamp-2 text-content font-medium text-ink" title={shownValue(row.value)}>{shownValue(row.value)}</span>
          {pinned && <span className="block text-compact text-ink-muted italic">outside the current filter</span>}
          {row.changed && <span className="block text-compact text-stale-ink">changed after you reviewed it</span>}
        </span>
        {row.chip && (
          <span className={`inline-flex h-5.5 items-center gap-1 rounded border px-1.5 text-compact whitespace-nowrap ${chipStyles[style]}`}>
            {row.link && <EvidenceGlyph />}{row.chip.text}
          </span>
        )}
      </button>
      {selected && (
        <div id={expansionId} className="flex flex-col gap-2 pr-2 pb-2.5 pl-8.5">
          {row.kind === 'edited' && <p className="m-0 text-secondary text-ink-muted">Extracted value: <s>{shownValue(row.extracted)}</s></p>}
          {linked && (
            <>
              <p className="m-0 flex items-center gap-1 text-compact font-semibold text-ink"><EvidenceGlyph />{source}</p>
              {row.link && row.decision && groundingDetail(row.link, row.kind === 'to-check' ? undefined : row.decision.action) &&
                <p className="m-0 text-compact text-ink-muted">{groundingDetail(row.link, row.kind === 'to-check' ? undefined : row.decision.action)}</p>}
              {quote && row.link?.precision !== 'input' && (
                <p className="m-0 font-serif text-content leading-relaxed text-ink">
                  {quote.before}{quote.hit && <mark className={`border-b-2 border-ev bg-ev-soft text-ink ${markStyles[style]}`}>{quote.hit}</mark>}{quote.after}
                </p>
              )}
              {row.doubt && <p className="m-0 flex items-start gap-1.5 text-secondary text-ink"><DoubtGlyph /><span><b>Doubtful link.</b> {row.doubt}.</span></p>}
            </>
          )}
          {!linked && row.evidence && (
            <>
              <p className="m-0 text-compact font-semibold text-ink">{row.evidence.label}</p>
              <p className="m-0 text-secondary text-ink">{row.evidence.detail}</p>
              {!reviewable && <p className="m-0 text-secondary text-ink-muted">Not part of the review. It stays in the result and the export as extracted.</p>}
            </>
          )}
          {row.retained && <p className="m-0 text-compact text-ink-muted">{row.retained.attribution}</p>}
          {last && !row.retained && row.kind === 'to-check' && !saved && (
            <p className="m-0 rounded-md bg-surface-muted px-2.5 py-2 text-secondary text-ink">
              This is the last value to check. Your decision saves the review, and the review becomes read-only.
            </p>
          )}
          {editing ? (
            <ReviewedValueEditor node={node} initial={row.value} onCancel={onCancelEdit}
              onTypedSave={onTypedEdit}
              saveLabel={last ? 'Save edit and save review' : 'Save edit'} onSave={(value) => onDecide('EDITED', value)} />
          ) : row.kind === 'to-check' && canDecide ? (
            <div className="flex flex-wrap items-center gap-2">
              <div role="group" aria-label={`Decision for ${row.name}`} className="inline-flex h-7.5 overflow-hidden rounded-md border border-line bg-surface">
                <button type="button" onClick={() => onDecide('APPROVED')} className="inline-flex cursor-pointer items-center gap-1.5 px-2.5 text-compact font-semibold text-ink hover:bg-surface-muted">
                  <ApprovedGlyph />{last ? 'Approve and save review' : 'Approve'}</button>
                <button type="button" onClick={onEdit} className="inline-flex cursor-pointer items-center gap-1.5 border-l border-line px-2.5 text-compact font-semibold text-ink hover:bg-surface-muted">
                  <EditedGlyph />Edit</button>
                <button type="button" onClick={() => onDecide('REJECTED')} className="inline-flex cursor-pointer items-center gap-1.5 border-l border-line px-2.5 text-compact font-semibold text-ink hover:bg-surface-muted">
                  <RejectedGlyph />{last ? 'Reject and save review' : 'Reject'}</button>
              </div>
              {onReviewFromHere && (
                <Button variant="ghost" className="ml-auto @max-[300px]:ml-0 @max-[300px]:basis-full" onClick={onReviewFromHere}><OneByOneGlyph />Review from here</Button>
              )}
            </div>
          ) : decided && saved ? (
            <p className="m-0 text-secondary font-semibold text-ink">{word} · saved</p>
          ) : decided && canDecide ? (
            <div className="flex items-center gap-2">
              <span className="text-secondary font-semibold text-ink">{word}</span>
              <Button variant="ghost" onClick={onUndo}><UndoGlyph />Undo</Button>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
