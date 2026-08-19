import { useEffect, useRef, useState } from 'react'
import { requestSchemaEdit } from './api'
import { countTemplateFields, isRecord } from '../shared/template'
import type { FieldType } from '../shared/allowedValues'
import {
  duplicateFieldKeys,
  countSchemaMetadata,
  enumerateFieldPaths,
  type SchemaNode,
  mkId,
  nodesToTemplate,
  schemaDefinitionToTemplate,
  templateToSchemaDefinition,
} from '../shared/schemaNode'
import type {
  SchemaRevision,
  SchemaRevisionSummary,
} from '../shared/schemaRevision.contract'
import {
  deriveSchemaProposal,
  replaySchemaChanges,
  toggleAcceptedSchemaChange,
  type Change,
  type DerivedProposal,
  type ReplayOutcome,
} from './schemaChanges'

// ────────────────────────────────────────────────────────────────────────────
// Exported types (App.tsx depends on TemplateState)
// ────────────────────────────────────────────────────────────────────────────

export type TemplateState =
  | { status: 'idle' }
  | { status: 'generating' }
  | {
      status: 'ready'
      recordDescription: string
      nodes: SchemaNode[]
      inputsKey: string
      edited?: boolean
    }
  | { status: 'error'; message: string }

// ────────────────────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────────────────────

type SchemaPanelProps = {
  state: TemplateState
  onGenerate: (instruction: string) => void
  onCancelGenerate: () => void
  onResetSchema: () => void
  onNodesChange: (
    nodes: SchemaNode[],
    message: string,
    recordDescription?: string,
  ) => void
  beforeSchemaEdit: () => Promise<void>
  history: SchemaRevisionSummary[]
  currentRevisionNumber?: number
  loadRevision: (schemaRevisionId: string) => Promise<SchemaRevision>
  documentMarkdown: string | null
  sourceDocumentName: string
}

type DragState = {
  id: string
  parentId: string | null
  name: string
  isGroup: boolean
}

type DropTarget =
  | { type: 'slot'; parentId: string | null; index: number }
  | { type: 'group'; id: string; name: string }

type FieldEditing = { id: string; name: string; type: FieldType; allowedValues?: string[] }

function editedField(node: SchemaNode, name: string, editing: FieldEditing): SchemaNode {
  const base = { id: node.id, name, ...(node.description && { description: node.description }) }
  if (editing.type === 'object') {
    return { ...base, type: 'object', children: node.children ?? [] }
  }
  if (editing.type === 'array') {
    return node.children !== undefined
      ? { ...base, type: 'array', children: node.children }
      : { ...base, type: 'array', itemType: node.type === 'array' ? node.itemType : 'string' }
  }
  if (editing.type === 'string') {
    return editing.allowedValues && editing.allowedValues.length >= 2
      ? { ...base, type: 'string', allowedValues: editing.allowedValues }
      : { ...base, type: 'string' }
  }
  return { ...base, type: editing.type }
}

function editingOf(node: SchemaNode): FieldEditing {
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    allowedValues: node.type === 'string' ? node.allowedValues : undefined,
  }
}

