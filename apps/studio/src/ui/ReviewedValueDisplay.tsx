import type { SchemaNode } from 'extraction/schema'
import { shownValue } from '../reviewVocabulary'

/** Display the saved value using its producing schema; absent cells stay visible. */
export default function ReviewedValueDisplay({ node, value }: { node: SchemaNode | null; value: unknown }) {
  if (value === null || value === undefined || !node || typeof value !== 'object') {
    return <span className="break-words">{shownValue(value)}</span>
  }
  if (node.type === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>
    return <dl className="m-0 space-y-2 text-content text-ink">
      {node.children.map(child => <div key={child.id}>
        <dt className="font-mono text-compact text-ink-muted">{child.name}</dt>
        <dd className="m-0"><ReviewedValueDisplay node={child} value={fields[child.name]} /></dd>
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
          {node.children.map(child => <td key={child.id} className="border border-line px-2 py-1 align-top">
            <ReviewedValueDisplay node={child} value={item && typeof item === 'object' ? item[child.name] : null} />
          </td>)}
        </tr>)}</tbody>
      </table>
    </div>
    return <ol className="m-0 list-decimal space-y-1 pl-5">
      {value.map((item, index) => <li key={index} className="break-words">{shownValue(item)}</li>)}
    </ol>
  }
  return <span className="break-words">{shownValue(value)}</span>
}
