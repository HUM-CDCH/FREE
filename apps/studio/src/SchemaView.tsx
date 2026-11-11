import { useState } from 'react'
import type { RecordScope, SchemaDefinition, SchemaNode } from 'extraction/schema'
import FieldRow, { SchemaTree } from './FieldRow'
import { SegmentedControl } from './ui'

/** Reads loaded definitions verbatim, including historical definitions that cannot run today. */
export default function SchemaView({ definition, recordScope }: { definition: SchemaDefinition; recordScope?: RecordScope | null }) {
  const [view, setView] = useState<'fields' | 'code'>('fields')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  function field(node: SchemaNode): React.ReactNode {
    const expanded = !collapsed.has(node.id)
    return <FieldRow node={node} isGroup={node.children !== undefined} expanded={expanded} readOnly editDisabled dragging={false} intoGroup={false}
        onToggleExpanded={() => setCollapsed(current => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })}
        onStartDrag={() => {}} onEdit={() => {}} onAddNote={() => {}} onDelete={() => {}} />
  }
  return <div className="min-h-0 overflow-auto p-4">
    <SegmentedControl aria-label="Template view" value={view} onChange={setView} options={[{ value: 'fields', label: 'Fields' }, { value: 'code', label: 'Code' }]} />
    {recordScope && <p>{recordScope === 'document' ? 'Article' : 'Catalog'}</p>}
    {view === 'code' ? <pre className="overflow-auto text-compact">{JSON.stringify(definition, null, 2)}</pre> : <><p className="my-3 text-secondary">{definition.recordDescription}</p><div role="list" aria-label="Template fields"><SchemaTree nodes={definition.schemaNodes} expanded={node => !collapsed.has(node.id)} renderRow={field} /></div></>}
  </div>
}