function AllowedValuesBadge({ node, onEdit, disabled }: { node: SchemaNode; onEdit?: () => void; disabled?: boolean }) {
  if (!node.allowedValues) return null
  const title = `Allowed values${onEdit ? ' — click to edit' : ''}: ${node.allowedValues.join(', ')}`
  if (!onEdit) {
    return (
      <span
        className="min-w-0 shrink truncate rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
        title={title}
      >
        {node.allowedValues.join(' | ')}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="min-w-0 shrink cursor-pointer truncate rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-muted outline-none transition-colors hover:bg-accent-soft hover:text-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-canvas disabled:hover:text-ink-muted"
      title={title}
      disabled={disabled}
      onClick={onEdit}
    >
      {node.allowedValues.join(' | ')}
    </button>
  )
}

function ChangeBadge({ change, outcome }: { change: Change | undefined; outcome?: ReplayOutcome }) {
  if (outcome === 'rejected') return (
    <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-[9px] font-semibold text-ink-muted">
      Rejected
    </span>
  )
  if (outcome === 'unresolved') return (
    <span
      className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-[9px] font-semibold text-danger"
      title={change?.outcome === 'unresolved'
        ? change.reason
        : 'This accepted change depends on another review decision that is not currently accepted.'}
    >
      Unresolved
    </span>
  )
  if (!change?.reason && !change?.note) {
    if (outcome !== 'conflict') return null
    return (
      <span
        className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-[9px] font-semibold text-danger"
        title="This proposal conflicts with a schema invariant."
      >
        Conflict
      </span>
    )
  }
  const text = change.reason ? 'Conflict' : 'Note'
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold ${change.reason ? 'bg-danger-soft text-danger' : 'bg-amber-100 text-amber-800'}`}
      title={change.reason ?? change.note}
    >
      {text}
    </span>
  )
}

function AcceptanceControl({ id, name, accepted, onChange }: {
  id: string
  name: string
  accepted: boolean
  onChange: (id: string) => void
}) {
  return (
    <label className="flex shrink-0 cursor-pointer items-center gap-1 text-[10px] font-semibold text-ink-muted">
      <input
        type="checkbox"
        className="cursor-pointer accent-accent"
        aria-label={`Accept change to ${name}`}
        checked={accepted}
        onChange={() => onChange(id)}
      />
      Accept
    </label>
  )
}

type ChatMsg = { role: 'user' | 'assistant'; text: string }

type DocInstruction = { id: string; text: string }

type PendingChange = DerivedProposal & { original: SchemaNode[] }

function fieldTypeLabel(node: SchemaNode): string {
  if (node.type !== 'array') return node.type
  return node.children === undefined ? `array<${node.itemType}>` : 'array<object>'
}

function FieldChangeLabel({ node, change }: { node: SchemaNode; change?: Change }) {
  if (change?.kind === 'modified' && change.before && change.after) {
    const nameChanged = change.before.name !== change.after.name
    const beforeType = fieldTypeLabel(change.before)
    const afterType = fieldTypeLabel(change.after)
    return (
      <>
        {nameChanged ? (
          <>
            <span className="min-w-0 truncate font-mono text-[13.5px] font-medium text-danger line-through">{change.before.name}</span>
            <span className="shrink-0 text-[10px] text-ink-faint" aria-hidden="true">→</span>
            <span className="min-w-0 truncate font-mono text-[13.5px] font-medium text-green">{change.after.name}</span>
          </>
        ) : (
          <span className="min-w-0 truncate font-mono text-[13.5px] font-medium text-ink">{change.after.name}</span>
        )}
        {beforeType !== afterType && (
          <>
            <span className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 font-mono text-[9px] text-danger line-through">{beforeType}</span>
            <span className="shrink-0 rounded bg-green-soft px-1.5 py-0.5 font-mono text-[9px] text-green">{afterType}</span>
          </>
        )}
      </>
    )
  }

  const tone = change?.kind === 'added'
    ? 'text-green'
    : change?.kind === 'removed'
      ? 'text-danger line-through'
      : 'text-ink'
  return (
    <span className={`min-w-0 truncate font-mono text-[13.5px] font-medium ${tone}`}>{node.name}</span>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Data model and converters
// ────────────────────────────────────────────────────────────────────────────



// ────────────────────────────────────────────────────────────────────────────
// Node tree helpers (tasks 2.5, 3.4)
// ────────────────────────────────────────────────────────────────────────────

function deepClone(nodes: SchemaNode[]): SchemaNode[] {
  return nodes.map(n => n.children ? { ...n, children: deepClone(n.children) } : { ...n })
}

function extractNode(nodes: SchemaNode[], id: string): [SchemaNode | null, SchemaNode[]] {
  const root = deepClone(nodes)
  function remove(arr: SchemaNode[]): SchemaNode | null {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].id === id) return arr.splice(i, 1)[0]
      if (arr[i].children) { const found = remove(arr[i].children!); if (found) return found }
    }
    return null
  }
  return [remove(root), root]
}

function insertIntoNode(nodes: SchemaNode[], targetId: string, moved: SchemaNode): SchemaNode[] {
  return nodes.map(n => {
    if (n.id === targetId) return nodeWithChildren(n, [...(n.children ?? []), moved])
    if (n.children) return { ...n, children: insertIntoNode(n.children, targetId, moved) }
    return n
  })
}

function insertAtSlot(nodes: SchemaNode[], parentId: string | null, index: number, moved: SchemaNode): SchemaNode[] {
  if (parentId === null) {
    const out = [...nodes]; out.splice(Math.max(0, Math.min(index, out.length)), 0, moved); return out
  }
  return nodes.map(n => {
    if (n.id === parentId) {
      const ch = [...(n.children ?? [])]
      ch.splice(Math.max(0, Math.min(index, ch.length)), 0, moved)
      return nodeWithChildren(n, ch)
    }
    if (n.children) return { ...n, children: insertAtSlot(n.children, parentId, index, moved) }
    return n
  })
}

function nodeWithChildren(node: SchemaNode, children: SchemaNode[]): SchemaNode {
  return {
    id: node.id,
    name: node.name,
    type: node.type === 'array' ? 'array' : node.children === undefined ? 'object' : node.type,
    children,
    ...(node.description && { description: node.description }),
  }
}

function updateNodeById(
  nodes: readonly SchemaNode[],
  id: string,
  update: (node: SchemaNode) => SchemaNode,
): SchemaNode[] {
  return nodes.map((node) => {
    if (node.id === id) return update(node)
    return node.children === undefined
      ? node
      : { ...node, children: updateNodeById(node.children, id, update) }
  })
}

function srcIndex(nodes: SchemaNode[], drag: DragState): number {
  if (drag.parentId === null) return nodes.findIndex(n => n.id === drag.id)
  function search(arr: SchemaNode[]): number {
    for (const n of arr) {
      if (n.id === drag.parentId) return (n.children ?? []).findIndex(c => c.id === drag.id)
      if (n.children) { const r = search(n.children); if (r !== -1) return r }
    }
    return -1
  }
  return search(nodes)
}

const INDENT_THRESHOLD = 48
const VERTICAL_TOLERANCE = 20

// Returns the children array of the node with the given id (or root nodes if id is null).
function siblingsOf(nodes: SchemaNode[], parentId: string | null): SchemaNode[] {
  if (parentId === null) return nodes
  const search = (arr: SchemaNode[]): SchemaNode[] | null => {
    for (const n of arr) {
      if (n.id === parentId) return n.children ?? []
      if (n.children) { const r = search(n.children); if (r) return r }
    }
    return null
  }
  return search(nodes) ?? nodes
}

// Returns the id of the parent that directly contains childId, or null if at root.
function parentIdOf(nodes: SchemaNode[], childId: string): string | null {
  const search = (arr: SchemaNode[]): string | null | undefined => {
    for (const n of arr) {
      if (!n.children) continue
      if (n.children.some(c => c.id === childId)) return n.id
      const r = search(n.children)
      if (r !== undefined) return r
    }
    return undefined
  }
  return search(nodes) ?? null
}

function subtreeIdsOf(node: SchemaNode): string[] {
  const ids = [node.id]
  for (const child of node.children ?? []) ids.push(...subtreeIdsOf(child))
  return ids
}

function ancestorIdsOf(nodes: readonly SchemaNode[], targetIds: ReadonlySet<string>): Set<string> {
  const ancestors = new Set<string>()
  const visit = (level: readonly SchemaNode[], path: readonly string[]) => {
    for (const node of level) {
      if (targetIds.has(node.id)) {
        path.forEach((id) => ancestors.add(id))
        if (node.children !== undefined) ancestors.add(node.id)
      }
      if (node.children) visit(node.children, [...path, node.id])
    }
  }
  visit(nodes, [])
  return ancestors
}

// ────────────────────────────────────────────────────────────────────────────
// Shared UI sub-components
// ────────────────────────────────────────────────────────────────────────────

function WorkingIndicator({ onStop }: { onStop: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-line bg-canvas px-4 py-8 text-center" aria-live="polite">
      <span aria-hidden="true" className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent" />
      <p className="text-[13px] font-semibold text-ink">Producing schema…</p>
      <p className="max-w-[34ch] text-xs leading-snug text-ink-muted">This can take a while on large documents.</p>
      <button className={`${genBtnCls} mt-1`} type="button" onClick={onStop}>Stop</button>
    </div>
  )
}

const genBtnCls =
  'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-muted outline-none transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-muted'

// Superseded by the pre-generation doc chat (see below) — schema generation no
// longer takes a highlights hints/fields mode. Left in place, commented out,
// rather than deleted.
//
// function AnnotationsModeToggle({ mode, onChange }: { mode: AnnotationsMode; onChange: (mode: AnnotationsMode) => void }) {
//   const seg = (active: boolean) =>
//     `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'}`
//   return (
//     <div className="flex shrink-0 overflow-hidden rounded-md border border-line" role="group" aria-label="How highlights shape the schema">
//       <button className={seg(mode === 'hints')} type="button" aria-pressed={mode === 'hints'} onClick={() => onChange('hints')}>Hints</button>
//       <button className={seg(mode === 'fields')} type="button" aria-pressed={mode === 'fields'} onClick={() => onChange('fields')}>Fields</button>
//     </div>
//   )
// }

// Field editing uses stable ids, not paths.
function FieldEditForm({ editing, error, onChange, onSave, onCancel }: {
  editing: FieldEditing
  error: string | null
  onChange: (e: FieldEditing) => void
  onSave: () => void
  onCancel: () => void
}) {
  const [newValue, setNewValue] = useState('')

  function addValue() {
    const value = newValue.trim()
    if (!value) return
    const current = editing.allowedValues ?? []
    if (current.includes(value)) { setNewValue(''); return }
    onChange({ ...editing, allowedValues: [...current, value] })
    setNewValue('')
  }

  function removeValue(value: string) {
    const remaining = (editing.allowedValues ?? []).filter((v) => v !== value)
    onChange({ ...editing, allowedValues: remaining.length > 0 ? remaining : undefined })
  }

  return (
    <div className="my-0.5 flex flex-col gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <input
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-xs font-semibold text-ink outline-none focus-visible:border-accent"
          value={editing.name}
          placeholder="field_name"
          autoFocus
          onChange={e => onChange({ ...editing, name: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }}
        />
        <button className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108" type="button" onClick={onSave}>Save</button>
        <button className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-muted outline-none hover:text-accent" type="button" onClick={onCancel}>✗</button>
      </div>
      {editing.type === 'string' && (
        <div className="flex flex-col gap-1 border-t border-accent/20 pt-1.5">
          <span className="text-[10px] font-semibold text-ink-muted">Allowed values (leave empty for free text)</span>
          {editing.allowedValues && editing.allowedValues.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {editing.allowedValues.map((value) => (
                <span key={value} className="flex items-center gap-1 rounded bg-canvas px-1.5 py-0.5 font-mono text-[10.5px] text-ink">
                  {value}
                  <button
                    type="button"
                    className="cursor-pointer text-ink-faint outline-none hover:text-danger"
                    aria-label={`Remove ${value}`}
                    onClick={() => removeValue(value)}
                  >✕</button>
                </span>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <input
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
              value={newValue}
              placeholder="add value…"
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addValue() } }}
            />
            <button className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11px] font-semibold text-ink-muted outline-none hover:text-accent" type="button" onClick={addValue}>Add</button>
          </div>
        </div>
      )}
      {error && <span className="text-[10px] font-semibold text-danger" role="alert">{error}</span>}
    </div>
  )
}

function DescriptionEditForm({ value, onChange, onSave, onDelete, onCancel }: {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  if (confirmingDelete) {
    return (
      <div className="mt-0.5 mb-0.5 flex items-center justify-between gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2 py-1">
        <span className="text-[12px] font-semibold text-danger">Delete this description?</span>
        <div className="flex shrink-0 gap-1.5">
          <button className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-semibold text-ink-muted outline-none hover:text-ink" type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
          <button className="cursor-pointer rounded-md bg-danger px-2 py-0.5 text-[11px] font-semibold text-white outline-none hover:brightness-110" type="button" onClick={onDelete}>Delete</button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-0.5 mb-0.5 flex items-center gap-1.5 rounded-md border border-accent/50 bg-accent-ghost px-2 py-1">
      <input
        className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-ink outline-none placeholder:text-ink-faint"
        placeholder="Describe this field for the extraction model…"
        value={value}
        autoFocus
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }}
      />
      <button className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2 py-0.5 text-[11px] font-bold text-white outline-none transition-[filter] hover:brightness-108" type="button" onClick={onSave}>Save</button>
      <button
        className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted outline-none hover:text-danger"
        type="button"
        title="Delete description"
        onClick={() => setConfirmingDelete(true)}
      >🗑</button>
      <button className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted outline-none hover:text-accent" type="button" title="Cancel" onClick={onCancel}>✗</button>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

function SchemaPanel({
  state,
  onGenerate,
  onCancelGenerate,
  onResetSchema,
  onNodesChange,
  beforeSchemaEdit,
  history,
  currentRevisionNumber,
  loadRevision,
  documentMarkdown,
  sourceDocumentName,
}: SchemaPanelProps) {
  // ── render state ──
  const [nodes, setNodes] = useState<SchemaNode[]>([])
  const [dragging, setDragging] = useState<DragState | null>(null)
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const [overTarget, setOverTarget] = useState<DropTarget | null>(null)
  const [editing, setEditing] = useState<FieldEditing | null>(null)
  const [editingError, setEditingError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: 'assistant', text: "Edit through drag and drop, or describe a change. I'll show a diff to review first." },
  ])
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [acceptedChangeIds, setAcceptedChangeIds] = useState<Set<string>>(new Set())
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatAbortRef = useRef<AbortController | null>(null)
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [openDescId, setOpenDescId] = useState<string | null>(null)
  const [descDraft, setDescDraft] = useState('')
  const [jsonEditMode, setJsonEditMode] = useState(false)
  const [jsonDraft, setJsonDraft] = useState('')
  const [jsonEditError, setJsonEditError] = useState<string | null>(null)
  const [recordDescriptionDraft, setRecordDescriptionDraft] = useState('')
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyRestoring, setHistoryRestoring] = useState(false)
  const [confirmingDeleteSchema, setConfirmingDeleteSchema] = useState(false)

  // Pre-generation instructions: recorded locally, sent as the instruction
  // for "Generate schema"/"Regenerate" — not a live conversation with the model.
  const [docInstructions, setDocInstructions] = useState<DocInstruction[]>([])
  const [docChatDraft, setDocChatDraft] = useState('')
  const docChatRef = useRef<HTMLDivElement>(null)

  // ── refs for event handlers (avoid stale closures) ──
  const nodesRef = useRef<SchemaNode[]>([])
  const draggingRef = useRef<DragState | null>(null)
  const overTargetRef = useRef<DropTarget | null>(null)
  const dragYRef = useRef(0)
  const dragXRef = useRef(0)
  const dragStartXRef = useRef(0)
  const dragStartYRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const onNodesChangeRef = useRef(onNodesChange)
  const historyRestoringRef = useRef(false)
  onNodesChangeRef.current = onNodesChange

  const ready = state.status === 'ready'
  const fieldCount = ready ? countTemplateFields(nodesToTemplate(state.nodes)) : 0
  const displayedFieldCount = fieldCount
  const inputsKey = state.status === 'ready' ? state.inputsKey : null
  const dx = dragging ? dragX - dragStartXRef.current : 0
  const dy = dragging ? dragY - dragStartYRef.current : 0
  const horizontalIntent = Math.abs(dx) > INDENT_THRESHOLD && Math.abs(dy) < VERTICAL_TOLERANCE
  const dragMode = horizontalIntent ? (dx > 0 ? 'indent' : 'outdent') : 'normal'

  // sync nodes when a new schema is generated
  useEffect(() => {
    if (state.status === 'ready') {
      setNodes(state.nodes)
      nodesRef.current = state.nodes
      setRecordDescriptionDraft(state.recordDescription)
      setEditing(null)
      setEditingError(null)
      setMutationError(null)
      setPending(null)
      setAcceptedChangeIds(new Set())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsKey])

  // Keep the newest chat message visible.
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, pending])

  // Keep the newest recorded instruction visible.
  useEffect(() => {
    const el = docChatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [docInstructions.length])

  // ── Auto-scroll helpers ──
  function stopScroll() {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null }
  }

  function startScroll() {
    stopScroll()
    const tick = () => {
      if (!draggingRef.current) return
      const el = scrollRef.current
      if (el) {
        const r = el.getBoundingClientRect()
        // 60px edge zone, 7px/frame.
        if (dragYRef.current < r.top + 60) el.scrollTop -= 7
        else if (dragYRef.current > r.bottom - 60) el.scrollTop += 7
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // Reads refs to avoid stale closures.
  function commitNodes(nextNodes: SchemaNode[], message: string): boolean {
    const duplicates = duplicateFieldKeys(enumerateFieldPaths(nextNodes))
    if (duplicates.length > 0) {
      setMutationError(`Cannot move field: a sibling field already uses “${duplicates[0].split('.').at(-1)}”.`)
      return false
    }
    setMutationError(null)
    nodesRef.current = nextNodes
    setNodes(nextNodes)
    onNodesChangeRef.current(nextNodes, message)
    return true
  }

  async function restoreRevision(revision: SchemaRevisionSummary) {
    setHistoryOpen(false)
    if (historyRestoringRef.current || revision.revisionNumber === currentRevisionNumber) return

    historyRestoringRef.current = true
    setHistoryRestoring(true)
    setHistoryError(null)
    try {
      const loaded = await loadRevision(revision.schemaRevisionId)
      await beforeSchemaEdit()
      nodesRef.current = loaded.schemaNodes
      setNodes(loaded.schemaNodes)
      setRecordDescriptionDraft(loaded.recordDescription)
      setEditing(null)
      setEditingError(null)
      setMutationError(null)
      setPending(null)
      setAcceptedChangeIds(new Set())
      setSelectedIds(new Set())
      setOpenDescId(null)
      setJsonEditMode(false)
      setJsonEditError(null)
      setView('fields')
      onNodesChangeRef.current(
        loaded.schemaNodes,
        `↺ Restored revision ${revision.revisionNumber}`,
        loaded.recordDescription,
      )
      await beforeSchemaEdit()
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : 'Could not restore Schema Revision.')
    } finally {
      historyRestoringRef.current = false
      setHistoryRestoring(false)
    }
  }

  async function deleteSchema() {
    try {
      await onResetSchema()
    } catch {
      return
    }
    setConfirmingDeleteSchema(false)
    setHistoryOpen(false)
    nodesRef.current = []
    setNodes([])
    setChat([
      { role: 'assistant', text: "Edit through drag and drop, or describe a change. I'll show a diff to review first." },
    ])
    setPending(null)
    setAcceptedChangeIds(new Set())
    setSelectedIds(new Set())
    setEditing(null)
    setEditingError(null)
    setMutationError(null)
    setOpenDescId(null)
    setJsonEditMode(false)
    setJsonEditError(null)
    setView('fields')
    setHistoryError(null)
    setDocInstructions([])
    setDocChatDraft('')
  }

  function commitDrop() {
    const drag = draggingRef.current
    const target = overTargetRef.current
    if (!drag) return
    const cur = nodesRef.current
    const dx = dragXRef.current - dragStartXRef.current
    const dy = dragYRef.current - dragStartYRef.current
    const horizontalIntent = Math.abs(dx) > INDENT_THRESHOLD && Math.abs(dy) < VERTICAL_TOLERANCE

    const apply = (nodes: SchemaNode[]) => commitNodes(nodes, '⠿ Schema reordered')

    if (horizontalIntent && dx > 0) {
      const siblings = siblingsOf(cur, drag.parentId)
      const idx = siblings.findIndex(n => n.id === drag.id)
      if (idx > 0) {
        // Normal indent: move into previous sibling, insert near drop point
        const prevSibling = siblings[idx - 1]
        const [moved, without] = extractNode(cur, drag.id)
        if (!moved) return
        const insertIdx = (target?.type === 'slot' && target.parentId === prevSibling.id)
          ? target.index
          : (prevSibling.children ?? []).length
        apply(insertAtSlot(without, prevSibling.id, insertIdx, moved))
      } else if (drag.parentId === null && idx === 0) {
        // Ungroup: node stays at front as leaf, children follow
        const node = cur[0]
        if (!node.children?.length) return
        const leaf: SchemaNode = { id: node.id, name: node.name, type: 'verbatim-string' }
        apply([leaf, ...node.children, ...cur.slice(1)])
      }
      return
    }

    if (horizontalIntent && dx < 0 && drag.parentId !== null) {
      // Outdent: move one level up, use overTarget slot for precise placement
      const [moved, without] = extractNode(cur, drag.id)
      if (!moved) return
      const grandparentId = without.some(n => n.id === drag.parentId)
        ? null
        : parentIdOf(without, drag.parentId)
      let finalNodes: SchemaNode[]
      if (target?.type === 'slot' && target.parentId === grandparentId) {
        finalNodes = insertAtSlot(without, grandparentId, target.index, moved)
      } else {
        // Fallback: insert after parent in grandparent's list
        const gpSiblings = siblingsOf(without, grandparentId)
        const parentIdx = gpSiblings.findIndex(n => n.id === drag.parentId)
        finalNodes = insertAtSlot(without, grandparentId, Math.max(0, parentIdx + 1), moved)
      }
      apply(finalNodes)
      return
    }

    if (!target) return

    if (target.type === 'group') {
      if (drag.isGroup) return
      const [moved, root] = extractNode(cur, drag.id)
      if (!moved) return
      const finalNodes = insertIntoNode(root, target.id, moved)
      commitNodes(finalNodes, '⠿ Schema reordered')
    } else {
      const { parentId, index } = target
      const si = srcIndex(cur, drag)
      const [moved, root] = extractNode(cur, drag.id)
      if (!moved) return
      let ii = index
      if (drag.parentId === (parentId ?? null) && si < ii) ii--
      const finalNodes = insertAtSlot(root, parentId ?? null, ii, moved)
      commitNodes(finalNodes, '⠿ Schema reordered')
    }
  }

  // Global mouse listeners are installed once.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      setDragX(e.clientX)
      setDragY(e.clientY)
      dragYRef.current = e.clientY
      dragXRef.current = e.clientX
    }
    const onUp = () => {
      if (!draggingRef.current) return
      commitDrop()
      stopScroll()
      draggingRef.current = null
      overTargetRef.current = null
      setDragging(null)
      setOverTarget(null)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    // Cancel RAF on unmount.
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      stopScroll()
    }
  // Handlers read mutable drag/schema refs; reinstalling global listeners on every render is unnecessary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Drag start ──
  function startDrag(e: React.MouseEvent, id: string, parentId: string | null, name: string, isGroup: boolean) {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const d: DragState = { id, parentId, name, isGroup }
    draggingRef.current = d
    setDragging(d)
    setDragX(e.clientX)
    setDragY(e.clientY)
    dragYRef.current = e.clientY
    dragXRef.current = e.clientX
    dragStartXRef.current = e.clientX
    dragStartYRef.current = e.clientY
    startScroll()
  }

  // Slot targets
  function setSlotTarget(parentId: string | null, index: number) {
    if (!draggingRef.current) return
    const t: DropTarget = { type: 'slot', parentId, index }
    overTargetRef.current = t
    setOverTarget(t)
  }

  // Group hover targets
  function setGroupTarget(id: string, name: string) {
    const drag = draggingRef.current
    if (!drag || drag.isGroup || drag.id === id || drag.parentId === id) return
    const t: DropTarget = { type: 'group', id, name }
    overTargetRef.current = t
    setOverTarget(t)
    setExpandedIds(s => new Set([...s, id]))
  }

  function clearGroupTarget(id: string) {
    if (overTargetRef.current?.type === 'group' && overTargetRef.current.id === id) {
      overTargetRef.current = null
      setOverTarget(null)
    }
  }

  // ── Inline editing ──
  function saveEdit() {
    if (!editing) return
    if (editing.type === 'string' && editing.allowedValues && editing.allowedValues.length === 1) {
      setEditingError('Need at least 2 allowed values, or remove the last one for free text.')
      return
    }
    const name = editing.name.trim().toLowerCase().replace(/\s+/g, '_') || 'field'
    const newNodes = updateNodeById(
      nodesRef.current,
      editing.id,
      (node) => editedField(node, name, editing),
    )
    if (duplicateFieldKeys(enumerateFieldPaths(newNodes)).length > 0) {
      setEditingError(`A sibling field already uses “${name}”.`)
      return
    }
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChange(newNodes, '✎ Schema updated')
    setEditing(null)
    setEditingError(null)
  }

  function bulkRemoveNodes() {
    let newNodes = nodesRef.current
    for (const id of selectedIds) {
      const [, after] = extractNode(newNodes, id)
      newNodes = after
    }
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChange(newNodes, `${selectedIds.size} field${selectedIds.size !== 1 ? 's' : ''} removed`)
    if (editing && selectedIds.has(editing.id)) setEditing(null)
    setSelectedIds(new Set())
  }

  function toggleSelected(node: SchemaNode) {
    const ids = subtreeIdsOf(node)
    setSelectedIds(prev => {
      const next = new Set(prev)
      const select = !next.has(node.id)
      for (const id of ids) {
        if (select) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  function updateNodeDescription(id: string, description: string | undefined) {
    const newNodes = updateNodeById(nodesRef.current, id, (node) => ({ ...node, description }))
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChangeRef.current(newNodes, '✎ Description updated')
  }

  function addField() {
    const cur = nodesRef.current
    let name = 'nyt_felt'
    let suffix = 2
    while (cur.some(n => n.name === name)) name = `nyt_felt_${suffix++}`
    const id = mkId()
    const newNode: SchemaNode = { id, name, type: 'verbatim-string' }
    const newNodes = [...cur, newNode]
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChange(newNodes, '✎ Schema updated')
    setView('fields')
    setEditing({ id, name, type: 'verbatim-string' })
  }

  // ── Chat ──
  async function sendChatMessage(text: string) {
    if (!text.trim() || chatLoading || pending) return
    const userMsg = text.trim()
    setChat(c => [...c, { role: 'user', text: userMsg }])
    setChatInput('')
    setChatLoading(true)
    const controller = new AbortController()
    chatAbortRef.current = controller

    const originalBeforeFlush = nodesRef.current
    try {
      await beforeSchemaEdit()
      if (nodesRef.current !== originalBeforeFlush) {
        setChat(c => [...c, { role: 'assistant', text: 'Schema changed while the request was running. Send the request again.' }])
        return
      }
      const original = nodesRef.current
      const response = await requestSchemaEdit(original, userMsg, documentMarkdown, controller.signal)
      if (nodesRef.current !== original) {
        setChat(c => [...c, { role: 'assistant', text: 'Schema changed while the request was running. Send the request again.' }])
        return
      }
      if (response.status === 'refused' || response.status === 'failed') {
        setChat(c => [...c, { role: 'assistant', text: `${response.status === 'refused' ? 'Request refused' : 'Request failed'}: ${response.message}` }])
      } else {
        const proposal = deriveSchemaProposal(original, response)
        if (proposal.changes.length === 0 && proposal.issues.length === 0) {
          setChat(c => [...c, { role: 'assistant', text: 'Proposal checked every field: 0 changes proposed.' }])
        } else {
          setAcceptedChangeIds(new Set(proposal.changes.map(({ id }) => id)))
          setPending({ ...proposal, original })
          const ancestors = ancestorIdsOf(proposal.reviewNodes, new Set(proposal.changes.map(({ id }) => id)))
          setExpandedIds((current) => new Set([...current, ...ancestors]))
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setChat(c => [...c, { role: 'assistant', text: 'Cancelled.' }])
      } else {
        setChatInput(userMsg)
        setChat(c => [...c, { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : 'Request failed'}` }])
      }
    } finally {
      chatAbortRef.current = null
      setChatLoading(false)
    }
  }

  function cancelChat() {
    chatAbortRef.current?.abort()
  }

  // ── Pre-generation instructions (recorded locally; sent as the instruction
  // for "Generate schema"/"Regenerate") ──
  const docInstruction = docInstructions.map((instruction) => instruction.text).join('\n\n')
  const instructionCountLabel = docInstructions.length > 0
    ? ` (${docInstructions.length} instruction${docInstructions.length === 1 ? '' : 's'})`
    : ''

  function sendDocChatMessage() {
    const text = docChatDraft.trim()
    if (!text) return
    setDocChatDraft('')
    setDocInstructions((current) => [...current, { id: mkId(), text }])
  }

  function removeDocInstruction(id: string) {
    setDocInstructions((current) => current.filter((instruction) => instruction.id !== id))
  }

  // Apply pending proposal.
  function applyPending() {
    if (!pending) return
    if (nodesRef.current !== pending.original) {
      setChat(c => [...c, { role: 'assistant', text: 'Schema changed during review. The proposal was discarded.' }])
      setPending(null)
      setAcceptedChangeIds(new Set())
      return
    }
    const replayed = replaySchemaChanges(pending.original, pending.changes, acceptedChangeIds)
    if (!replayed.hasChanges) return
    nodesRef.current = replayed.nodes
    setNodes(replayed.nodes)
    onNodesChange(replayed.nodes, '✦ Schema updated via chat')
    setChat(c => [...c, { role: 'assistant', text: `✓ ${replayed.appliedCount} schema change${replayed.appliedCount === 1 ? '' : 's'} applied.` }])
    setPending(null)
    setAcceptedChangeIds(new Set())
  }

  // Discard pending proposal.
  function discardPending() {
    setChat(c => [...c, { role: 'assistant', text: 'Okay — discarded, no changes made.' }])
    setPending(null)
    setAcceptedChangeIds(new Set())
  }

  function toggleChangeAccepted(id: string) {
    if (!pending) return
    setAcceptedChangeIds((current) => toggleAcceptedSchemaChange(pending.changes, current, id))
  }

  // ── style helpers ──
  function slotCls(parentId: string | null, index: number) {
    const on =
      dragMode === 'normal' &&
      overTarget?.type === 'slot' &&
      overTarget.parentId === (parentId ?? null) &&
      overTarget.index === index
    return `h-1.5 border-t-2 transition-[border-color] duration-100 ${on ? 'border-accent' : 'border-transparent'}`
  }

  function rowCls(_id: string, intoGroup: boolean, isDragging: boolean) {
    return [
      '-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5',
      'border border-solid transition-[background,border,opacity] duration-150',
      intoGroup || isDragging ? 'border-accent' : 'border-transparent',
      intoGroup ? 'bg-accent-ghost' : '',
      isDragging ? 'opacity-40' : '',
    ].join(' ')
  }

  const msgCls = (role: 'user' | 'assistant') =>
    role === 'user'
      ? 'self-end max-w-[88%] rounded-[11px_11px_3px_11px] bg-accent px-3 py-1.5 text-xs leading-relaxed text-white'
      : 'self-start max-w-[92%] rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-1.5 text-xs leading-relaxed text-ink'

  const editDisabled = !!dragging

  const chatBlocked = !!pending || chatLoading
  const replay = pending ? replaySchemaChanges(pending.original, pending.changes, acceptedChangeIds) : null
  const metadataCounts = pending ? countSchemaMetadata(pending.original) : null
  const replayOutcomes = replay ? [...replay.outcomes.entries()] : []
  const proposalCounts = pending ? {
    accepted: acceptedChangeIds.size,
    rejected: pending.changes.length - acceptedChangeIds.size,
    applied: replay!.appliedCount,
    unresolved: new Set([
      ...pending.changes.filter(({ outcome }) => outcome === 'unresolved').map(({ id }) => id),
      ...replayOutcomes.filter(([, outcome]) => outcome === 'unresolved').map(([id]) => id),
    ]).size,
    conflicts: new Set([
      ...pending.changes.filter(({ outcome }) => outcome === 'conflict').map(({ id }) => id),
      ...replayOutcomes.filter(([, outcome]) => outcome === 'conflict').map(([id]) => id),
    ]).size,
  } : null
  const canApply = pending && replay!.hasChanges

  const tabCls = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'}`

  // ────────────────────────────────────────────────────────────────────────
  // Render helpers for field rows
  // ────────────────────────────────────────────────────────────────────────

  function renderRootField(node: SchemaNode, i: number) {
    const isGroup = node.children !== undefined
    const isDragging = dragging?.id === node.id
    const intoGroup = dragMode === 'normal' && overTarget?.type === 'group' && overTarget.id === node.id
    const isEditing = editing?.id === node.id
    const change = pending?.changes.find((item) => item.id === node.id)
    const diffStatus = change?.kind ?? null
    const isDiff = diffStatus !== null
    const diffBg = diffStatus === 'added' ? 'bg-green-soft' : diffStatus === 'removed' ? 'bg-danger-soft' : diffStatus === 'modified' ? 'bg-amber-100' : ''

    return (
      <div key={node.id}>
        {/* drop slot before this field */}
        <div className={slotCls(null, i)} onMouseEnter={() => setSlotTarget(null, i)} />

        {isEditing && editing && !isDiff ? (
          <FieldEditForm
            editing={editing}
            error={editingError}
            onChange={(next) => { setEditing(next); setEditingError(null) }}
            onSave={saveEdit}
            onCancel={() => { setEditing(null); setEditingError(null) }}
          />
        ) : (
          <div
            className={`${rowCls(node.id, intoGroup, isDragging)} ${diffBg}`}
            onMouseEnter={() => !isDiff && setGroupTarget(node.id, node.name)}
            onMouseLeave={() => !isDiff && clearGroupTarget(node.id)}
          >
            {!isDiff && (
              <span
                className="shrink-0 cursor-grab select-none px-0.5 text-sm leading-none text-ink-faint"
                onMouseDown={e => startDrag(e, node.id, null, node.name, isGroup)}
              >
                ⠿
              </span>
            )}
            <FieldChangeLabel node={node} change={change} />
            <AllowedValuesBadge
              node={node}
              disabled={editDisabled}
              onEdit={!isDiff ? () => { setEditing(editingOf(node)); setEditingError(null) } : undefined}
            />
            <ChangeBadge change={change} outcome={change && replay?.outcomes.get(change.id)} />
            {intoGroup && !isDiff && (
              <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white whitespace-nowrap">
                into {node.name}
              </span>
            )}
            <span className="min-w-0 flex-1" />
            {change && <AcceptanceControl id={change.id} name={change.after?.name ?? node.name} accepted={acceptedChangeIds.has(change.id)} onChange={toggleChangeAccepted} />}
            {!isDiff && isGroup && (
              <button
                className={`shrink-0 cursor-pointer px-1 leading-none outline-none transition-colors focus-visible:text-accent ${node.description ? 'text-accent' : 'text-ink-muted hover:text-accent'}`}
                type="button"
                title="Add description"
                onClick={() => {
                  const next = openDescId === node.id ? null : node.id
                  if (next) setDescDraft(node.description ?? '')
                  setOpenDescId(next)
                }}
              >
                <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/></svg>
              </button>
            )}
            {!isDiff && (
              <button
                className="shrink-0 cursor-pointer px-1 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent disabled:opacity-40"
                type="button"
                title={`Edit ${node.name}`}
                disabled={editDisabled}
                onClick={() => { setEditing(editingOf(node)); setEditingError(null) }}
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
              </button>
            )}
            {!isDiff && (
              <input
                type="checkbox"
                className="shrink-0 cursor-pointer accent-accent"
                checked={selectedIds.has(node.id)}
                onChange={() => toggleSelected(node)}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
        )}

        {isGroup && openDescId === node.id && (
          <DescriptionEditForm
            value={descDraft}
            onChange={setDescDraft}
            onSave={() => { updateNodeDescription(node.id, descDraft.trim() || undefined); setOpenDescId(null) }}
            onDelete={() => { updateNodeDescription(node.id, undefined); setOpenDescId(null) }}
            onCancel={() => setOpenDescId(null)}
          />
        )}

        {/* Nested children area — shown when there are children or dragging (for drop slot) */}
        {isGroup && ((node.children ?? []).length > 0 || !!dragging) && (
          <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
            {(node.children ?? []).map((child, j) => renderChildField(child, node.id, j))}
            <div
              className={slotCls(node.id, (node.children ?? []).length)}
              onMouseEnter={() => setSlotTarget(node.id, (node.children ?? []).length)}
            />
          </div>
        )}
      </div>
    )
  }

  function renderChildField(child: SchemaNode, parentId: string, j: number): React.ReactNode {
    const isDragging = dragging?.id === child.id
    const isEditing = editing?.id === child.id
    const isGroup = child.children !== undefined
    const intoGroup = dragMode === 'normal' && overTarget?.type === 'group' && overTarget.id === child.id
    const isExpanded = expandedIds.has(child.id) || intoGroup
    const change = pending?.changes.find((item) => item.id === child.id)
    const diffStatus = change?.kind ?? null
    const isDiff = diffStatus !== null
    const diffBg = diffStatus === 'added' ? 'bg-green-soft' : diffStatus === 'removed' ? 'bg-danger-soft' : diffStatus === 'modified' ? 'bg-amber-100' : ''

    const toggleExpand = (e: React.MouseEvent) => {
      e.stopPropagation()
      setExpandedIds(s => {
        const ns = new Set(s)
        if (ns.has(child.id)) ns.delete(child.id)
        else ns.add(child.id)
        return ns
      })
    }

    return (
      <div
        key={child.id}
        onMouseEnter={() => !isDiff && setGroupTarget(child.id, child.name)}
        onMouseLeave={() => !isDiff && clearGroupTarget(child.id)}
      >
        <div className={slotCls(parentId, j)} onMouseEnter={e => { e.stopPropagation(); setSlotTarget(parentId, j) }} />
        {isEditing && editing && !isDiff ? (
          <FieldEditForm
            editing={editing}
            error={editingError}
            onChange={(next) => { setEditing(next); setEditingError(null) }}
            onSave={saveEdit}
            onCancel={() => { setEditing(null); setEditingError(null) }}
          />
        ) : (
          <div
            className={`-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 border transition-opacity duration-100 ${intoGroup && !isDiff ? 'border-accent/40 bg-accent-soft' : 'border-transparent'} ${isDragging ? 'opacity-40' : ''} ${diffBg}`}
          >
            {!isDiff && (
              <span
                className="shrink-0 cursor-grab select-none px-0.5 text-[13px] leading-none text-ink-faint"
                onMouseDown={e => startDrag(e, child.id, parentId, child.name, isGroup)}
              >
                ⠿
              </span>
            )}
            <FieldChangeLabel node={child} change={change} />
            <AllowedValuesBadge
              node={child}
              disabled={editDisabled}
              onEdit={!isDiff ? () => { setEditing(editingOf(child)); setEditingError(null) } : undefined}
            />
            <ChangeBadge change={change} outcome={change && replay?.outcomes.get(change.id)} />
            {isGroup && !isDiff && (
              <span
                className="shrink-0 flex items-center text-ink-faint hover:text-accent cursor-pointer transition-colors"
                onClick={toggleExpand}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
                  <polygon points="0,0 8,4 0,8" />
                </svg>
              </span>
            )}
            {intoGroup && !isDiff && (
              <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white whitespace-nowrap">
                into {child.name}
              </span>
            )}
            <span className="min-w-0 flex-1" />
            {change && <AcceptanceControl id={change.id} name={change.after?.name ?? child.name} accepted={acceptedChangeIds.has(change.id)} onChange={toggleChangeAccepted} />}
            {!isDiff && isGroup && (
              <button
                className={`shrink-0 cursor-pointer px-1 leading-none outline-none transition-colors focus-visible:text-accent ${child.description ? 'text-accent' : 'text-ink-muted hover:text-accent'}`}
                type="button"
                title="Add description"
                onClick={() => {
                  const next = openDescId === child.id ? null : child.id
                  if (next) setDescDraft(child.description ?? '')
                  setOpenDescId(next)
                }}
              >
                <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/></svg>
              </button>
            )}
            {!isDiff && (
              <button
                className="shrink-0 cursor-pointer px-1 text-ink-muted outline-none transition-colors hover:text-accent focus-visible:text-accent disabled:opacity-40"
                type="button"
                title={`Edit ${child.name}`}
                disabled={editDisabled}
                onClick={() => { setEditing(editingOf(child)); setEditingError(null) }}
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
              </button>
            )}
            {!isDiff && (
              <input
                type="checkbox"
                className="shrink-0 cursor-pointer accent-accent"
                checked={selectedIds.has(child.id)}
                onChange={() => toggleSelected(child)}
                onClick={e => e.stopPropagation()}
              />
            )}
          </div>
        )}

        {isGroup && openDescId === child.id && (
          <DescriptionEditForm
            value={descDraft}
            onChange={setDescDraft}
            onSave={() => { updateNodeDescription(child.id, descDraft.trim() || undefined); setOpenDescId(null) }}
            onDelete={() => { updateNodeDescription(child.id, undefined); setOpenDescId(null) }}
            onCancel={() => setOpenDescId(null)}
          />
        )}

        {/* Children area — shown when expanded and has children or dragging (for drop slot) */}
        {isGroup && isExpanded && ((child.children ?? []).length > 0 || !!dragging) && (
          <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
            {(child.children ?? []).map((grandchild, k) => renderChildField(grandchild, child.id, k))}
            <div
              className={slotCls(child.id, (child.children ?? []).length)}
              onMouseEnter={() => setSlotTarget(child.id, (child.children ?? []).length)}
            />
          </div>
        )}
      </div>
    )
  }

  // ────────────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col">

      {/* ── Header ── */}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">Extraction Schema</h2>
          <p className="truncate font-mono text-[13px] font-medium text-ink">{sourceDocumentName}</p>
        </div>
        {ready && (
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-line">
              <button className={tabCls(view === 'fields')} type="button" aria-pressed={view === 'fields'} onClick={() => setView('fields')}>Fields</button>
              <button className={`${tabCls(view === 'json')} font-mono`} type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}>{'JSON'}</button>
            </div>
            <div className="relative">
              <button
                className="cursor-pointer rounded-md border border-line bg-surface p-1 text-ink-muted outline-none transition-colors hover:border-danger/50 hover:text-danger"
                type="button"
                aria-label="Clear current schema"
                title="Clear current schema"
                onClick={() => setConfirmingDeleteSchema((open) => !open)}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M8 2a1 1 0 00-1 1v1H4a1 1 0 000 2h12a1 1 0 100-2h-3V3a1 1 0 00-1-1H8zM5 7a1 1 0 011 1v8a2 2 0 002 2h4a2 2 0 002-2V8a1 1 0 112 0v8a4 4 0 01-4 4H8a4 4 0 01-4-4V8a1 1 0 011-1z" clipRule="evenodd" />
                </svg>
              </button>
              {confirmingDeleteSchema && (
                <div className="absolute right-0 top-full z-30 mt-1.5 w-64 rounded-lg border border-danger/30 bg-surface p-3 shadow-float">
                  <p className="text-[12px] font-semibold text-ink">Clear current schema?</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">
                    This clears the current editor only. Saved Schema Revisions remain in history.
                  </p>
                  <div className="mt-2.5 flex justify-end gap-1.5">
                    <button
                      className="cursor-pointer rounded-md px-2 py-1 text-[11px] font-semibold text-ink-muted outline-none hover:text-ink"
                      type="button"
                      onClick={() => setConfirmingDeleteSchema(false)}
                    >
                      Cancel
                    </button>
                    <button
                      className="cursor-pointer rounded-md bg-danger px-2.5 py-1 text-[11px] font-semibold text-white outline-none hover:brightness-110"
                      type="button"
                      onClick={deleteSchema}
                    >
                      Clear schema
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </header>

      {/* ── Schema list / states ── */}
      <div ref={scrollRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {historyError && <p role="alert" className="mb-2 text-xs text-danger">{historyError}</p>}
        {state.status === 'idle' && (
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
            <p className="text-[13px] font-semibold text-ink">No schema yet</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              FREE produces the extraction schema from the document with the extraction model.
              {' '}Add instructions in the chat below, or generate now.
            </p>
          </div>
        )}

        {state.status === 'generating' && <WorkingIndicator onStop={onCancelGenerate} />}

        {state.status === 'error' && (
          <div className="rounded-xl border border-dashed border-danger/40 px-4 py-6 text-center">
            <p className="text-[13px] leading-snug text-danger">{state.message}</p>
            <button className={`${genBtnCls} mt-3`} type="button" onClick={() => onGenerate(docInstruction)}>Retry</button>
          </div>
        )}

        {ready && view === 'json' && (
          <div className="flex flex-col gap-1.5">
            {!jsonEditMode ? (
              <div className="relative">
                <pre className="overflow-x-auto whitespace-pre rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink">
                  {JSON.stringify(
                    schemaDefinitionToTemplate({
                      recordDescription: recordDescriptionDraft,
                      schemaNodes: nodes,
                    }),
                    null,
                    2,
                  )}
                </pre>
                <button
                  className="absolute right-2 top-2 cursor-pointer rounded border border-line bg-surface px-1.5 py-0.5 font-sans text-[10px] font-semibold text-ink-muted outline-none transition-colors hover:border-accent hover:text-accent"
                  type="button"
                  onClick={() => {
                    setJsonDraft(
                      JSON.stringify(
                        schemaDefinitionToTemplate({
                          recordDescription: recordDescriptionDraft,
                          schemaNodes: nodes,
                        }),
                        null,
                        2,
                      ),
                    )
                    setJsonEditMode(true)
                    setJsonEditError(null)
                  }}
                >
                  Edit
                </button>
              </div>
            ) : (
              <>
                <textarea
                  className="w-full rounded-md border border-accent/50 bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink outline-none focus:border-accent"
                  style={{ minHeight: 240, resize: 'vertical' }}
                  value={jsonDraft}
                  onChange={e => setJsonDraft(e.target.value)}
                  spellCheck={false}
                />
                {jsonEditError && (
                  <p className="text-[11px] text-danger">{jsonEditError}</p>
                )}
                <div className="flex gap-1.5">
                  <button
                    className="cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 font-sans text-[11px] font-bold text-white outline-none hover:brightness-108"
                    type="button"
                    onClick={() => {
                      try {
                        const parsed: unknown = JSON.parse(jsonDraft)
                        if (!isRecord(parsed)) throw new Error('JSON must be an object')
                        const definition = templateToSchemaDefinition(parsed)
                        const newNodes = definition.schemaNodes
                        nodesRef.current = newNodes
                        setNodes(newNodes)
                        setRecordDescriptionDraft(definition.recordDescription)
                        onNodesChangeRef.current(
                          newNodes,
                          '✎ Schema updated via JSON editor',
                          definition.recordDescription,
                        )
                        setJsonEditMode(false)
                        setJsonEditError(null)
                      } catch (e) {
                        setJsonEditError(e instanceof Error ? e.message : 'Invalid JSON')
                      }
                    }}
                  >
                    Save
                  </button>
                  <button
                    className="cursor-pointer rounded-md border border-line-strong bg-surface px-2.5 py-1 font-sans text-[11px] font-semibold text-ink-muted outline-none hover:text-accent"
                    type="button"
                    onClick={() => { setJsonEditMode(false); setJsonEditError(null) }}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {ready && view === 'fields' && (
          <>
            {mutationError && <p className="mb-2 text-[11px] font-semibold text-danger" role="alert">{mutationError}</p>}
            {selectedIds.size > 0 && (
              <div className="sticky top-0 z-10 mb-2 flex items-center justify-between rounded-lg border border-danger/30 bg-danger-soft px-3 py-1.5 shadow-float">
                <span className="text-[12px] font-semibold text-danger">
                  {selectedIds.size} field{selectedIds.size !== 1 ? 's' : ''} selected
                </span>
                <div className="flex gap-2">
                  <button
                    className="cursor-pointer rounded-md px-2 py-1 text-[11.5px] font-semibold text-ink-muted hover:text-ink outline-none"
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                  >
                    Cancel
                  </button>
                  <button
                    className="cursor-pointer rounded-md bg-danger px-2.5 py-1 text-[11.5px] font-semibold text-white outline-none hover:brightness-110"
                    type="button"
                    onClick={bulkRemoveNodes}
                  >
                    Delete
                  </button>
                </div>
              </div>
            )}
            <div className="flex flex-col">
              {(pending ? pending.reviewNodes : nodes).map((node, i) => renderRootField(node, i))}
              {/* final root slot */}
              <div className={slotCls(null, nodes.length)} onMouseEnter={() => setSlotTarget(null, nodes.length)} />
            </div>
            <button
              className="mt-2.5 block w-full cursor-pointer rounded-lg border-[1.5px] border-dashed border-line-strong bg-transparent py-2 text-xs font-semibold text-ink-muted outline-none transition-colors hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
              type="button"
              onClick={addField}
            >
              + Add field
            </button>
          </>
        )}
      </div>

      {/* Pre-generation instructions: recorded locally as the instruction
          source for "Generate schema". Hidden once ready, where the bottom slot
          switches to the schema edit-chat below — a different mechanism (it
          walks proposed changes node by node) that this doesn't replace. */}
      {!ready && (
        <div className="flex shrink-0 flex-col border-t border-line bg-surface-muted" style={{ maxHeight: 224 }}>
          <div className="flex shrink-0 items-center justify-between border-b border-line px-3.5 py-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Instructions</span>
            {state.status === 'idle' && (
              <button className={genBtnCls} type="button" onClick={() => onGenerate(docInstruction)}>
                Generate schema{instructionCountLabel}
              </button>
            )}
          </div>
          <div ref={docChatRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">
            <div className="flex flex-col gap-2">
              {docInstructions.length === 0 && (
                <p className="flex items-center gap-1.5 text-[11.5px] leading-relaxed text-ink-faint">
                  Add instructions for schema generation.
                  <span className="shrink-0 rounded bg-canvas px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ink-faint">
                    Optional
                  </span>
                </p>
              )}
              {docInstructions.map((instruction, i) => (
                <div key={instruction.id} className="flex flex-col gap-1">
                  <div className={msgCls('user')}>{instruction.text}</div>
                  <div className="flex items-center gap-1.5 self-start pl-1 text-[10.5px] text-ink-faint">
                    <span>Instruction {i + 1} of {docInstructions.length}</span>
                    <button
                      type="button"
                      className="cursor-pointer font-semibold outline-none hover:text-danger"
                      title="Remove this instruction"
                      onClick={() => removeDocInstruction(instruction.id)}
                    >
                      ✗
                    </button>
                  </div>
                  {i === docInstructions.length - 1 && (
                    <div className={msgCls('assistant')}>
                      Got it — recorded for schema generation. Add more instructions, or click{' '}
                      <span className="font-semibold text-ink">Generate schema</span> above when you're ready.
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="shrink-0 px-3.5 pb-3 pt-1.5">
            <div className="flex items-end gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 py-1.5">
              <textarea
                className="min-w-0 flex-1 resize-none bg-transparent font-sans text-xs text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
                rows={2}
                placeholder='Add a generation instruction (e.g. "Focus on names, dates, and locations")…'
                value={docChatDraft}
                onChange={e => setDocChatDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    sendDocChatMessage()
                  }
                }}
              />
              <button
                type="button"
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-accent text-xs text-white outline-none hover:brightness-108 disabled:opacity-40"
                disabled={!docChatDraft.trim()}
                onClick={sendDocChatMessage}
              >
                ↑
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Chat panel */}
      {ready && (
        <div className="flex shrink-0 flex-col border-t border-line bg-surface-muted" style={{ maxHeight: 224 }}>
          <div className="flex shrink-0 items-center justify-between border-b border-line px-3.5 py-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Chat</span>
            <div className="relative">
              <button
                className="cursor-pointer rounded-md border border-line bg-surface p-1 text-ink-muted outline-none transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-default disabled:opacity-40"
                type="button"
                aria-label="Schema history"
                title="Schema edit history"
                disabled={history.length === 0 || historyRestoring}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v5a1 1 0 00.293.707l3 3a1 1 0 001.414-1.414L11 9.586V5z" clipRule="evenodd" />
                </svg>
              </button>
              {historyOpen && (
                <div className="scrollbar-subtle absolute right-0 bottom-full z-30 mb-1.5 max-h-80 w-72 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-float">
                  {history.map((revision) => (
                    <button
                      key={revision.schemaRevisionId}
                      type="button"
                      className="block w-full rounded-md px-3 py-2 text-left outline-none hover:bg-accent-ghost"
                      aria-label={`Revision ${revision.revisionNumber}: ${revision.summary}`}
                      disabled={historyRestoring}
                      onClick={() => void restoreRevision(revision)}
                    >
                      <span className="block text-xs font-semibold text-ink">
                        Revision {revision.revisionNumber}{revision.revisionNumber === currentRevisionNumber ? ' · Current' : ''}
                      </span>
                      <span className="block text-[11px] text-ink-muted">{revision.origin} · {revision.summary}</span>
                      <span className="block text-[10px] text-ink-faint">{new Date(revision.createdAt).toLocaleString()}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div ref={chatRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-3.5 py-2.5">
            <div className="flex flex-col gap-2">
              {chat.map((m, i) => (
                <div key={i} className={msgCls(m.role)}>{m.text}</div>
              ))}
              {chatLoading && (
                <div className="self-start rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-2">
                  <span className="flex gap-1">
                    <span className="animate-pulse text-ink-faint text-sm">•</span>
                    <span className="animate-pulse text-ink-faint text-sm" style={{ animationDelay: '0.15s' }}>•</span>
                    <span className="animate-pulse text-ink-faint text-sm" style={{ animationDelay: '0.3s' }}>•</span>
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Apply / Discard action bar — sticky, outside scroll area */}
          {pending && (
            <div className="shrink-0 border-t border-line px-3.5 py-2.5">
              <div className="mb-2 text-[10px] leading-relaxed text-ink-muted" data-testid="schema-proposal-summary">
                <p>{proposalCounts!.accepted} accepted · {proposalCounts!.rejected} rejected</p>
                <p>{proposalCounts!.applied} applied · {proposalCounts!.unresolved} unresolved · {proposalCounts!.conflicts} conflicts</p>
                {metadataCounts && (metadataCounts.descriptions > 0 || metadataCounts.allowedValues > 0) && (
                  <p>Metadata not directly editable by chat: {metadataCounts.descriptions} description{metadataCounts.descriptions === 1 ? '' : 's'} · {metadataCounts.allowedValues} allowed-value list{metadataCounts.allowedValues === 1 ? '' : 's'}</p>
                )}
                {pending.issues.map((issue, index) => <p key={`${issue.kind}-${issue.key}-${index}`}>{issue.kind}: {issue.key}</p>)}
                {pending.changes.map((change) => change.note ? <p key={`note-${change.id}`}>{change.note}</p> : null)}
                {pending.changes.map((change) => change.outcome === 'unresolved' && change.reason
                  ? <p key={`reason-${change.id}`}>{change.reason}</p>
                  : null)}
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="cursor-pointer rounded-md border border-accent bg-accent px-3.5 py-1.5 font-sans text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 disabled:cursor-default disabled:opacity-40"
                  type="button"
                  onClick={applyPending}
                  disabled={!canApply}
                >
                  Apply changes
                </button>
                <button
                  className="cursor-pointer rounded-md border border-line-strong bg-surface px-3 py-1.5 font-sans text-[11.5px] font-semibold text-ink-muted outline-none hover:text-accent"
                  type="button"
                  onClick={discardPending}
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          <div className="shrink-0 px-3.5 pb-3 pt-1.5">
            <div className="flex items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 py-1.5">
              <input
                className="min-w-0 flex-1 bg-transparent font-sans text-xs text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
                placeholder="Describe a change to the schema…"
                value={chatInput}
                disabled={chatBlocked}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') void sendChatMessage(chatInput) }}
              />
              {chatLoading ? (
                <button
                  type="button"
                  className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-accent text-xs text-white outline-none hover:brightness-108"
                  onClick={cancelChat}
                  title="Stop generation"
                >
                  ■
                </button>
              ) : (
                <button
                  type="button"
                  className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-accent text-xs text-white outline-none hover:brightness-108 disabled:opacity-40"
                  disabled={!chatInput.trim() || chatBlocked}
                  onClick={() => void sendChatMessage(chatInput)}
                >
                  ↑
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2">
        <p className="text-[11px] leading-snug text-ink-faint">
          {state.status === 'generating' && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              Producing schema from the document…
            </span>
          )}
          {ready && `${displayedFieldCount} field${displayedFieldCount === 1 ? '' : 's'} `}
          {state.status === 'idle' && 'Generate to produce the schema from the document'}
          {state.status === 'error' && 'Generation failed'}
        </p>
        {ready && (
          <div className="flex shrink-0 items-center gap-2">
            <button className={genBtnCls} type="button" onClick={() => onGenerate(docInstruction)}>
              Regenerate{instructionCountLabel}
            </button>
          </div>
        )}
      </footer>

      {/* Drag overlay chip */}
      {dragging && (
        <div
          style={{ position: 'fixed', left: dragX + 18, top: dragY - 16, pointerEvents: 'none', zIndex: 9999 }}
          className="flex select-none items-center gap-1.5 rounded-lg border-[1.5px] border-accent bg-surface px-3 py-1.5 font-mono text-[12.5px] font-medium text-ink shadow-[0_4px_20px_rgba(51,48,44,.22)] whitespace-nowrap"
        >
          <span className="text-sm">{dragMode === 'indent' ? '→' : dragMode === 'outdent' ? '←' : '⠿'}</span>
          {dragging.name}
        </div>
      )}
    </div>
  )
}

export default SchemaPanel
