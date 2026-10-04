import { useId, useState } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { ReviewDecisionInput } from '../../shared/extraction.contract'
import { parseReviewedValue } from '../reviewDecisions'
import { ApprovedGlyph } from './icons'
import { schemaNodesToZod } from 'extraction/schema'

const control = 'w-full rounded-md border border-line-strong bg-surface px-2 text-content text-ink outline-none focus-visible:border-accent'

/** The text a value is edited from: a list of scalars as comma-separated text. */
const editableText = (value: unknown) =>
  value === null || value === undefined ? '' : Array.isArray(value) ? value.map(String).join(', ') : String(value)

/**
 * The typed editor of a reviewed value (results review redesign §3.5): a select for allowed values and booleans,
 * a date or number input by type, text otherwise. Enter saves, Escape cancels; an empty value is refused ("to remove a
 * value, Reject"), and a value the schema refuses keeps editing with its reason.
 */
export default function ReviewedValueEditor({ node, initial, saveLabel, tall = false, onSave, onTypedSave, onCancel }: {
  node: SchemaNode | null
  initial: unknown
  saveLabel: string
  tall?: boolean
  onSave: (value: ReviewDecisionInput['reviewedValue']) => void
  /** Retained corrections use the complete producing type, including composites. */
  onTypedSave?: (value: unknown) => void
  onCancel: () => void
}) {
  const id = useId()
  const composite = Boolean(onTypedSave && (node?.type === 'array' || node?.type === 'object'))
  const [draft, setDraft] = useState(() => composite ? JSON.stringify(initial, null, 2) : editableText(initial))
  const [error, setError] = useState<string | null>(null)
  const height = tall ? 'h-10' : 'h-8'
  function save() {
    if (onTypedSave && node) {
      try {
        const value = composite ? JSON.parse(draft) : parseReviewedValue(node, draft).value
        if (!schemaNodesToZod([node]).safeParse({[node.name]: value}).success) {
          setError('The value does not fit its producing field.'); return
        }
        onTypedSave(value); return
      } catch { setError('Enter valid JSON for this field.'); return }
    }
    if (draft.trim() === '') { setError('Enter a value.'); return }
    const parsed = parseReviewedValue(node, draft)
    if (parsed.error) { setError(parsed.error); return }
    onSave(parsed.value)
  }
  const keys = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' && !composite) { event.preventDefault(); save() }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
  }
  const common = { id, autoFocus: true, onKeyDown: keys, value: draft, 'aria-invalid': error !== null || undefined,
    'aria-describedby': error ? `${id}-error` : undefined, className: `${control} ${height}` }
  const type = node?.type === 'array' && node.itemType ? node.itemType : node?.type
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-compact font-semibold text-ink-muted">Reviewed value</label>
      {composite ? (
        <textarea {...common} className={`${control} min-h-24 py-2 font-mono`} onChange={event => {setDraft(event.target.value);setError(null)}} />
      ) : node?.allowedValues ? (
        <select {...common} onChange={(event) => setDraft(event.target.value)}>
          {!node.allowedValues.includes(draft) && <option value={draft}>{draft}</option>}
          {node.allowedValues.map((option) => <option key={option}>{option}</option>)}
        </select>
      ) : type === 'boolean' && node?.type !== 'array' ? (
        <select {...common} onChange={(event) => setDraft(event.target.value)}>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        <input {...common} name="reviewed-value" autoComplete="off"
          type={node?.type === 'array' ? 'text' : type === 'date' ? 'date' : type === 'number' || type === 'integer' ? 'number' : 'text'}
          step={type === 'integer' && node?.type !== 'array' ? 1 : undefined}
          onChange={(event) => { setDraft(event.target.value); setError(null) }} />
      )}
      {error && <p id={`${id}-error`} role="alert" className="m-0 text-compact text-danger">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex h-7.5 overflow-hidden rounded-md border border-line">
          <button type="button" onClick={save} className="inline-flex cursor-pointer items-center gap-1.5 px-2.5 text-compact font-semibold text-ink hover:bg-surface-muted">
            <ApprovedGlyph />{saveLabel}
          </button>
          <button type="button" onClick={onCancel} className="cursor-pointer border-l border-line px-2.5 text-compact font-semibold text-ink hover:bg-surface-muted">Cancel</button>
        </div>
        <span className="text-compact text-ink-muted">{composite?'Use Save edit to save':'Enter saves'} · Esc cancels</span>
      </div>
    </div>
  )
}
