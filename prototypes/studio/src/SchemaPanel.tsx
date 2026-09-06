import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { requestSchemaEdit } from './api'
import type { SchemaEditorController } from './currentSchemaRevision'
import { countTemplateFields, isRecord } from '../shared/template'
import {
  FIELD_TYPES,
  SCALAR_FIELD_TYPES,
  type FieldType,
  type ScalarFieldType,
} from 'extraction/allowed-values'
import {
  type SchemaNode,
  enumerateFieldPaths,
  mkId,
  nodesToTemplate,
  schemaDefinitionToTemplate,
  templateToSchemaDefinition,
} from 'extraction/schema'
import type { SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import SchemaNameEditor from './SchemaNameEditor'
import {
  deriveSchemaProposal,
  type Change,
  type ReplayOutcome,
} from './schemaChanges'
import {
  InstructionCount,
  SchemaInstructionsChat,
  SchemaInstructionsDrawer,
} from './SchemaInstructions'
import { useSchemaInstructions } from './useSchemaInstructions'
import { ProposalReviewBar } from './SchemaProposalReview'
import { useSchemaProposalReview } from './useSchemaProposalReview'
import {
  moveSchemaNodes,
  removeSchemaNode,
  schemaAncestorIds,
  schemaDragMode,
  updateSchemaNode,
} from './schemaEditorTree'

const EMPTY_NODES: SchemaNode[] = []

const CHAT_GREETING = "Edit through drag and drop, or describe a change. I'll show you the changes before you apply them."

type SchemaPanelProps = {
  schema: SchemaEditorController
  /** Extraction Schema generation; omitted where generation is unavailable. */
  onGenerateInstructions?: (instruction: string) => void
  /** Clear-schema behaviour: workspace reset, batch empty-and-flush, etc. */
  onClearDraft: () => void | Promise<void>
  sourceDocumentName: string
  schemaName?: string | null
  onRenameSchema?: (name: string) => Promise<string | null>
  readOnly?: boolean
  showRegenerate?: boolean
  /** Reports edits visible in the panel that are not yet in its controller. */
  onPendingLocalEditChange?: (pending: boolean) => void
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

type FieldEditing = {
  id: string
  name: string
  type: FieldType
  itemType?: ScalarFieldType | null
  allowedValues?: string[]
}

function editedField(node: SchemaNode, name: string, editing: FieldEditing): SchemaNode {
  const base = { id: node.id, name, ...(node.description && { description: node.description }) }
  if (editing.type === 'object') {
    return { ...base, type: 'object', children: node.children ?? [] }
  }
  if (editing.type === 'array') {
    return editing.itemType === null
      ? { ...base, type: 'array', children: node.children ?? [] }
      : {
          ...base,
          type: 'array',
          itemType: editing.itemType ?? (node.type === 'array' && node.children === undefined ? node.itemType : 'string'),
        }
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
    itemType: node.type === 'array' ? (node.children === undefined ? node.itemType : null) : undefined,
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
      className="min-w-0 shrink cursor-pointer truncate rounded bg-canvas px-1.5 py-0.5 font-mono text-[10px] text-ink-muted outline-none transition-colors hover:bg-accent-soft hover:text-accent disabled:cursor-default disabled:opacity-60 disabled:hover:bg-canvas disabled:hover:text-ink-muted"
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
  if (!change?.reason) {
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
  return (
    <span
      className="shrink-0 rounded bg-danger-soft px-1.5 py-0.5 text-[9px] font-semibold text-danger"
      title={change.reason}
    >
      Conflict
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



function fieldTypeLabel(node: SchemaNode): string {
  if (node.type !== 'array') return node.type
  return node.children === undefined ? `array<${node.itemType}>` : 'array<object>'
}

function FieldTypeBadge({ node, onEdit, disabled }: { node: SchemaNode; onEdit?: () => void; disabled?: boolean }) {
  const label = fieldTypeLabel(node)
  const className = 'shrink-0 rounded bg-canvas px-1.5 py-0.5 font-mono text-[9px] text-ink-muted'
  if (!onEdit) return <span className={className}>{label}</span>
  return (
    <button
      type="button"
      className={`${className} cursor-pointer outline-none transition-colors hover:bg-accent-soft hover:text-accent disabled:cursor-default disabled:opacity-60`}
      title={`Type: ${label} — click to edit`}
      disabled={disabled}
      onClick={onEdit}
    >
      {label}
    </button>
  )
}

function FieldChangeLabel({ node, change, impliedRemoved }: { node: SchemaNode; change?: Change; impliedRemoved?: boolean }) {
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
    : change?.kind === 'removed' || impliedRemoved
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


function subtreeIdsOf(node: SchemaNode): string[] {
  const ids = [node.id]
  for (const child of node.children ?? []) ids.push(...subtreeIdsOf(child))
  return ids
}

/** Per-field notes set via the "i" description button, so Regenerate carries them into the instruction. */
function fieldDescriptionsInstruction(nodes: readonly SchemaNode[]): string {
  const notes = enumerateFieldPaths(nodes)
    .filter(({ node }) => node.description)
    .map(({ path, node }) => `- ${path.join('.')}: ${node.description}`)
  return notes.length ? `Field notes from the current schema:\n${notes.join('\n')}` : ''
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
  'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-accent bg-accent px-3 py-1.5 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-50 disabled:hover:brightness-100'

// Superseded by the pre-generation doc chat (see below) — schema generation no
// longer takes a highlights hints/fields mode. Left in place, commented out,
// rather than deleted.
//
// function AnnotationsModeToggle({ mode, onChange }: { mode: AnnotationsMode; onChange: (mode: AnnotationsMode) => void }) {
//   const seg = (active: boolean) =>
//     `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors ${active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'}`
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
        <button className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-muted outline-none hover:text-accent" type="button" aria-label="Cancel field edit" onClick={onCancel}>✗</button>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-[10px] font-semibold text-ink-muted">
          <span className="shrink-0">Type</span>
          <select
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
            aria-label="Field type"
            value={editing.type}
            onChange={(event) => onChange({ ...editing, type: event.target.value as FieldType })}
          >
            {FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        {editing.type === 'array' && (
          <label className="flex min-w-0 flex-1 items-center gap-2 text-[10px] font-semibold text-ink-muted">
            <span className="shrink-0">Items</span>
            <select
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
              aria-label="Array item type"
              value={editing.itemType === null ? 'object' : editing.itemType ?? 'string'}
              onChange={(event) => onChange({
                ...editing,
                itemType: event.target.value === 'object' ? null : event.target.value as ScalarFieldType,
              })}
            >
              {SCALAR_FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
              <option value="object">object</option>
            </select>
          </label>
        )}
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

/** Notes accumulate: each Add appends a new line rather than replacing what's there. */
function DescriptionEditForm({ existing, value, onChange, onAdd, onDelete, onCancel }: {
  existing: string
  value: string
  onChange: (value: string) => void
  onAdd: () => void
  onDelete: () => void
  onCancel: () => void
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const notes = existing.split('\n').filter((line) => line.trim())

  if (confirmingDelete) {
    return (
      <div className="mt-0.5 mb-0.5 flex items-center justify-between gap-1.5 rounded-md border border-danger/30 bg-danger-soft px-2 py-1">
        <span className="text-[12px] font-semibold text-danger">Clear all notes on this field?</span>
        <div className="flex shrink-0 gap-1.5">
          <button className="cursor-pointer rounded-md px-2 py-0.5 text-[11px] font-semibold text-ink-muted outline-none hover:text-ink" type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
          <button className="cursor-pointer rounded-md bg-danger px-2 py-0.5 text-[11px] font-semibold text-white outline-none hover:brightness-110" type="button" onClick={onDelete}>Clear</button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-0.5 mb-0.5 flex flex-col gap-1 rounded-md border border-accent/50 bg-accent-ghost px-2 py-1.5">
      {notes.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {notes.map((note, i) => (
            <li key={i} className="text-[11.5px] leading-snug text-ink">{note}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <input
          className="min-w-0 flex-1 bg-transparent font-sans text-[12px] text-ink outline-none placeholder:text-ink-faint"
          placeholder={notes.length > 0 ? 'Add another note…' : 'Describe this field for the extraction model…'}
          value={value}
          autoFocus
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onAdd(); if (e.key === 'Escape') onCancel() }}
        />
        <button
          className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2 py-0.5 text-[11px] font-bold text-white outline-none transition-[filter] hover:brightness-108 disabled:cursor-default disabled:opacity-50"
          type="button"
          disabled={!value.trim()}
          onClick={onAdd}
        >
          Add
        </button>
        {notes.length > 0 && (
          <button
            className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted outline-none hover:text-danger"
            type="button"
            title="Clear all notes"
            onClick={() => setConfirmingDelete(true)}
          >🗑</button>
        )}
        <button className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted outline-none hover:text-accent" type="button" title="Close" onClick={onCancel}>✗</button>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Main component
// ────────────────────────────────────────────────────────────────────────────

function SchemaPanel({
  schema,
  onGenerateInstructions,
  onClearDraft,
  sourceDocumentName,
  schemaName,
  onRenameSchema,
  readOnly = false,
  showRegenerate = true,
  onPendingLocalEditChange,
}: SchemaPanelProps) {
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const nodes =
    snap.historicalPreview?.schemaNodes ?? snap.draft?.schemaNodes ?? EMPTY_NODES
  const editorReadOnly = readOnly || snap.historicalPreview !== null
  const instructions = useSchemaInstructions()
  // ── render state ──
  const [dragging, setDragging] = useState<DragState | null>(null)
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const [overTarget, setOverTarget] = useState<DropTarget | null>(null)
  const [editing, setEditing] = useState<FieldEditing | null>(null)
  const [provisionalField, setProvisionalField] =
    useState<FieldEditing | null>(null)
  const [editingError, setEditingError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: 'assistant', text: CHAT_GREETING },
  ])
  const appendChatMessage = useCallback(
    (message: string) =>
      setChat((current) => [...current, { role: 'assistant', text: message }]),
    [],
  )
  const proposalReview = useSchemaProposalReview(schema, appendChatMessage)
  const {
    pending,
    acceptedChangeIds,
    replay,
    canApply,
    reset: resetProposal,
  } = proposalReview
  const resetInstructions = instructions.reset
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const chatAbortRef = useRef<AbortController | null>(null)
  useEffect(() => () => {
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
  }, [])
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [openDescId, setOpenDescId] = useState<string | null>(null)
  const [descDraft, setDescDraft] = useState('')
  const [jsonEditMode, setJsonEditMode] = useState(false)
  const [jsonDraft, setJsonDraft] = useState('')
  const [jsonEditError, setJsonEditError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [creatingFromHistory, setCreatingFromHistory] = useState(false)
  const [confirmingDeleteSchema, setConfirmingDeleteSchema] = useState(false)


  // ── refs for event handlers (avoid stale closures) ──
  const draggingRef = useRef<DragState | null>(null)
  const overTargetRef = useRef<DropTarget | null>(null)
  const dragYRef = useRef(0)
  const dragXRef = useRef(0)
  const dragStartXRef = useRef(0)
  const dragStartYRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [recordDescriptionDraft, setRecordDescriptionDraft] = useState(
    () => snap.draft?.recordDescription ?? '',
  )
  const chatRef = useRef<HTMLDivElement>(null)
  const creatingFromHistoryRef = useRef(false)

  const ready = snap.view === 'editing'
  const displayedFieldCount = ready ? countTemplateFields(nodesToTemplate(nodes)) : 0
  const dx = dragging ? dragX - dragStartXRef.current : 0
  const dy = dragging ? dragY - dragStartYRef.current : 0
  const dragMode = schemaDragMode(dx, dy)

  // Keep local keystrokes while editing normally. Wholesale external
  // replacements reset every draft-dependent editor surface together.
  const committedRecordDescription =
    snap.historicalPreview?.recordDescription ?? snap.draft?.recordDescription
  useEffect(() => {
    if (committedRecordDescription === undefined) return
    setRecordDescriptionDraft(committedRecordDescription)
  }, [committedRecordDescription])

  const pendingLocalEdit =
    !editorReadOnly &&
    (editing !== null ||
      provisionalField !== null ||
      openDescId !== null ||
      jsonEditMode ||
      chatLoading ||
      pending !== null ||
      recordDescriptionDraft !== (committedRecordDescription ?? ''))
  useEffect(() => {
    onPendingLocalEditChange?.(pendingLocalEdit)
  }, [onPendingLocalEditChange, pendingLocalEdit])
  useEffect(
    () => () => onPendingLocalEditChange?.(false),
    [onPendingLocalEditChange],
  )

  const resetEditorUi = useCallback(
    (clearConversation = false) => {
      chatAbortRef.current?.abort()
      chatAbortRef.current = null
      setChatLoading(false)
      setEditing(null)
      setProvisionalField(null)
      setEditingError(null)
      setMutationError(null)
      resetProposal()
      setSelectedIds(new Set())
      setOpenDescId(null)
      setJsonEditMode(false)
      setJsonDraft('')
      setJsonEditError(null)
      setView('fields')
      setExpandedIds(new Set())
      setDescDraft('')
      setChatInput('')
      setHistoryError(null)
      setConfirmingDeleteSchema(false)
      setRecordDescriptionDraft(
        schema.snapshot().draft?.recordDescription ?? '',
      )
      if (clearConversation) {
        setHistoryOpen(false)
        resetInstructions()
        setChat([{ role: 'assistant', text: CHAT_GREETING }])
      }
    },
    [resetInstructions, resetProposal, schema],
  )
  const observedReplacementVersion = useRef(snap.replacementVersion)
  useEffect(() => {
    if (observedReplacementVersion.current === snap.replacementVersion) return
    observedReplacementVersion.current = snap.replacementVersion
    resetEditorUi()
  }, [resetEditorUi, snap.replacementVersion])

  // Keep the newest chat message visible.
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, pending])


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

  function applyMove(nextNodes: SchemaNode[]) {
    const result = schema.commit(() => nextNodes, '⠿ Schema reordered')
    if (result.ok) setMutationError(null)
    else if (result.reason === 'duplicate-name')
      setMutationError(
        `Cannot move field: a sibling field already uses “${result.duplicateName}”.`,
      )
    else setMutationError('No schema draft is open.')
  }

  async function previewHistory(revision: SchemaRevisionSummary) {
    setHistoryOpen(false)
    if (revision.revisionNumber === snap.currentRevisionNumber) {
      schema.closeHistoricalPreview()
      return
    }
    setHistoryError(null)
    try {
      await schema.previewHistoricalRevision(revision.schemaRevisionId)
    } catch (error) {
      setHistoryError(
        error instanceof Error
          ? error.message
          : 'Could not load the historical Schema Revision.',
      )
    }
  }

  async function createFromHistory() {
    const revision = schema.snapshot().historicalPreview
    if (!revision || creatingFromHistoryRef.current) return

    creatingFromHistoryRef.current = true
    setCreatingFromHistory(true)
    setHistoryError(null)
    try {
      await schema.createCurrentRevisionFromHistory(revision.schemaRevisionId)
    } catch (error) {
      setHistoryError(
        error instanceof Error
          ? error.message
          : 'Could not create a Current Schema Revision from history.',
      )
    } finally {
      creatingFromHistoryRef.current = false
      setCreatingFromHistory(false)
    }
  }

  async function deleteSchema() {
    try {
      await onClearDraft()
    } catch {
      return
    }
    resetEditorUi(true)
  }


  function commitDrop() {
    const drag = draggingRef.current
    if (!drag) return
    const current = schema.snapshot().draft?.schemaNodes ?? EMPTY_NODES
    const moved = moveSchemaNodes(
      current,
      drag,
      overTargetRef.current,
      dragXRef.current - dragStartXRef.current,
      dragYRef.current - dragStartYRef.current,
    )
    if (!moved) {
      setMutationError('Cannot move field into its own contents.')
      return
    }
    applyMove(moved)
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
    if (editorReadOnly) return
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
    const result =
      provisionalField?.id === editing.id
        ? schema.commit(
            (current) => [
              ...current,
              editedField(
                {
                  id: editing.id,
                  name,
                  type: 'verbatim-string',
                },
                name,
                editing,
              ),
            ],
            '✎ Schema updated',
          )
        : schema.commit(
            (current) =>
              updateSchemaNode(current, editing.id, (node) =>
                editedField(node, name, editing),
              ),
            '✎ Schema updated',
          )
    if (!result.ok) {
      setEditingError(
        result.reason === 'duplicate-name'
          ? `A sibling field already uses “${result.duplicateName}”.`
          : 'No schema draft is open.',
      )
      return
    }
    setProvisionalField(null)
    setEditing(null)
    setEditingError(null)
  }

  function cancelEdit() {
    if (editing?.id === provisionalField?.id) setProvisionalField(null)
    setEditing(null)
    setEditingError(null)
  }

  function bulkRemoveNodes() {
    const count = selectedIds.size
    // Removals cannot create duplicate sibling names; the gate's scan passes.
    schema.commit((current) => {
      let next = current
      for (const id of selectedIds) {
        const [, after] = removeSchemaNode(next, id)
        next = after
      }
      return next
    }, `${count} field${count !== 1 ? 's' : ''} removed`)
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
    schema.commit(
      (current) => updateSchemaNode(current, id, (node) => ({ ...node, description })),
      '✎ Description updated',
    )
  }

  /** Each "i" note appends as a new line rather than replacing the field's existing notes. */
  function addNodeDescriptionNote(id: string, existing: string | undefined, draft: string) {
    const note = draft.trim()
    if (!note) return
    updateNodeDescription(id, existing ? `${existing}\n${note}` : note)
    setDescDraft('')
  }

  function addField() {
    if (editing) return
    const cur = schema.snapshot().draft?.schemaNodes ?? EMPTY_NODES
    let name = 'nyt_felt'
    let suffix = 2
    while (cur.some(n => n.name === name)) name = `nyt_felt_${suffix++}`
    const id = mkId()
    const next = { id, name, type: 'verbatim-string' as const }
    setProvisionalField(next)
    setView('fields')
    setEditing(next)
  }

  function commitRecordDescription() {
    schema.setRecordDescription(recordDescriptionDraft)
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

    const versionBeforeFlush = schema.snapshot().draftVersion
    try {
      const modelContext = await schema.requestModelEdit()
      if (schema.snapshot().draftVersion !== versionBeforeFlush) {
        setChat(c => [...c, { role: 'assistant', text: 'Schema changed while the request was running. Send the request again.' }])
        return
      }
      const original = schema.snapshot().draft?.schemaNodes ?? EMPTY_NODES
      const originalDraftVersion = schema.snapshot().draftVersion
      if (!modelContext) {
        setChat(c => [
          ...c,
          {
            role: 'assistant',
            text: 'Save this Extraction Schema before requesting a model edit.',
          },
        ])
        return
      }
      const originalSchemaRevisionId = modelContext.schemaRevisionId
      const response = await requestSchemaEdit(
        modelContext,
        userMsg,
        controller.signal,
      )
      const currentAfterResponse = schema.snapshot()
      if (
        currentAfterResponse.draftVersion !== originalDraftVersion ||
        currentAfterResponse.extractableSchemaRevisionId !==
          originalSchemaRevisionId
      ) {
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
          proposalReview.start(
            proposal,
            original,
            originalDraftVersion,
            originalSchemaRevisionId,
          )
          const ancestors = schemaAncestorIds(proposal.reviewNodes, new Set(proposal.changes.map(({ id }) => id)))
          setExpandedIds((current) => new Set([...current, ...ancestors]))
        }
      }
    } catch (err) {
      if (chatAbortRef.current !== controller) return
      if (
        typeof err === 'object' &&
        err !== null &&
        'name' in err &&
        err.name === 'AbortError'
      ) {
        setChat(c => [...c, { role: 'assistant', text: 'Cancelled.' }])
      } else {
        setChatInput(userMsg)
        setChat(c => [...c, { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : 'Request failed'}` }])
      }
    } finally {
      if (chatAbortRef.current === controller) {
        chatAbortRef.current = null
        setChatLoading(false)
      }
    }
  }

  function cancelChat() {
    chatAbortRef.current?.abort()
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

  const editDisabled = editorReadOnly || !!dragging

  const chatBlocked = !!pending || chatLoading

  const tabCls = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors ${active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'}`

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
            onCancel={cancelEdit}
          />
        ) : (
          <div
            className={`${rowCls(node.id, intoGroup, isDragging)} ${diffBg}`}
            onMouseEnter={() => !isDiff && setGroupTarget(node.id, node.name)}
            onMouseLeave={() => !isDiff && clearGroupTarget(node.id)}
          >
            {!isDiff && !editorReadOnly && (
              <span
                className="shrink-0 cursor-grab select-none px-0.5 text-sm leading-none text-ink-faint"
                onMouseDown={e => startDrag(e, node.id, null, node.name, isGroup)}
              >
                ⠿
              </span>
            )}
            <FieldChangeLabel node={node} change={change} />
            {!isDiff && (
              <FieldTypeBadge
                node={node}
                disabled={editDisabled}
                onEdit={!editorReadOnly ? () => { setEditing(editingOf(node)); setEditingError(null) } : undefined}
              />
            )}
            <AllowedValuesBadge
              node={node}
              disabled={editDisabled}
              onEdit={!isDiff && !editorReadOnly ? () => { setEditing(editingOf(node)); setEditingError(null) } : undefined}
            />
            <ChangeBadge change={change} outcome={change && replay?.outcomes.get(change.id)} />
            {intoGroup && !isDiff && (
              <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white whitespace-nowrap">
                into {node.name}
              </span>
            )}
            <span className="min-w-0 flex-1" />
            {change && <AcceptanceControl id={change.id} name={change.after?.name ?? node.name} accepted={acceptedChangeIds.has(change.id)} onChange={proposalReview.toggle} />}
            {!isDiff && !editorReadOnly && (
              <button
                className={`shrink-0 cursor-pointer px-1 leading-none outline-none transition-colors focus-visible:text-accent ${node.description ? 'text-accent' : 'text-ink-muted hover:text-accent'}`}
                type="button"
                title="Add description"
                onClick={() => {
                  const next = openDescId === node.id ? null : node.id
                  if (next) setDescDraft('')
                  setOpenDescId(next)
                }}
              >
                <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/></svg>
              </button>
            )}
            {!isDiff && !editorReadOnly && (
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
            {!isDiff && !editorReadOnly && (
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

        {openDescId === node.id && (
          <DescriptionEditForm
            existing={node.description ?? ''}
            value={descDraft}
            onChange={setDescDraft}
            onAdd={() => addNodeDescriptionNote(node.id, node.description, descDraft)}
            onDelete={() => { updateNodeDescription(node.id, undefined); setOpenDescId(null) }}
            onCancel={() => setOpenDescId(null)}
          />
        )}

        {/* Nested children area — shown when there are children or dragging (for drop slot) */}
        {isGroup && ((node.children ?? []).length > 0 || !!dragging) && (
          <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
            {(node.children ?? []).map((child, j) => renderChildField(child, node.id, j, diffStatus === 'removed'))}
            <div
              className={slotCls(node.id, (node.children ?? []).length)}
              onMouseEnter={() => setSlotTarget(node.id, (node.children ?? []).length)}
            />
          </div>
        )}
      </div>
    )
  }

  function renderChildField(child: SchemaNode, parentId: string, j: number, ancestorRemoved = false): React.ReactNode {
    const isDragging = dragging?.id === child.id
    const isEditing = editing?.id === child.id
    const isGroup = child.children !== undefined
    const intoGroup = dragMode === 'normal' && overTarget?.type === 'group' && overTarget.id === child.id
    const isExpanded = expandedIds.has(child.id) || intoGroup
    const change = pending?.changes.find((item) => item.id === child.id)
    const diffStatus = change?.kind ?? (ancestorRemoved ? 'removed' : null)
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
            onCancel={cancelEdit}
          />
        ) : (
          <div
            className={`-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 border transition-opacity duration-100 ${intoGroup && !isDiff ? 'border-accent/40 bg-accent-soft' : 'border-transparent'} ${isDragging ? 'opacity-40' : ''} ${diffBg}`}
          >
            {!isDiff && !editorReadOnly && (
              <span
                className="shrink-0 cursor-grab select-none px-0.5 text-[13px] leading-none text-ink-faint"
                onMouseDown={e => startDrag(e, child.id, parentId, child.name, isGroup)}
              >
                ⠿
              </span>
            )}
            <FieldChangeLabel node={child} change={change} impliedRemoved={ancestorRemoved} />
            {!isDiff && (
              <FieldTypeBadge
                node={child}
                disabled={editDisabled}
                onEdit={!editorReadOnly ? () => { setEditing(editingOf(child)); setEditingError(null) } : undefined}
              />
            )}
            <AllowedValuesBadge
              node={child}
              disabled={editDisabled}
              onEdit={!isDiff && !editorReadOnly ? () => { setEditing(editingOf(child)); setEditingError(null) } : undefined}
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
            {change && <AcceptanceControl id={change.id} name={change.after?.name ?? child.name} accepted={acceptedChangeIds.has(change.id)} onChange={proposalReview.toggle} />}
            {!isDiff && !editorReadOnly && (
              <button
                className={`shrink-0 cursor-pointer px-1 leading-none outline-none transition-colors focus-visible:text-accent ${child.description ? 'text-accent' : 'text-ink-muted hover:text-accent'}`}
                type="button"
                title="Add description"
                onClick={() => {
                  const next = openDescId === child.id ? null : child.id
                  if (next) setDescDraft('')
                  setOpenDescId(next)
                }}
              >
                <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clipRule="evenodd"/></svg>
              </button>
            )}
            {!isDiff && !editorReadOnly && (
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
            {!isDiff && !editorReadOnly && (
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

        {openDescId === child.id && (
          <DescriptionEditForm
            existing={child.description ?? ''}
            value={descDraft}
            onChange={setDescDraft}
            onAdd={() => addNodeDescriptionNote(child.id, child.description, descDraft)}
            onDelete={() => { updateNodeDescription(child.id, undefined); setOpenDescId(null) }}
            onCancel={() => setOpenDescId(null)}
          />
        )}

        {/* Children area — shown when expanded and has children or dragging (for drop slot) */}
        {isGroup && isExpanded && ((child.children ?? []).length > 0 || !!dragging) && (
          <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
            {(child.children ?? []).map((grandchild, k) => renderChildField(grandchild, child.id, k, ancestorRemoved || diffStatus === 'removed'))}
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
        <div className="min-w-0 flex-1">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">Extraction Schema</h2>
          {schemaName && ready ? (
            editorReadOnly || !onRenameSchema ? (
              <p className="h-7 truncate font-mono text-[13px] font-medium leading-7 text-ink">{schemaName}</p>
            ) : (
              <SchemaNameEditor
                name={schemaName}
                className="font-mono text-[13px] font-medium text-ink"
                onSubmit={onRenameSchema}
              />
            )
          ) : (
            <p className="h-7 truncate font-mono text-[13px] font-medium leading-7 text-ink">{sourceDocumentName}</p>
          )}
        </div>
        {ready && (
          <div className="flex shrink-0 items-center gap-2">
            <div className="flex overflow-hidden rounded-md border border-line">
              <button className={tabCls(view === 'fields')} type="button" aria-pressed={view === 'fields'} onClick={() => setView('fields')}>Fields</button>
              <button className={`${tabCls(view === 'json')} font-mono`} type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}>{'JSON'}</button>
            </div>
            {!editorReadOnly && <div className="relative">
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
            </div>}
          </div>
        )}
      </header>

      {/* ── Schema list / states ── */}
      <div ref={scrollRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {historyError && <p role="alert" className="mb-2 text-xs text-danger">{historyError}</p>}
        {snap.historicalPreview && (
          <div
            className="mb-3 flex items-center justify-between gap-3 rounded-md border border-accent/30 bg-accent-ghost px-3 py-2"
            role="status"
          >
            <p className="text-[11px] text-ink">
              Viewing historical Schema Revision{' '}
              {snap.historicalPreview.revisionNumber}. This preview is read-only.
            </p>
            <div className="flex shrink-0 gap-1.5">
              <button
                className="cursor-pointer rounded-md border border-line bg-surface px-2 py-1 text-[11px] font-semibold text-ink-muted outline-none hover:text-ink"
                type="button"
                onClick={() => schema.closeHistoricalPreview()}
              >
                Close preview
              </button>
              <button
                className="cursor-pointer rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-white outline-none hover:brightness-108 disabled:cursor-default disabled:opacity-50"
                type="button"
                disabled={creatingFromHistory}
                onClick={() => void createFromHistory()}
              >
                Create Current Schema Revision
              </button>
            </div>
          </div>
        )}
        {ready && snap.generating && (
          <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2" role="status">
            <p className="text-[11px] text-ink">Regenerating. The current saved schema remains available.</p>
            <button className={genBtnCls} type="button" onClick={() => schema.cancelGeneration()}>Stop</button>
          </div>
        )}
        {ready && snap.generationError && (
          <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2" role="alert">
            <p className="text-[11px] text-danger">Regeneration failed: {snap.generationError} The current saved schema is unchanged.</p>
          </div>
        )}
        {snap.save?.status === 'conflict' && (
          <div
            className="mb-2 flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2"
            role="alert"
          >
            <p className="text-[11px] text-danger">
              The Current Schema Revision changed elsewhere.
            </p>
            <button
              className="shrink-0 cursor-pointer rounded-md border border-danger/40 bg-surface px-2 py-1 text-[11px] font-semibold text-danger outline-none hover:bg-danger-soft"
              type="button"
              onClick={() => schema.reloadCurrent()}
            >
              Reload Current Schema Revision
            </button>
          </div>
        )}
        {snap.view === 'empty' && (
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
            <p className="text-[13px] font-semibold text-ink">No schema yet</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Chat to add instructions, or generate now.
            </p>
          </div>
        )}

        {snap.view === 'generating' && <WorkingIndicator onStop={() => schema.cancelGeneration()} />}

        {snap.view === 'failed' && (
          <div className="rounded-xl border border-dashed border-danger/40 px-4 py-6 text-center">
            <p className="text-[13px] leading-snug text-danger">{snap.generationError}</p>
            {onGenerateInstructions && (
              <button className={`${genBtnCls} mt-3`} type="button" onClick={() => onGenerateInstructions(instructions.text)}>Retry</button>
            )}
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
                {!editorReadOnly && <button
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
                </button>}
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
                        schema.replaceDraft(definition, '✎ Schema updated via JSON editor')
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
            <div className="mb-3 rounded-lg border border-line bg-canvas px-3 py-2.5">
              <p className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
                Record description
              </p>
              {editorReadOnly ? (
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {recordDescriptionDraft}
                </p>
              ) : (
                <textarea
                  aria-label="Record description"
                  className="mt-1 block w-full resize-none bg-transparent text-xs leading-relaxed text-ink outline-none placeholder:text-ink-faint"
                  rows={2}
                  value={recordDescriptionDraft}
                  placeholder="Describe the record represented by this schema…"
                  onChange={(event) =>
                    setRecordDescriptionDraft(event.target.value)
                  }
                  onBlur={commitRecordDescription}
                />
              )}
            </div>
            {mutationError && <p className="mb-2 text-[11px] font-semibold text-danger" role="alert">{mutationError}</p>}
            {!editorReadOnly && selectedIds.size > 0 && (
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
              {provisionalField && editing?.id === provisionalField.id && (
                <FieldEditForm
                  editing={editing}
                  error={editingError}
                  onChange={(next) => {
                    setEditing(next)
                    setProvisionalField(next)
                    setEditingError(null)
                  }}
                  onSave={saveEdit}
                  onCancel={cancelEdit}
                />
              )}
              {/* final root slot */}
              <div className={slotCls(null, nodes.length)} onMouseEnter={() => setSlotTarget(null, nodes.length)} />
            </div>
            {!editorReadOnly && <button
              className="mt-2.5 block w-full cursor-pointer rounded-lg border-[1.5px] border-dashed border-line-strong bg-transparent py-2 text-xs font-semibold text-ink-muted outline-none transition-colors hover:border-accent hover:text-accent focus-visible:border-accent focus-visible:text-accent"
              type="button"
              disabled={editing !== null}
              onClick={addField}
            >
              + Add field
            </button>}
          </>
        )}
      </div>

      {/* Pre-generation instructions: recorded locally as the instruction
          source for "Generate schema". Hidden once ready, where the bottom slot
          switches to the schema edit-chat below — a different mechanism (it
          walks proposed changes node by node) that this doesn't replace. */}
      {!ready && (
        <div className="flex shrink-0 flex-col border-t border-line bg-surface-muted" style={{ maxHeight: '60%' }}>
          <div className="flex shrink-0 items-center justify-between border-b border-line px-3.5 py-1.5">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Chat</span>
            {snap.view === 'empty' && onGenerateInstructions && (
              <button className={genBtnCls} type="button" onClick={() => onGenerateInstructions(instructions.text)}>
                Generate schema{instructions.countLabel}
              </button>
            )}
          </div>
          <SchemaInstructionsChat
            instructions={instructions}
            messageClass={msgCls}
          />
        </div>
      )}

      {/* Chat panel. Growing with conversation length is only wanted before a
          schema exists (see the !ready panel above) — once a schema has been
          generated, and especially while a diff is pending review, the chat
          must stay capped low so it doesn't cover the schema/diff above it. */}
      {ready && !editorReadOnly && (
        <div className="flex shrink-0 flex-col border-t border-line bg-surface-muted" style={{ maxHeight: pending ? '32%' : '45%' }}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line px-3.5 py-1">
            <span className="shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Chat</span>
            <div className="flex min-w-0 shrink items-center gap-1.5">
              {showRegenerate && (
                <div className="relative shrink-0">
                  <button
                    className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-accent/60 bg-accent-soft px-2.5 py-1 text-[11px] font-bold text-accent outline-none transition-colors hover:border-accent hover:brightness-105 disabled:cursor-default disabled:opacity-50 disabled:hover:border-accent/60 disabled:hover:brightness-100"
                    type="button"
                    aria-expanded={instructions.open}
                    title="Start over: regenerate the whole schema from the document and instructions"
                    disabled={snap.generating}
                    onClick={instructions.toggle}
                  >
                    Regenerate
                    <InstructionCount count={instructions.count} />
                    <span aria-hidden="true" className="text-[9px]">{instructions.open ? '▾' : '▸'}</span>
                  </button>
                  {instructions.open && (
                    <div className="scrollbar-subtle absolute right-0 bottom-full z-30 mb-1.5 w-80 overflow-hidden rounded-lg border border-line bg-surface shadow-float">
                      <SchemaInstructionsDrawer instructions={instructions} />
                      <div className="flex items-center justify-end gap-2 px-2.5 py-2">
                        <button
                          className={genBtnCls}
                          type="button"
                          onClick={() => {
                            instructions.toggle()
                            onGenerateInstructions?.(
                              [instructions.text, fieldDescriptionsInstruction(nodes)]
                                .filter(Boolean)
                                .join('\n\n'),
                            )
                          }}
                        >
                          Regenerate schema{instructions.countLabel}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="relative">
                <button
                  className="cursor-pointer rounded-md border border-line bg-surface p-1 text-ink-muted outline-none transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-default disabled:opacity-40"
                  type="button"
                  aria-label="Schema history"
                  title="Schema edit history"
                  disabled={snap.history.length === 0 || creatingFromHistory || snap.creatingFromRevisionId !== null || snap.previewingRevisionId !== null}
                  onClick={() => setHistoryOpen((open) => !open)}
                >
                  <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v5a1 1 0 00.293.707l3 3a1 1 0 001.414-1.414L11 9.586V5z" clipRule="evenodd" />
                  </svg>
                </button>
                {historyOpen && (
                <div className="scrollbar-subtle absolute right-0 bottom-full z-30 mb-1.5 max-h-80 w-72 overflow-y-auto rounded-lg border border-line bg-surface p-1 shadow-float">
                  {snap.history.map((revision) => (
                    <button
                      key={revision.schemaRevisionId}
                      type="button"
                      className="block w-full rounded-md px-3 py-2 text-left outline-none hover:bg-accent-ghost"
                      aria-label={`Revision ${revision.revisionNumber}: ${revision.summary}`}
                      disabled={creatingFromHistory || snap.previewingRevisionId !== null}
                      onClick={() => void previewHistory(revision)}
                    >
                      <span className="block text-xs font-semibold text-ink">
                        Revision {revision.revisionNumber}{revision.revisionNumber === snap.currentRevisionNumber ? ' · Current' : ''}
                      </span>
                      <span className="block text-[11px] text-ink-muted">{revision.origin} · {revision.summary}</span>
                      <span className="block text-[10px] text-ink-faint">{new Date(revision.createdAt).toLocaleString()}</span>
                    </button>
                  ))}
                </div>
                )}
              </div>
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
            <ProposalReviewBar
              proposal={pending}
              canApply={canApply}
              onApply={proposalReview.apply}
              onDiscard={proposalReview.discard}
            />
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
                  title="Stop schema edit request"
                  aria-label="Stop schema edit request"
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
          {snap.view === 'generating' && (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-amber-500" />
              Producing schema from the document…
            </span>
          )}
          {ready && `${displayedFieldCount} field${displayedFieldCount === 1 ? '' : 's'} `}
          {snap.view === 'empty' && 'Generate to produce the schema from the document'}
          {snap.view === 'failed' && 'Generation failed'}
        </p>
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
