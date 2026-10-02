import { useState } from 'react'
import type { reviewAttention } from 'extraction/review-attention'
import { resultPathKey } from '../shared/groundedExtraction'
import { Button } from './ui'

export function ReviewAttention({ attention, onSelect, onEditField }: {
  attention: ReturnType<typeof reviewAttention>
  onSelect: (path: (string | number)[]) => void
  onEditField?: (nodeId: string, path: (string | number)[]) => void
}) {
  const [filter, setFilter] = useState('unresolved')
  const cells = attention.cells.filter((cell) => filter === 'all' ||
    (filter === 'unresolved' ? cell.presence === 'grounded' && !cell.decision : cell.presence === filter))
  return <details className="border-b border-line p-3 text-xs">
    <summary>{attention.grounded} grounded · {attention.requiredRemaining} required decisions remaining · {attention.ungrounded} ungrounded · {attention.missing} missing</summary>
    <label>Show <select aria-label="Review attention" value={filter} onChange={(event) => setFilter(event.target.value)}>
      <option value="unresolved">Required decisions remaining</option>
      <option value="ungrounded">Ungrounded cells</option><option value="missing">Missing cells</option><option value="all">All cells</option>
    </select></label>
    <p>Missing and ungrounded cells are optional attention; they do not block finalization.</p>
    {cells.map((cell) => <div key={resultPathKey([...cell.resultPath])} className="flex gap-2">
      <Button onClick={() => onSelect([...cell.resultPath])}>Record {Number(cell.resultPath[1]) + 1} · {cell.resultPath.slice(2).join(' / ')} · {cell.presence}{cell.decision ? ` · ${cell.decision.action.toLowerCase()}` : ' · undecided'}</Button>
      {onEditField && <Button onClick={() => onEditField(cell.nodeId, [...cell.resultPath])}>Edit this field</Button>}
    </div>)}
    {cells.length === 0 && <p>No cells in this view.</p>}
  </details>
}
