import type { SchemaNode } from 'extraction/schema'
import { partKey, type ValuePart } from '../durableRailModel'
import { shownValue } from '../reviewVocabulary'

/** Picking a part of the shown value: each scalar is a button naming its part (`partKey` of `valueId` and its path). */
export type PartPick = { valueId: string; selected: string | null; parts: ReadonlyMap<string, ValuePart>; onPick: (key: string | null) => void }

/** Display the saved value using its producing schema; absent cells stay visible. With `pick`, `path` is the value's
 *  result path and every scalar in it picks its part; picking the chosen one again chooses the whole value. */
export default function ReviewedValueDisplay({ node, value, path = [], pick }: {
  node: SchemaNode | null; value: unknown; path?: readonly (string | number)[]; pick?: PartPick
}) {
  if (value === null || value === undefined || !node || typeof value !== 'object') {
    if (!pick) return <span className="break-words">{shownValue(value)}</span>
    const key = partKey(pick.valueId, path), part = pick.parts.get(key), selected = pick.selected === key, linked = Boolean(part?.link)
    return <button type="button" aria-pressed={selected} aria-label={part ? `${part.name}: ${shownValue(value)}` : undefined}
      title={linked ? undefined : 'No Evidence linked'}
      onClick={() => pick.onPick(selected ? null : key)}
      className={`block w-full cursor-pointer rounded-sm px-1 text-left break-words outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        selected ? 'bg-ev-soft ring-2 ring-accent' : linked ? 'hover:bg-ev-ghost' : 'text-ink-muted hover:bg-surface-muted'}`}>
      {shownValue(value)}
    </button>
  }
  if (node.type === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>
    return <dl className="m-0 space-y-2 text-content text-ink">
      {node.children.map(child => <div key={child.id}>
        <dt className="font-mono text-compact text-ink-muted">{child.name}</dt>
        <dd className="m-0"><ReviewedValueDisplay node={child} value={fields[child.name]} path={[...path, child.name]} pick={pick} /></dd>
      </div>)}
    </dl>
  }
  if (node.type === 'array' && Array.isArray(value)) {
    if (value.length === 0) return <span>No items</span>
    if (node.children) return <div className="max-w-full overflow-x-auto">
      <table aria-label={node.name} className="w-full border-collapse text-left text-secondary text-ink">
        <thead><tr>{node.children.map(child => <th key={child.id} scope="col"
          className="border border-line bg-surface-muted px-2 py-1 font-semibold">{child.name}</th>)}</tr></thead>
        <tbody>{value.map((item, index) => <tr key={index}>
          {node.children.map(child => <td key={child.id} className={`border border-line align-top ${pick ? 'p-0.5' : 'px-2 py-1'}`}>
            <ReviewedValueDisplay node={child} value={item && typeof item === 'object' ? item[child.name] : null}
              path={[...path, index, child.name]} pick={pick} />
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    return <ol className="m-0 list-decimal space-y-1 pl-5">
      {value.map((item, index) => <li key={index} className="break-words">
        {pick ? <ReviewedValueDisplay node={null} value={item} path={[...path, index]} pick={pick} /> : shownValue(item)}
      </li>)}
    </ol>
  }
  return <span className="break-words">{shownValue(value)}</span>
}
