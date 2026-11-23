import type { SchemaNode } from 'extraction/schema'
import { partKey, type ValuePart } from '../durableRailModel'
import { PART_STATE_WORD, partState, type PartState, type PartsReview } from '../partReview'
import { shownValue } from '../reviewVocabulary'
import Button from './Button'
import { ApprovedGlyph, DoubtGlyph, UndoGlyph } from './icons'

/** Picking a part of the shown value: each scalar is a button naming its part (`partKey` of `valueId` and its path).
 *  With `review`, each part also shows its state and the picked one can be approved on its own. */
export type PartPick = { valueId: string; selected: string | null; parts: ReadonlyMap<string, ValuePart>; onPick: (key: string | null) => void; review?: PartsReview }

const stateOf = (pick: PartPick, part: ValuePart | undefined): PartState | null =>
  part?.reviewable && pick.review ? partState(part, pick.review.wholeApproved, pick.review.document) : null
// Never colour alone: a glyph or a dashed border, and the state in the accessible name.
const stateClass: Record<PartState, string> = {
  'to-check': 'bg-stale-soft text-stale-ink', approved: 'bg-green-soft text-ink',
  unread: '', unrecorded: '' }
const header = 'border border-line px-2 py-1 font-semibold'

function Display({ node, value, path = [], pick }: {
  node: SchemaNode | null; value: unknown; path?: readonly (string | number)[]; pick?: PartPick
}) {
  if (value === null || value === undefined || !node || typeof value !== 'object') {
    if (!pick) return <span className="break-words">{shownValue(value)}</span>
    const key = partKey(pick.valueId, path), part = pick.parts.get(key), selected = pick.selected === key, linked = Boolean(part?.link)
    const state = stateOf(pick, part)
    return <button type="button" aria-pressed={selected}
      aria-label={part ? `${part.name}: ${shownValue(value)}${state && state !== 'unread' ? `, ${PART_STATE_WORD[state].toLowerCase()}` : ''}` : undefined}
      title={linked ? undefined : 'Source not found'}
      onClick={() => pick.onPick(selected ? null : key)}
      className={`flex w-full cursor-pointer items-start gap-1 rounded-sm px-1 text-left break-words outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        state ? stateClass[state] : ''} ${selected ? 'bg-ev-soft ring-2 ring-accent' : linked ? 'hover:bg-ev-ghost' : state && state !== 'unread' ? '' : 'text-ink-muted hover:bg-surface-muted'}`}>
      {state === 'approved' && <ApprovedGlyph />}{state === 'to-check' && <DoubtGlyph />}
      <span className="min-w-0">{shownValue(value)}</span>
    </button>
  }
  if (node.type === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>
    return <dl className="m-0 space-y-2 text-content text-ink">
      {node.children.map(child => <div key={child.id}>
        <dt className="truncate font-mono text-compact text-ink-muted" title={child.name}>{child.name}</dt>
        <dd className="m-0"><Display node={child} value={fields[child.name]} path={[...path, child.name]} pick={pick} /></dd>
      </div>)}
    </dl>
  }
  if (node.type === 'array' && Array.isArray(value)) {
    if (value.length === 0) return <span>No items</span>
    if (node.children) {
      // The picked cell's row and column, so the cell is found again by its headers.
      const at = pick?.selected ? pick.parts.get(pick.selected)?.path : undefined
      const here = at && path.every((step, index) => at[index] === step) ? at : undefined
      const on = (lit: boolean) => lit ? 'bg-ev-soft text-ink' : 'bg-surface-muted'
      return <div className="max-w-full overflow-x-auto">
        <table aria-label={node.name} className="w-full border-collapse text-left text-secondary text-ink">
          <thead><tr>{pick && <td className="border border-line bg-surface-muted" />}{node.children.map(child => <th key={child.id} scope="col"
            className={`${header} ${on(here?.[path.length + 1] === child.name)}`}>{child.name}</th>)}</tr></thead>
          <tbody>{value.map((item, index) => <tr key={index}>
            {pick && <th scope="row" className={`${header} text-right text-ink-muted tabular-nums ${on(here?.[path.length] === index)}`}>{index + 1}</th>}
            {node.children.map(child => <td key={child.id} className={`border border-line align-top ${pick ? 'p-0.5' : 'px-2 py-1'}`}>
              <Display node={child} value={item && typeof item === 'object' ? item[child.name] : null}
                path={[...path, index, child.name]} pick={pick} />
            </td>)}
          </tr>)}</tbody>
        </table>
      </div>
    }
    return <ol className="m-0 list-decimal space-y-1 pl-5">
      {value.map((item, index) => <li key={index} className="break-words">
        {pick ? <Display node={null} value={item} path={[...path, index]} pick={pick} /> : shownValue(item)}
      </li>)}
    </ol>
  }
  return <span className="break-words">{shownValue(value)}</span>
}

/** How the parts stand, and the picked part with its own decision. */
function PartsReviewPanel({ pick, review }: { pick: PartPick; review: PartsReview }) {
  const parts = [...pick.parts.values()]
  const counts = (['to-check', 'approved'] as const)
    .map(state => ({ state, count: parts.filter(part => stateOf(pick, part) === state).length })).filter(each => each.count > 0)
  const part = pick.selected ? pick.parts.get(pick.selected) : undefined
  const state = stateOf(pick, part)
  return <>
    {counts.length > 0 && <p className="m-0 flex flex-wrap gap-x-3 gap-y-0.5 text-compact text-ink-muted">
      {counts.map(({ state, count }) => <span key={state} className="inline-flex items-center gap-1">
        <span aria-hidden="true" className={`size-2.5 rounded-sm ${stateClass[state]}`} />{count} {PART_STATE_WORD[state].toLowerCase()}
      </span>)}
    </p>}
    {part && state && <div role="group" aria-label={`Decision for ${part.name}`} className="flex flex-col gap-1.5 rounded-md border border-line bg-surface p-2">
      <p className="m-0 text-compact text-ink-faint [overflow-wrap:anywhere]">{part.name}</p>
      <p className="m-0 text-content font-medium text-ink [overflow-wrap:anywhere]">{shownValue(part.value)}</p>
      <div className="flex flex-wrap items-center gap-2">
        {state === 'approved' ? <>
          <span className="text-secondary font-semibold text-ink">Approved</span>
          {review.open && <Button variant="ghost" onClick={() => review.onApproval(part, false)}><UndoGlyph />Undo approval</Button>}
        </> : review.open ? <>
          {state === 'unrecorded' && <span className="text-compact text-ink-muted">{PART_STATE_WORD[state]}</span>}
          <Button variant="outline-positive" onClick={() => review.onApproval(part, true)}><ApprovedGlyph className="text-current" />{review.advance ? 'Approve and next' : 'Approve'}</Button>
          <span className="text-compact text-ink-muted">Approves only this cell</span>
        </> : <span className="text-secondary text-ink-muted">{PART_STATE_WORD[state]}</span>}
      </div>
    </div>}
  </>
}

/** Display the saved value using its producing schema; absent cells stay visible. With `pick`, `path` is the value's
 *  result path and every scalar in it picks its part; picking the chosen one again chooses the whole value. */
export default function ReviewedValueDisplay(props: {
  node: SchemaNode | null; value: unknown; path?: readonly (string | number)[]; pick?: PartPick
}) {
  const review = props.pick?.review
  if (!review) return <Display {...props} />
  return <div className="flex flex-col gap-2"><Display {...props} /><PartsReviewPanel pick={props.pick!} review={review} /></div>
}
