import type { Ref } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { ReviewDecisionAction, ReviewDecisionInput } from '../shared/extraction.contract'
import type { EvidenceQuote } from './evidenceQuote'
import type { QueueItem } from './reviewQueue'
import { linkOrigin } from './claimStates'
import { DECISION_WORD, shownValue, stateLabel, type RailRow } from './reviewVocabulary'
import { Button, Overline } from './ui'
import { ApprovedGlyph, DoubtGlyph, EditedGlyph, EvidenceGlyph, RejectedGlyph, ToCheckGlyph, UndoGlyph } from './ui/icons'
import ReviewedValueEditor from './ui/ReviewedValueEditor'

const Kbd = ({ children }: { children: string }) =>
  <kbd aria-hidden="true" className="rounded border border-current/30 px-1 font-mono text-compact font-normal opacity-80">{children}</kbd>

function QueueGlyph({ row }: { row: RailRow }) {
  switch (row.kind) {
    case 'approved': return <ApprovedGlyph />
    case 'edited': return <EditedGlyph />
    case 'rejected': return <RejectedGlyph />
    default: return <ToCheckGlyph />
  }
}

export type EndCard =
  | { kind: 'record'; label: string; line: string; next: { index: number } | null }
  | { kind: 'caught-up'; line: string; next: { index: number } | null }
  | { kind: 'saved'; line: string }

/**
 * One by one (results review redesign §4.3): the same rail as a card for the current value, its record's queue,
 * its Evidence, the decision and what comes next; or, when the queue is exhausted, an end card (§4.5).
 */
