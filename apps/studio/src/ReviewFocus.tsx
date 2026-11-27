import DisagreementChoice from './DisagreementChoice'
import type { Ref } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { ReviewMove } from './reviewLearning'
import { checkFirst, forwardItems, reviewReason, type QueueItem } from './reviewQueue'
import { type ReviewAction, fieldWords, rowText, stateLabel, reviewedValueSummary, type RailRow } from './reviewVocabulary'
import { Button, Overline } from './ui'
import { ReviewMoveLine } from './ReviewList'
import { ApprovedGlyph, DoubtGlyph, EditedGlyph, EvidenceGlyph, RejectedGlyph, UndoGlyph } from './ui/icons'
import ReviewedValueEditor from './ui/ReviewedValueEditor'
import ReviewedValueDisplay, { type PartPick } from './ui/ReviewedValueDisplay'

const Kbd = ({ children }: { children: string }) =>
  <kbd aria-hidden="true" className="rounded border border-current/30 px-1 font-mono text-compact font-normal opacity-80">{children}</kbd>

/**
 * One by one: the same rail as a card for the current value: where the researcher is and why this value comes now,
 * its Evidence, the decision and what comes next.
 */
export default function ReviewFocus({ article, queue, blocked, current, part, recordLabel, editing, node,
  headingRef, onDecide, onChoose, onEdit, onCancelEdit, onUndo, onNext, onPrevious, onGo, onTypedEdit, pick, order, notice, onKeep, canApproveWhole = true, canUndoWhole = true, locked = false }: {
  article: boolean
  queue: readonly QueueItem[]
  blocked: ReadonlySet<string>
  order?: { priority: boolean; onToggle: () => void }
  /** A kind of reason changed place because of what the researcher decided: said once, on this card. */
  notice?: ReviewMove | null
  onKeep?: (reason: string) => void
  current: RailRow
  part?: { key: string; name: string; value: unknown }
  recordLabel: string
  editing: boolean
  node: SchemaNode | null
  headingRef: Ref<HTMLHeadingElement>
  onDecide: (action: ReviewAction, value?: unknown) => void
  onChoose?: (choices: { path: string[]; value: unknown }[]) => void
  onEdit: () => void
  onCancelEdit: () => void
  onUndo: () => void
  onNext: () => void
  onPrevious: () => void
  onGo: (key: string) => void
  onTypedEdit?: (value: unknown) => void
  /** The open value's parts, each pickable to show only its Evidence. */
  pick?: PartPick
  canApproveWhole?: boolean
  canUndoWhole?: boolean
  /** A decision is saving or the review is a saved one: decisions and moves wait, picking a part never does. */
  locked?: boolean
}) {
  const decided = current.kind !== 'to-check'
  const key = part?.key ?? current.key
  const at = queue.findIndex((item) => item.key === key)
  const row = queue[at]?.row ?? current
  const reason = reviewReason(row)
  // A value whose decision is being saved is no longer open: the counts move as the card does.
  const open = (item: QueueItem) => item.row.kind === 'to-check' && !blocked.has(item.ownerKey)
  const left = queue.filter(open)
  const firstLeft = left.filter((item) => checkFirst(item.row))
  const inPlace = Boolean(order && !order.priority)
  // One of the rest, come early among the values checked first.
  const sampled = !inPlace && !reason && Boolean(queue[at]?.early)
  const upNext = forwardItems(queue, key, blocked).slice(0, 3)
  const name = fieldWords(part?.name ?? current.name)
  const trail = article ? name : `${recordLabel} › ${name}`
  const count = (text: string) => <span className="font-normal tabular-nums text-ink-muted">{text}</span>
  return (
    <div className="flex flex-col gap-3.5 bg-surface px-4 pt-3.5 pb-4.5">
      <div className="flex flex-col gap-2">
        {notice && <ReviewMoveLine move={notice} onKeep={onKeep} />}
        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 text-compact">
          {inPlace ? <>
            <span className="font-semibold text-ink">In the document {count(`· ${left.length} left`)}</span>
            {/* It moves to another value, so it waits for an open edit as it does for a save. It starts where that
                order does, on the strongest reason: the document may meet a weaker one first. */}
            {firstLeft.length > 0 && <Button variant="ghost" className="-mx-2.5" disabled={locked || editing} onClick={() => {
              order!.onToggle()
              const first = firstLeft.reduce((best, item) => reviewReason(item.row)!.rank < reviewReason(best.row)!.rank ? item : best)
              if (first.key !== key) onGo(first.key)
            }}>Start with the {firstLeft.length} to check first</Button>}
          </> : firstLeft.length > 0 ? <>
            <span className="font-bold text-ink">Check first {count(`· ${left.length} left in all`)}</span>
            {order && <Button variant="ghost" className="-mx-2.5" onClick={order.onToggle}>Follow the document instead</Button>}
          </> : (
            <span className="font-semibold tabular-nums text-ink-muted">{!sampled && queue.some((item) => reviewReason(item.row)) ? `The rest, in the document · ${left.length} left` : `${left.length} left to check`}</span>
          )}
        </div>
        {/* Why this value, now: a fact about the source stands filled; what an automatic check says is dashed and
            carries how far to trust it; a reason that no longer comes first is still said, plainly. */}
        {reason && !decided && (
          <div className={`flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-compact ${inPlace || !checkFirst(row) ? 'border border-line'
            : reason.caveat ? 'border-l-[3px] border-l-stale [border-left-style:dashed]' : 'border-l-[3px] border-l-stale bg-stale-soft'}`}>
            <DoubtGlyph />
            <p className="m-0 min-w-0"><b className="text-ink">{reason.text}.</b> <span className="text-ink-muted">{reason.advice}</span></p>
          </div>
        )}
        {sampled && !decided && (
          <p className="m-0 rounded-md border border-line px-2.5 py-1.5 text-compact text-ink-muted">
            <b className="font-semibold text-ink">From the rest of the document.</b> Nothing unusual here. A few come early so you can see how the rest reads.
          </p>
        )}
      </div>
      <div>
        <p className="m-0 mb-1 flex items-baseline gap-1.5 text-secondary text-ink-faint">
          {current.link && <span aria-hidden="true" className="size-2 shrink-0 rounded-sm bg-ev" />}
          <span className="min-w-0 [overflow-wrap:anywhere] first-letter:uppercase">{trail}</span>
        </p>
        {editing ? (
          <fieldset disabled={locked} className="m-0 min-w-0 border-0 p-0">
            <ReviewedValueEditor node={node} initial={current.value} tall onCancel={onCancelEdit}
              onTypedSave={onTypedEdit}
              saveLabel="Save and next" onSave={(value) => onDecide('EDITED', value)} />
          </fieldset>
        ) : (
          <>
            <h2 ref={headingRef} tabIndex={-1} className="m-0 text-display font-bold break-words text-ink outline-none">{part ? rowText({ value: part.value }) : current.value && typeof current.value === 'object' ? reviewedValueSummary(node, current.value) : rowText(current)}</h2>
            {current.value !== null && typeof current.value === 'object' && <ReviewedValueDisplay node={node} value={current.value} path={current.resultPath} pick={pick} />}
          </>
        )}
        {current.changed && <p className="m-0 mt-1 text-secondary text-stale-ink">Changed since you checked it, please check again</p>}
        {current.kind === 'edited' && <p className="m-0 mt-1 text-secondary text-ink-muted [overflow-wrap:anywhere]">Original: <s>{rowText({value: current.extracted, disagreement: current.disagreement})}</s></p>}
      </div>
      {decided && !current.link && <p className="m-0 text-compact text-ink-muted">{current.kind === 'edited' ? 'No source linked.' : 'Source not found'}</p>}
      {current.page !== null && <p className="m-0 flex items-center gap-1 text-compact font-semibold text-ink"><EvidenceGlyph />Page {current.page}</p>}
      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-3.5 border-0 p-0">
        {!decided && !editing && current.disagreement && onChoose && <DisagreementChoice parts={current.disagreement} onChoose={onChoose}/>}
        {!decided && !editing && (
          <div className="grid grid-cols-2 gap-2">
            {canApproveWhole && !current.disagreement && <Button variant="outline-positive" size="md" className="col-span-2 h-11" onClick={() => onDecide('APPROVED')}>
              <ApprovedGlyph className="text-current" />{pick?.parts.size ? 'Approve value' : 'Approve'} and next <Kbd>A</Kbd>
            </Button>}
            <Button size="md" className="h-11 @max-[264px]:col-span-1" onClick={onEdit}><EditedGlyph className="text-current" />Edit <Kbd>E</Kbd></Button>
            <Button variant="outline-danger" size="md" className="h-11" onClick={() => onDecide('REJECTED')}><RejectedGlyph className="text-current" />Reject <Kbd>R</Kbd></Button>
          </div>
        )}
        {decided && (
          <div className="flex items-center gap-2 rounded-md bg-surface-muted px-3 py-2.5">
            <b className="text-content text-ink">{stateLabel(current)}</b>
            <span className="flex-1" />
            {canUndoWhole && <Button onClick={onUndo}><UndoGlyph />Undo</Button>}
          </div>
        )}
        <div className="flex items-center justify-between">
          <Button onClick={onPrevious}><Kbd>K</Kbd>Previous</Button>
          <Button onClick={onNext}>{decided ? 'Next to check' : 'Skip'} <Kbd>J</Kbd></Button>
        </div>
      </fieldset>
      <div>
        <Overline as="p" className="m-0 mb-1 block">Up next</Overline>
        {upNext.length === 0 ? <p className="m-0 text-secondary text-ink-muted">This is the last one.</p> : upNext.map((item) => {
          // The value first, so it is never the part cut off; then where it is, and one or two words on why it is next.
          const next = checkFirst(item.row) ? reviewReason(item.row) : null
          const place = `${item.record && !article ? `${item.record.label} › ` : ''}${fieldWords(item.row.name)}`
          const cue = next?.short ?? (item.row.chip?.style === 'rule' ? 'matched by rule' : item.row.page === null ? '' : `p.${item.row.page}`)
          return (
            <button key={item.key} type="button" disabled={locked || editing} onClick={() => onGo(item.key)}
              className="flex w-full cursor-pointer items-baseline justify-between gap-2 rounded border-0 bg-transparent px-0 py-0.5 text-left text-secondary outline-none hover:bg-surface-muted focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default">
              <span className="min-w-0 truncate"><span className="font-medium text-ink">{rowText(item.row)}</span> · <span className="text-ink-faint first-letter:uppercase">{place}</span></span>
              {cue && <span className="shrink-0 text-compact text-ink-muted">{cue}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
