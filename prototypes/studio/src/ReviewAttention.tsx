import { useState } from 'react'
import type { reviewAttention } from 'extraction/review-attention'
import { resultPathKey } from '../shared/groundedExtraction'
import { Button, Pill, SegmentedControl } from './ui'

type Filter = 'required' | 'ungrounded' | 'missing' | 'all'

/** A Catalog cell reads by its record ("Record 2 · people / 0 / name"); any other cell by its path. */
function cellLabel(path: readonly (string | number)[]) {
  return path[0] === 'records' && typeof path[1] === 'number'
    ? `Record ${path[1] + 1} · ${path.slice(2).join(' / ')}`
    : path.join(' / ')
}

/** The values that still need the researcher: required decisions first, then the optional attention (ungrounded,
 *  missing), each row a path, its state and a way to the field. */
export function ReviewAttention({ attention, onSelect, onEditField }: {
  attention: ReturnType<typeof reviewAttention>
  onSelect: (path: (string | number)[]) => void
  onEditField?: (nodeId: string, path: (string | number)[]) => void
}) {
  const [filter, setFilter] = useState<Filter>('required')
  const cells = attention.cells.filter((cell) =>
    filter === 'all' || (filter === 'required' ? cell.presence === 'grounded' && !cell.decision : cell.presence === filter))
  return (
    <details className="border-b border-line px-3 py-2 text-secondary">
      <summary className="cursor-pointer font-semibold text-ink">Review attention · {attention.requiredRemaining} to check</summary>
      <p className="mt-1 text-compact text-ink-muted">
        {attention.grounded} grounded · {attention.ungrounded} ungrounded · {attention.missing} missing. Missing and ungrounded values are optional attention; they do not block finalization.
      </p>
      <SegmentedControl className="mt-2" aria-label="Review attention" value={filter} onChange={setFilter}
        options={[{ value: 'required', label: 'Required' }, { value: 'ungrounded', label: 'Ungrounded' }, { value: 'missing', label: 'Missing' }, { value: 'all', label: 'All' }]} />
      <ul className="mt-2 flex flex-col gap-1">
        {cells.map((cell) => (
          <li key={resultPathKey([...cell.resultPath])} className="flex items-center gap-2">
            <button type="button" className="min-h-6 min-w-0 flex-1 cursor-pointer truncate text-left font-mono text-compact text-ink outline-none hover:text-accent focus-visible:text-accent"
              onClick={() => onSelect([...cell.resultPath])}>
              {cellLabel(cell.resultPath)}
            </button>
            <Pill tone={cell.decision ? (cell.decision.action === 'REJECTED' ? 'danger' : 'success') : cell.presence === 'grounded' ? 'accent' : 'neutral'}>
              {cell.decision ? cell.decision.action.toLowerCase() : cell.presence === 'grounded' ? 'to check' : cell.presence}
            </Pill>
            {onEditField && <Button className="min-h-6" onClick={() => onEditField(cell.nodeId, [...cell.resultPath])}>Edit field</Button>}
          </li>
        ))}
        {cells.length === 0 && <li className="text-ink-muted">Nothing in this view.</li>}
      </ul>
    </details>
  )
}