export default function ReviewFocus({ article, items, position, current, recordLabel, label, quote, last, editing, node, upNext, end,
  headingRef, onDecide, onEdit, onCancelEdit, onUndo, onNext, onPrevious, onGo, onContinue, onBack, onTypedEdit }: {
  article: boolean
  items: readonly QueueItem[]
  position: { record: number; records: number; at: number; of: number } | null
  current: RailRow | null
  recordLabel: string
  label: string
  quote: EvidenceQuote | null
  last: boolean
  editing: boolean
  node: SchemaNode | null
  upNext: readonly QueueItem[]
  end: EndCard | null
  headingRef: Ref<HTMLHeadingElement>
  onDecide: (action: ReviewDecisionAction, value?: ReviewDecisionInput['reviewedValue']) => void
  onEdit: () => void
  onCancelEdit: () => void
  onUndo: () => void
  onNext: () => void
  onPrevious: () => void
  onGo: (key: string) => void
  onContinue: (index: number) => void
  onBack: () => void
  onTypedEdit?: (value: unknown) => void
}) {
  if (end || !current) {
    const card = end ?? { kind: 'caught-up' as const, line: '', next: null }
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2.5 px-4 py-6 text-center">
        <ApprovedGlyph className="size-10! text-green" />
        <h2 ref={headingRef} tabIndex={-1} className="m-0 text-content font-bold text-ink outline-none">
          {card.kind === 'saved' ? 'Review saved' : card.kind === 'record' ? `${article ? 'Document' : card.label} is checked` : 'You’re caught up'}
        </h2>
        {card.line && <p className="m-0 max-w-75 text-secondary text-ink-muted">{card.line}</p>}
        <div className="flex flex-wrap justify-center gap-2">
          {card.kind !== 'saved' && card.next && (
            <Button variant="outline-positive" size="md" onClick={() => onContinue(card.next!.index)}>{article ? 'Continue checking' : `Continue with record ${card.next.index + 1}`}</Button>
          )}
          {!article && card.kind === 'record' && !card.next && <Button variant="outline-positive" size="md" disabled>Continue with record</Button>}
          <Button size="md" onClick={onBack}>Back to list</Button>
        </div>
      </div>
    )
  }
  const decided = current.kind !== 'to-check'
  const origin = current.link && linkOrigin(current.link) === 'rule' ? 'Linked by rule; no verifier checked it' : 'Verifier-supported'
  const precision = current.link?.precision === 'input' ? ' · located to the whole page only' : current.link?.precision === 'cell' ? ' · a table cell' : ''
  const source = `${current.retained?.source ?? `${current.kind === 'edited' || current.kind === 'rejected' ? 'Evidence for the extracted value · ' : ''}${current.page === null ? '' : `p.${current.page} · `}${origin}`}${precision}`
  const style = current.chip?.style === 'rule' ? 'border-dotted' : current.chip?.style === 'doubtful' ? 'border-dashed' : 'border-solid'
  return (
    <div className="flex flex-col gap-3.5 bg-surface px-4 pt-3.5 pb-4.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <ol aria-label={article ? 'Values in review order' : `Record ${position?.record ?? 1}, values in review order`} className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {items.map((item) => (
            <li key={item.key}>
              <button type="button" aria-current={item.key === current.key ? 'step' : undefined} onClick={() => onGo(item.key)}
                aria-label={`${item.row.name}, ${stateLabel(item.row).toLowerCase()}${item.row.doubt ? ', doubtful link' : ''}`}
                className={`flex size-6 cursor-pointer items-center justify-center rounded border ${item.row.doubt && item.row.kind === 'to-check' ? 'border-dashed border-ev' : 'border-line'} ${item.key === current.key ? 'outline-2 outline-accent' : ''}`}>
                <QueueGlyph row={item.row} />
              </button>
            </li>
          ))}
        </ol>
        <span className="flex-1" />
        {position && <span className="text-compact text-ink-muted tabular-nums">{article ? `${position.at} of ${position.of}` : `Record ${position.record} of ${position.records} · ${position.at} of ${position.of} in this record`}</span>}
      </div>
      <div>
        <p className="m-0 mb-1 font-mono text-secondary text-ink-faint">{article ? current.name : `${label} · ${recordLabel} › ${current.name}`}</p>
        {editing ? (
          <ReviewedValueEditor node={node} initial={current.value} tall onCancel={onCancelEdit}
            onTypedSave={onTypedEdit}
            saveLabel={last ? 'Save edit and save review' : 'Save edit and next'} onSave={(value) => onDecide('EDITED', value)} />
        ) : (
          <h2 ref={headingRef} tabIndex={-1} className="m-0 text-display font-bold break-words text-ink outline-none">{shownValue(current.value)}</h2>
        )}
        {current.changed && <p className="m-0 mt-1 text-secondary text-stale-ink">changed after you reviewed it</p>}
        {current.kind === 'edited' && <p className="m-0 mt-1 text-secondary text-ink-muted">Extracted value: <s>{shownValue(current.extracted)}</s></p>}
      </div>
      <figure className="m-0">
        <figcaption className="mb-1.5 flex items-center gap-1 text-compact font-semibold text-ink"><EvidenceGlyph />{source}</figcaption>
        {quote && current.link?.precision !== 'input' && (
          <blockquote className="m-0 font-serif text-content leading-[1.6] text-ink">
            {quote.before}{quote.hit && <mark className={`border-b-2 border-ev bg-ev-soft text-ink ${style}`}>{quote.hit}</mark>}{quote.after}
          </blockquote>
        )}
      </figure>
      {current.doubt && (
        <div className="flex items-start gap-1.5 rounded-md border border-dashed border-ev px-2.5 py-2 text-secondary text-ink">
          <DoubtGlyph /><span><b>Doubtful link.</b> {current.doubt}. Check that this is the right passage.</span>
        </div>
      )}
      {!decided && last && (
        <p className="m-0 rounded-md bg-surface-muted px-2.5 py-2 text-secondary text-ink">
          This is the last value to check. Your decision saves the review, and the review becomes read-only.
        </p>
      )}
      {!decided && !editing && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="outline-positive" size="md" className="col-span-2 h-11" onClick={() => onDecide('APPROVED')}>
            <ApprovedGlyph className="text-current" />{last ? 'Approve and save review' : 'Approve and next'} <Kbd>A</Kbd>
          </Button>
          <Button size="md" className="h-11 @max-[264px]:col-span-1" onClick={onEdit}><EditedGlyph className="text-current" />Edit <Kbd>E</Kbd></Button>
          <Button variant="outline-danger" size="md" className="h-11" onClick={() => onDecide('REJECTED')}><RejectedGlyph className="text-current" />Reject <Kbd>R</Kbd></Button>
        </div>
      )}
      {decided && (
        <div className="flex items-center gap-2 rounded-md bg-surface-muted px-3 py-2.5">
          <b className="text-content text-ink">{DECISION_WORD[current.decision!.action]}</b>
          <span className="flex-1" />
          <Button onClick={onUndo}><UndoGlyph />Undo this decision</Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <Button onClick={onPrevious}><Kbd>K</Kbd>Previous</Button>
        <Button onClick={onNext}>{decided ? 'Next to check' : 'Skip for now'} <Kbd>J</Kbd></Button>
      </div>
      <div>
        <Overline as="p" className="m-0 mb-1 block">Up next</Overline>
        {upNext.length === 0 ? <p className="m-0 text-secondary text-ink-muted">Nothing else to check after this one.</p> : upNext.map((item) => (
          <div key={item.key} className="flex items-baseline justify-between gap-2 py-0.5 text-secondary">
            <span className="min-w-0 truncate" title={shownValue(item.row.value)}><span className="font-mono text-ink-faint">{item.row.name}</span> · {shownValue(item.row.value)}</span>
            <span className="shrink-0 text-ink-muted">{item.row.doubt ? 'doubtful link' : item.row.chip?.style === 'rule' ? 'linked by rule' : item.row.page === null ? '' : `p.${item.row.page}`}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
