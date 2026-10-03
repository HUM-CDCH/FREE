import { SchemaImport } from './SchemaImport'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { deleteModelOperation, requestSchemaEdit } from './api'
import { sourceCoverageNotice } from './sourceCoverageNotice'
import type { SchemaEditorController } from './currentSchemaRevision'
import { isRecord } from '../shared/template'
import {
  FIELD_TYPES,
  SCALAR_FIELD_TYPES,
  type FieldType,
  type ScalarFieldType,
} from 'extraction/allowed-values'
import {
  type RecordScope,
  type SchemaNode,
  enumerateFieldPaths,
  mkId,
  schemaDefinitionToTemplate,
  templateToSchemaDefinition,
} from 'extraction/schema'
import type { SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import { Button, EmptyState, ModalDialog, SegmentedControl, Toast } from './ui'
import FieldRow from './FieldRow'
import ChatDrawer from './ChatDrawer'
import { useToast } from './useToast'
import ActionsMenu, { type ActionItem } from './ActionsMenu'
import SchemaNameEditor from './SchemaNameEditor'
import { SchemaSaveStatus } from './SchemaSaveStatus'
import { defaultSchemaName, UNTITLED_SCHEMA_NAME } from './schemaNames'
import { deriveSchemaProposal } from '../shared/schemaChanges'
import {
  SchemaInstructionsChat,
  SchemaInstructionsDrawer,
} from './SchemaInstructions'
import { useSchemaInstructions } from './useSchemaInstructions'
import { ProposalReviewBar } from './SchemaProposalReview'
import { useSchemaProposalReview } from './useSchemaProposalReview'
import { useModelOperationRecovery } from './useModelOperationRecovery'
import {
  moveSchemaNodes,
  removeSchemaNode,
  restoreSchemaNode,
  schemaAncestorIds,
  schemaDragMode,
  updateSchemaNode,
} from './schemaEditorTree'

const EMPTY_NODES: SchemaNode[] = []
/** `ids` taken out of the collapsed set, so those groups show their children. */
const withoutIds = (current: ReadonlySet<string>, ids: Iterable<string>) => {
  const next = new Set(current)
  for (const id of ids) next.delete(id)
  return next
}

const scrollIntoViewOnce = (element: HTMLElement | null) => element?.scrollIntoView?.({ block: 'nearest' })
const focusField = (element: HTMLElement | null) => { scrollIntoViewOnce(element); element?.focus({ preventScroll: true }) }

export type FieldContext = {
  extractionId: string
  schemaRevisionId: string
  revisionNumber: number | undefined
  nodeId: string
  nodeType: SchemaNode['type']
  resultPaths: (string | number)[][]
}

const CONVERSATION_EMPTY = "Edit through drag and drop, or describe a change. I'll show you the changes before you apply them."

export type SchemaPanelProps = {
  schema: SchemaEditorController
  /** Extraction Schema generation; omitted where generation is unavailable. */
  onGenerateInstructions?: (instruction: string) => void
  /** Clear-schema behaviour: workspace reset, batch empty-and-flush, etc. */
  onClearDraft: () => void | Promise<void>
  sourceDocumentName: string
  /** The open Source Representation: a source declaration shows only beside the source it describes. */
  sourceRepresentationId?: string
  schemaName?: string | null
  onRenameSchema?: (name: string) => Promise<string | null>
  readOnly?: boolean
  showRegenerate?: boolean
  /** Reports edits visible in the panel that are not yet in its controller. */
  onPendingLocalEditChange?: (pending: boolean) => void
  fieldContext?: FieldContext | null
  /** The Article/Catalog choice under the schema name; null until one is saved. */
  recordScope?: { value: RecordScope | null; onChange: (scope: RecordScope) => void; disabled?: boolean }
  /** How catalogue entries are found, beside the record scope; omitted or null where it does not apply. */
  boundaries?: {
    value: string
    options: ReadonlyArray<{ id: string; label: string }>
    onChange: (id: string) => void
    disabled?: boolean
  } | null
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

type ChatMsg = { role: 'user' | 'assistant'; text: string }



// ────────────────────────────────────────────────────────────────────────────
// Data model and converters
// ────────────────────────────────────────────────────────────────────────────



// ────────────────────────────────────────────────────────────────────────────
// Node tree helpers (tasks 2.5, 3.4)
// ────────────────────────────────────────────────────────────────────────────


/** Per-field notes set from each row's note action, so Regenerate carries them into the instruction. */
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
      <p className="text-content font-semibold text-ink">Producing schema…</p>
      <p className="max-w-[34ch] text-secondary leading-snug text-ink-muted">This can take a while on large documents.</p>
      <Button variant="danger" size="sm" className="mt-1" onClick={onStop}>Stop</Button>
    </div>
  )
}

const dialogCls =
  'm-auto w-full max-w-sm rounded-card border border-line bg-surface p-4 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]'

const genBtnCls =
  'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-accent bg-accent px-3 py-1.5 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-50 disabled:hover:brightness-100'

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
        <Button variant="positive" disabled={!editing.name.trim()} onClick={onSave}>Save</Button>
        <Button aria-label="Cancel field edit" onClick={onCancel}>✗</Button>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-overline font-semibold text-ink-muted">
          <span className="shrink-0">Type</span>
          <select
            className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-compact text-ink outline-none focus-visible:border-accent"
            aria-label="Field type"
            value={editing.type}
            onChange={(event) => onChange({ ...editing, type: event.target.value as FieldType })}
          >
            {FIELD_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
          </select>
        </label>
        {editing.type === 'array' && (
          <label className="flex min-w-0 flex-1 items-center gap-2 text-overline font-semibold text-ink-muted">
            <span className="shrink-0">Items</span>
            <select
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-compact text-ink outline-none focus-visible:border-accent"
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
          <span className="text-overline font-semibold text-ink-muted">Allowed values (leave empty for free text)</span>
          {editing.allowedValues && editing.allowedValues.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {editing.allowedValues.map((value) => (
                <span key={value} className="flex items-center gap-1 rounded bg-canvas px-1.5 py-0.5 font-mono text-overline text-ink">
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
              className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-compact text-ink outline-none focus-visible:border-accent"
              value={newValue}
              placeholder="add value…"
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addValue() } }}
            />
            <Button onClick={addValue}>Add</Button>
          </div>
        </div>
      )}
      {error && <span className="text-overline font-semibold text-danger" role="alert">{error}</span>}
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
        <span className="text-secondary font-semibold text-danger">Clear all notes on this field?</span>
        <div className="flex shrink-0 gap-1.5">
          <Button onClick={() => setConfirmingDelete(false)}>Cancel</Button>
          <Button variant="danger" onClick={onDelete}>Clear</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-0.5 mb-0.5 flex flex-col gap-1 rounded-md border border-accent/50 bg-accent-ghost px-2 py-1.5">
      {notes.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {notes.map((note, i) => (
            <li key={i} className="text-compact leading-snug text-ink">{note}</li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <input
          className="min-w-0 flex-1 bg-transparent font-sans text-secondary text-ink outline-none placeholder:text-ink-faint"
          placeholder={notes.length > 0 ? 'Add another note…' : 'Describe this field for the extraction model…'}
          value={value}
          autoFocus
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') onAdd(); if (e.key === 'Escape') onCancel() }}
        />
        <Button variant="positive" disabled={!value.trim()} onClick={onAdd}>
          Add
        </Button>
        {notes.length > 0 && (
          <Button variant="danger" title="Clear all notes" onClick={() => setConfirmingDelete(true)}>🗑</Button>
        )}
        <Button title="Close" onClick={onCancel}>✗</Button>
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
  sourceRepresentationId,
  schemaName,
  onRenameSchema,
  readOnly = false,
  showRegenerate = true,
  onPendingLocalEditChange,
  fieldContext = null,
  recordScope,
  boundaries,
}: SchemaPanelProps) {
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const nodes =
    snap.historicalPreview?.schemaNodes ?? snap.draft?.schemaNodes ?? EMPTY_NODES
  const editorReadOnly = readOnly || snap.historicalPreview !== null
  const contextNode = fieldContext && enumerateFieldPaths(nodes).find((field) => field.id === fieldContext.nodeId)?.node
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
  const { toast: panelToast, showToast: showPanelToast, dismissToast: dismissPanelToast } = useToast()
  const [chat, setChat] = useState<ChatMsg[]>([])
  /** The researcher's open or collapse; null keeps the default: open before a schema exists or while a recovered
   *  request runs, collapsed otherwise. */
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null)
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
  /** The running edit's operation ID: Stop cancels it on the server (Task 6) and Discard names it (Task 7). */
  const editOperationRef = useRef<string | null>(null)
  useEffect(() => () => {
    chatAbortRef.current?.abort()
    chatAbortRef.current = null
  }, [])
  const [view, setView] = useState<'fields' | 'code'>('fields')
  /** Groups the researcher closed. Every other group shows its children, wherever it first appears (§6). */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const [openDescId, setOpenDescId] = useState<string | null>(null)
  const [descDraft, setDescDraft] = useState('')
  const [jsonEditMode, setJsonEditMode] = useState(false)
  const [jsonDraft, setJsonDraft] = useState('')
  const [jsonEditError, setJsonEditError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [creatingFromHistory, setCreatingFromHistory] = useState(false)
  const [confirmingDeleteSchema, setConfirmingDeleteSchema] = useState(false)
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)


  // ── refs for event handlers (avoid stale closures) ──
  const draggingRef = useRef<DragState | null>(null)
  const overTargetRef = useRef<DropTarget | null>(null)
  const dragYRef = useRef(0)
  const dragXRef = useRef(0)
  const dragStartXRef = useRef(0)
  const dragStartYRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const fieldListRef = useRef<HTMLDivElement>(null)
  const addFieldRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!fieldContext) return
    const ancestors = schemaAncestorIds(nodes, new Set([fieldContext.nodeId]))
    setCollapsedIds((current) => withoutIds(current, ancestors))
  }, [fieldContext, nodes])
  const [recordDescriptionDraft, setRecordDescriptionDraft] = useState(
    () => snap.draft?.recordDescription ?? '',
  )
  // What a reloaded page found (spec, *What the schema panel does on load*): running operations to show and poll, a
  // finished generation to save onto its base, an unreviewed proposal to reopen.
  const recovery = useModelOperationRecovery({
    schema,
    proposalReview,
    busy: chatLoading || pending !== null,
    appendMessage: appendChatMessage,
    onReopened: (proposal) => {
      // A reopened proposal is reviewed in the conversation, as one that has just arrived.
      setDrawerOpen(true)
      const ancestors = schemaAncestorIds(proposal.reviewNodes, new Set(proposal.changes.map(({ id }) => id)))
      setCollapsedIds((current) => withoutIds(current, ancestors))
    },
  })
  // Shown wherever the chat lives: before the first schema (the instructions chat) and after (the edit chat).
  const runningRows = recovery.running.map((operation) => (
    <div
      key={operation.workflowId}
      className="flex items-center justify-between gap-2 rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-2 text-[12px] text-ink-muted"
    >
      <span>{`Still working on an earlier request: “${operation.instruction}”`}</span>
      <button
        type="button"
        className="shrink-0 text-[11px] text-ink underline"
        aria-label={`Stop earlier request “${operation.instruction}”`}
        onClick={() => recovery.stop(operation.workflowId)}
      >
        Stop
      </button>
    </div>
  ))
  const chatRef = useRef<HTMLDivElement>(null)
  const creatingFromHistoryRef = useRef(false)

  const ready = snap.view === 'editing'
  // A recovered running request continues a send made before the reload, and a send opens the conversation.
  const drawerShown = drawerOpen ?? (!ready || recovery.running.length > 0)
  // The schema's birth ends the instructions conversation: the new schema rests with its composer line closed.
  const wasReady = useRef(ready)
  useEffect(() => {
    if (ready && !wasReady.current) setDrawerOpen(null)
    wasReady.current = ready
  }, [ready])
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
      setOpenDescId(null)
      setJsonEditMode(false)
      setJsonDraft('')
      setJsonEditError(null)
      setView('fields')
      setCollapsedIds(new Set())
      setDescDraft('')
      setChatInput('')
      setHistoryError(null)
      setConfirmingDeleteSchema(false)
      setRegenerateOpen(false)
      // A pending Undo belongs to the replaced draft: restoring into the new one would graft an old field onto it.
      dismissPanelToast()
      setRecordDescriptionDraft(
        schema.snapshot().draft?.recordDescription ?? '',
      )
      if (clearConversation) {
        setHistoryOpen(false)
        resetInstructions()
        setChat([])
        setDrawerOpen(null)
      }
    },
    [dismissPanelToast, resetInstructions, resetProposal, schema],
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
  }, [chat.length, pending, instructions.items.length, drawerShown])


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

  const importDisabled = editorReadOnly || editing !== null || openDescId !== null || snap.generating
  const menuItems: ActionItem[] = [
    { id: 'import', label: 'Import from Excel codebook…', onSelect: () => setImportOpen(true), disabled: importDisabled },
    { id: 'code', label: 'Edit as code', onSelect: () => setView('code') },
    {
      id: 'history', label: 'History', onSelect: () => setHistoryOpen(true),
      disabled: snap.history.length === 0 || creatingFromHistory || snap.creatingFromRevisionId !== null || snap.previewingRevisionId !== null,
    },
    ...(showRegenerate && onGenerateInstructions
      ? [{ id: 'regenerate', label: 'Regenerate from the document…', onSelect: () => setRegenerateOpen(true), disabled: snap.generating }]
      : []),
    { id: 'clear', label: 'Clear schema', tone: 'danger' as const, divider: true, onSelect: () => setConfirmingDeleteSchema(true) },
  ]

  /** A durable schema with no fields yet: the researcher names it and describes the record (Ruling 5). The description
   *  textarea is focused with its placeholder text selected once the panel is ready, so typing replaces it. */
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const [focusDescriptionOnReady, setFocusDescriptionOnReady] = useState(false)
  useEffect(() => {
    if (!focusDescriptionOnReady || !ready) return
    // Spent on the first ready render, focused or not, so a later unrelated transition cannot fire it.
    descriptionRef.current?.focus()
    descriptionRef.current?.select()
    setFocusDescriptionOnReady(false)
  }, [focusDescriptionOnReady, ready])

  const startingBlankRef = useRef(false)
  const [startingBlank, setStartingBlank] = useState(false)
  async function startBlank() {
    if (startingBlankRef.current) return
    startingBlankRef.current = true
    setStartingBlank(true)
    setMutationError(null)
    try {
      await schema.confirmDefinition({ recordDescription: 'Untitled record', schemaNodes: [] })
      if (!editorReadOnly) setFocusDescriptionOnReady(true)
      // A schema cleared and started again keeps its name; only a new one is named.
      if (!schemaName) await renameNewSchema(UNTITLED_SCHEMA_NAME)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : 'The schema could not be created.')
    } finally {
      startingBlankRef.current = false
      setStartingBlank(false)
    }
  }

  /** Names a schema that has none yet (Start blank, an import); a rejected rename shows like any other failed edit. */
  async function renameNewSchema(name: string) {
    const rejected = await onRenameSchema?.(name)
    if (rejected) setMutationError(rejected)
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
    setCollapsedIds((current) => withoutIds(current, [id]))
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
    const name = editing.name.trim().toLowerCase().replace(/\s+/g, '_')
    if (!name) {
      setEditingError('Enter a field name.')
      return
    }
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

  /** One click removes the field and its subtree; Undo puts it back where it was for eight seconds (§6). Both commits
   *  carry an empty label: the controller toasts every non-empty label at the top of the document (`onCommitMessage`,
   *  wired in `App.tsx`), and the panel's toast is the one notice for delete and undo. */
  function deleteField(node: SchemaNode, parentId: string | null, index: number) {
    const focusTarget = rowAfterDeleting(node.id)
    const result = schema.commit((current) => removeSchemaNode(current, node.id)[1], '')
    if (!result.ok) {
      setMutationError(
        result.reason === 'no-draft'
          ? 'No schema draft is open.'
          : `A sibling field already uses “${result.duplicateName}”.`,
      )
      return
    }
    // Keyboard focus stays in the list rather than falling to the page when the focused row goes.
    focusTarget?.focus()
    // A form open on the field or anywhere inside it goes with it.
    const removedIds = new Set(enumerateFieldPaths([node]).map((field) => field.id))
    if (editing && removedIds.has(editing.id)) cancelEdit()
    if (openDescId !== null && removedIds.has(openDescId)) setOpenDescId(null)
    showPanelToast('Field removed', {
      durationMs: 8_000,
      action: {
        label: 'Undo',
        onAction: () => {
          // Computed from the live snapshot before anything is committed: an impossible restore commits nothing.
          const current = schema.snapshot().draft?.schemaNodes
          const restored = current ? restoreSchemaNode(current, node, parentId, index) : null
          if (!restored || !schema.commit(() => restored, '').ok) showPanelToast('Could not restore the field')
        },
      },
    })
  }

  function updateNodeDescription(id: string, description: string | undefined) {
    schema.commit(
      (current) => updateSchemaNode(current, id, (node) => ({ ...node, description })),
      '✎ Description updated',
    )
  }

  /** Each note appends as a new line rather than replacing the field's existing notes. */
  function addNodeDescriptionNote(id: string, existing: string | undefined, draft: string) {
    const note = draft.trim()
    if (!note) return
    updateNodeDescription(id, existing ? `${existing}\n${note}` : note)
    setDescDraft('')
  }

  /** Where focus goes once a field's row is removed: the next visible row outside its subtree, else the previous row,
   *  else "+ Add field". Rows of other fields keep their DOM nodes across the commit, so the element stays valid. */
  function rowAfterDeleting(id: string): HTMLElement | null {
    const rows = Array.from(fieldListRef.current?.querySelectorAll<HTMLElement>('[role="listitem"]') ?? [])
    const index = rows.findIndex((row) => row.closest('[data-schema-node-id]')?.getAttribute('data-schema-node-id') === id)
    if (index < 0) return addFieldRef.current
    const subtree = rows[index]!.closest('[data-schema-node-id]')!
    return rows.slice(index + 1).find((row) => !subtree.contains(row)) ?? rows[index - 1] ?? addFieldRef.current
  }

  function addField() {
    if (editing) return
    const next = { id: mkId(), name: '', type: 'verbatim-string' as const }
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
    setDrawerOpen(true)
    const userMsg = text.trim()
    setChat(c => [...c, { role: 'user', text: userMsg }])
    setChatInput('')
    setChatLoading(true)
    const controller = new AbortController()
    chatAbortRef.current = controller
    // A new user action, a new ID (spec, *Client IDs*): Studio replays the same one if the POST is repeated.
    const operationId = crypto.randomUUID()
    editOperationRef.current = operationId

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
        operationId,
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
            `edit:${operationId}`,
          )
          // A pending proposal keeps the drawer open with its Apply / Discard bar, even if it was collapsed meanwhile.
          setDrawerOpen(true)
          const ancestors = schemaAncestorIds(proposal.reviewNodes, new Set(proposal.changes.map(({ id }) => id)))
          setCollapsedIds((current) => withoutIds(current, ancestors))
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
        editOperationRef.current = null
        setChatLoading(false)
      }
    }
  }

  function cancelChat() {
    // A user's Stop: cancel the proposal on the server, then stop waiting. The unmount cleanup only aborts.
    const operationId = editOperationRef.current
    if (operationId)
      void deleteModelOperation(`edit:${operationId}`).catch(() =>
        appendChatMessage('The request could not be stopped on the server; it may still be running and will show as an earlier request after a reload.'),
      )
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

  const msgCls = (role: 'user' | 'assistant') =>
    role === 'user'
      ? 'self-end max-w-[88%] rounded-[11px_11px_3px_11px] bg-accent px-3 py-1.5 text-secondary leading-relaxed text-white'
      : 'self-start max-w-[92%] rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-1.5 text-secondary leading-relaxed text-ink'

  const editDisabled = editorReadOnly || !!dragging

  const chatBlocked = !!pending || chatLoading
  // A refused or stale Apply keeps the drawer open: its explanation, and a refused proposal's review, stay in view.
  const applyProposal = () => { if (proposalReview.apply()) setDrawerOpen(false) }
  const discardProposal = () => { proposalReview.discard(); setDrawerOpen(false) }
  const sendInstruction = () => {
    if (!instructions.draft.trim()) return
    setDrawerOpen(true)
    instructions.send()
  }
  // Before a schema exists the dot is the only way back to the instructions and their Generate schema action.
  const dot = drawerShown ? null : runningRows.length > 0 ? { title: 'An earlier request is still running' } : !ready || chat.length > 0 || pending ? { title: 'Show conversation' } : null

  // Render helpers for field rows
  // ────────────────────────────────────────────────────────────────────────

  function renderField(node: SchemaNode, parentId: string | null, index: number, ancestorRemoved = false): React.ReactNode {
    const isGroup = node.children !== undefined
    const isDragging = dragging?.id === node.id
    const intoGroup = dragMode === 'normal' && overTarget?.type === 'group' && overTarget.id === node.id
    const isExpanded = !collapsedIds.has(node.id) || intoGroup
    const change = pending?.changes.find((item) => item.id === node.id)
    const diffStatus = change?.kind ?? (ancestorRemoved ? 'removed' : null)
    const isDiff = diffStatus !== null
    const isEditing = editing?.id === node.id
    return (
      <div key={node.id} data-schema-node-id={node.id}
        onMouseEnter={() => !isDiff && setGroupTarget(node.id, node.name)}
        onMouseLeave={() => !isDiff && clearGroupTarget(node.id)}>
        <div className={slotCls(parentId, index)} onMouseEnter={(event) => { event.stopPropagation(); setSlotTarget(parentId, index) }} />
        {isEditing && editing && !isDiff ? (
          <FieldEditForm editing={editing} error={editingError} onChange={(next) => { setEditing(next); setEditingError(null) }} onSave={saveEdit} onCancel={cancelEdit} />
        ) : (
          <FieldRow node={node} isGroup={isGroup} expanded={isExpanded}
            onToggleExpanded={() => setCollapsedIds((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })}
            change={change} outcome={change && replay?.outcomes.get(change.id)} impliedRemoved={ancestorRemoved}
            acceptance={change ? { accepted: acceptedChangeIds.has(change.id), onToggle: proposalReview.toggle } : undefined}
            readOnly={editorReadOnly} editDisabled={editDisabled} dragging={isDragging} intoGroup={intoGroup}
            onStartDrag={(event) => startDrag(event, node.id, parentId, node.name, isGroup)}
            onEdit={() => { setEditing(editingOf(node)); setEditingError(null) }}
            onAddNote={() => { const next = openDescId === node.id ? null : node.id; if (next) setDescDraft(''); setOpenDescId(next) }}
            onDelete={() => deleteField(node, parentId, index)}
            nodeRef={fieldContext?.nodeId === node.id ? focusField : undefined} />
        )}
        {openDescId === node.id && (
          <DescriptionEditForm existing={node.description ?? ''} value={descDraft} onChange={setDescDraft}
            onAdd={() => addNodeDescriptionNote(node.id, node.description, descDraft)}
            onDelete={() => { updateNodeDescription(node.id, undefined); setOpenDescId(null) }} onCancel={() => setOpenDescId(null)} />
        )}
        {isGroup && isExpanded && ((node.children ?? []).length > 0 || !!dragging) && (
          <div role="list" aria-label={`Fields of ${node.name}`} className="ml-4 mt-0.5 border-l border-line pl-3">
            {(node.children ?? []).map((child, childIndex) => renderField(child, node.id, childIndex, ancestorRemoved || diffStatus === 'removed'))}
            <div className={slotCls(node.id, (node.children ?? []).length)} onMouseEnter={() => setSlotTarget(node.id, (node.children ?? []).length)} />
          </div>
        )}
      </div>
    )
  }

  // ────────────────────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* ── Header ── */}
      <header className="flex shrink-0 flex-col gap-1 border-b border-line px-4 pb-2 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 text-content font-semibold text-ink">
            {schemaName && ready ? (
              editorReadOnly || !onRenameSchema ? (
                <h2 className="h-7 truncate leading-7">{schemaName}</h2>
              ) : (
                <SchemaNameEditor name={schemaName} nameAs="h2" onSubmit={onRenameSchema} />
              )
            ) : (
              <h2 className="h-7 truncate leading-7">{sourceDocumentName}</h2>
            )}
          </div>
          {ready && (
            <div className="flex shrink-0 items-center gap-2">
              <SegmentedControl
                aria-label="Schema view"
                value={view}
                onChange={setView}
                options={[{ value: 'fields', label: 'Fields' }, { value: 'code', label: 'Code' }]}
              />
              {!editorReadOnly && <ActionsMenu label="Schema actions" items={menuItems} />}
            </div>
          )}
        </div>
        {ready && (recordScope || boundaries) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-secondary text-ink-muted">
            {recordScope && (
              <span className="inline-flex items-center gap-0.5">
                <select
                  aria-label="Record scope"
                  className={`min-h-6 cursor-pointer appearance-none bg-transparent outline-none hover:text-ink disabled:cursor-default ${
                    recordScope.value === null ? 'font-semibold text-accent' : 'text-ink-muted'
                  }`}
                  value={recordScope.value ?? ''}
                  disabled={recordScope.disabled}
                  onChange={(event) => recordScope.onChange(event.target.value as RecordScope)}
                >
                  {recordScope.value === null && <option value="" disabled>Choose Article or Catalog</option>}
                  <option value="document">Article · one object for the document</option>
                  <option value="records">Catalog · a collection of records</option>
                </select>
                <span aria-hidden="true" className="text-ink-faint">▾</span>
              </span>
            )}
            {boundaries && (
              <label className="inline-flex items-center gap-1">
                Boundaries
                <select
                  aria-label="Boundaries"
                  className="min-h-6 cursor-pointer appearance-none bg-transparent text-ink outline-none disabled:cursor-default"
                  value={boundaries.value}
                  disabled={boundaries.disabled}
                  title="How catalogue entries are found: by the model, or by a numbered-catalogue recipe with source-backed evidence"
                  onChange={(event) => boundaries.onChange(event.target.value)}
                >
                  <option value="">Model discovery</option>
                  {boundaries.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                </select>
                <span aria-hidden="true" className="text-ink-faint">▾</span>
              </label>
            )}
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
        {ready && snap.sourceCoverage && snap.sourceCoverage.sourceRepresentationRevisionId === sourceRepresentationId && (
          <div className="mb-3 rounded-md border border-line px-3 py-2" role="note">
            <p className="text-[11px] text-ink-muted">{sourceCoverageNotice(snap.sourceCoverage)}</p>
          </div>
        )}
        {ready && snap.generationError && (
          <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2" role="alert">
            <p className="text-[11px] text-danger">Regeneration failed: {snap.generationError} The current saved schema is unchanged.</p>
          </div>
        )}
        {snap.cancellationError && (
          <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2" role="alert">
            <p className="text-[11px] text-danger">{snap.cancellationError}</p>
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
          <EmptyState title="No schema yet" description="Generate it from the document, import a codebook, or start blank.">
            {onGenerateInstructions && (
              <Button variant="positive" onClick={() => onGenerateInstructions(instructions.text)}>Generate from the document</Button>
            )}
            {!editorReadOnly && <Button disabled={importDisabled} onClick={() => setImportOpen(true)}>Import from Excel codebook…</Button>}
            {!editorReadOnly && <Button disabled={startingBlank} onClick={() => void startBlank()}>Start blank</Button>}
          </EmptyState>
        )}
        {snap.view === 'empty' && mutationError && (
          <p className="mt-2 text-compact font-semibold text-danger" role="alert">{mutationError}</p>
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

        {ready && view === 'code' && (
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
                        if (!isRecord(parsed)) throw new Error('The code must describe one object')
                        const definition = templateToSchemaDefinition(parsed)
                        schema.replaceDraft(definition, '✎ Schema updated from the code view')
                        setJsonEditMode(false)
                        setJsonEditError(null)
                      } catch (e) {
                        setJsonEditError(e instanceof Error ? e.message : 'The code could not be read')
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
            <label className="mb-3 block">
              <span className="text-compact font-semibold text-ink-muted">What one record is</span>
              {editorReadOnly ? (
                <p className="mt-1 text-secondary leading-relaxed text-ink-muted">{recordDescriptionDraft}</p>
              ) : (
                <textarea
                  ref={descriptionRef}
                  className="mt-1 block w-full resize-none rounded-[3px] border border-line bg-transparent px-2 py-1 text-secondary leading-relaxed text-ink outline-none transition-colors placeholder:text-ink-faint hover:border-line-strong focus:border-line-strong"
                  rows={Math.min(6, Math.max(2, recordDescriptionDraft.split('\n').length))}
                  value={recordDescriptionDraft}
                  placeholder="Describe the record this schema extracts…"
                  onChange={(event) => setRecordDescriptionDraft(event.target.value)}
                  onBlur={commitRecordDescription}
                />
              )}
            </label>
            {mutationError && <p className="mb-2 text-compact font-semibold text-danger" role="alert">{mutationError}</p>}
            <div ref={fieldListRef} role="list" aria-label="Schema fields" className="flex flex-col">
              {fieldContext && <div role="status" className="p-2 text-xs bg-accent-ghost">
                From Extraction {fieldContext.extractionId} · revision {fieldContext.revisionNumber ?? fieldContext.schemaRevisionId} · {fieldContext.nodeType}
                {contextNode ? ` → ${contextNode.name} (${contextNode.type}) in the current editor. Unsaved edits are retained.` : ' · This field was removed. No replacement was selected.'}
                {!contextNode && <Button onClick={() => void schema.previewHistoricalRevision(fieldContext.schemaRevisionId)}>View historical schema</Button>}
              </div>}
              {(pending ? pending.reviewNodes : nodes).map((node, i) => renderField(node, null, i))}
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
              ref={addFieldRef}
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

      {/* The conversation: before a schema exists, the instructions recorded for "Generate schema"; after, the schema
          edit chat, which proposes changes for review. One composer line at rest; sending opens the drawer. */}
      {(!ready || !editorReadOnly) && (
        <ChatDrawer open={drawerShown} onCollapse={() => setDrawerOpen(false)} onExpand={() => setDrawerOpen(true)}
          title={ready ? 'Conversation' : 'Instructions for generation'} dot={dot} bodyRef={chatRef}
          headerAction={!ready && snap.view === 'empty' && onGenerateInstructions ? (
            <Button variant="positive" onClick={() => onGenerateInstructions(instructions.text)}>Generate schema{instructions.countLabel}</Button>
          ) : undefined}
          bar={ready && pending ? <ProposalReviewBar proposal={pending} canApply={canApply} onApply={applyProposal} onDiscard={discardProposal} /> : undefined}
          composer={ready ? (
            <>
              <input className="min-w-0 flex-1 bg-transparent font-sans text-secondary text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
                placeholder="Describe a change to the schema…" value={chatInput} disabled={chatBlocked}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void sendChatMessage(chatInput) }} />
              {chatLoading ? (
                <button type="button" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-danger text-compact text-white outline-none hover:brightness-108"
                  onClick={cancelChat} title="Stop schema edit request" aria-label="Stop schema edit request">■</button>
              ) : (
                <button type="button" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40"
                  aria-label="Send" disabled={!chatInput.trim() || chatBlocked} onClick={() => void sendChatMessage(chatInput)}>↑</button>
              )}
            </>
          ) : (
            <>
              <textarea className="min-w-0 flex-1 resize-none bg-transparent font-sans text-secondary text-ink outline-none placeholder:text-ink-faint" rows={1}
                placeholder={'Add a generation instruction (e.g. "Focus on names, dates, and locations")…'} value={instructions.draft}
                onChange={(event) => instructions.setDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendInstruction() } }} />
              <button type="button" aria-label="Add instruction" className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-green text-compact text-white outline-none hover:brightness-108 disabled:opacity-40"
                disabled={!instructions.draft.trim()} onClick={sendInstruction}>↑</button>
            </>
          )}>
          {ready ? (
            <div className="flex flex-col gap-2">
              {runningRows}
              {chat.length === 0 && runningRows.length === 0 && !chatLoading && (
                <p className="text-secondary leading-relaxed text-ink-faint">{CONVERSATION_EMPTY}</p>
              )}
              {chat.map((message, index) => <div key={index} className={msgCls(message.role)}>{message.text}</div>)}
              {chatLoading && (
                <div className="self-start rounded-[11px_11px_11px_3px] border border-line bg-surface px-3 py-2">
                  <span className="flex gap-1">
                    <span className="animate-pulse text-content text-ink-faint">•</span>
                    <span className="animate-pulse text-content text-ink-faint" style={{ animationDelay: '0.15s' }}>•</span>
                    <span className="animate-pulse text-content text-ink-faint" style={{ animationDelay: '0.3s' }}>•</span>
                  </span>
                </div>
              )}
            </div>
          ) : (
            <>
              {runningRows.length > 0 && <div className="mb-2 flex flex-col gap-2">{runningRows}</div>}
              <SchemaInstructionsChat instructions={instructions} messageClass={msgCls} />
            </>
          )}
        </ChatDrawer>
      )}

      {panelToast && (
        <div className="pointer-events-none absolute inset-x-3 bottom-14 z-20 flex justify-center">
          <Toast message={panelToast.message} action={panelToast.action} onDismiss={dismissPanelToast} />
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2 text-compact text-ink-faint">
        {snap.view === 'generating' && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-stale" />
            Producing schema from the document…
          </span>
        )}
        {snap.view === 'empty' && 'Generate, import or start blank to create the schema'}
        {snap.view === 'failed' && 'Generation failed'}
        {/* Status text only: the save's alert and Retry belong to the host beside its run controls, reachable with the
            Schema tab hidden. */}
        {ready && <SchemaSaveStatus save={snap.save} showSaved retry={false} onRetry={() => void schema.flush().catch(() => undefined)} />}
      </footer>

      <SchemaImport
        schema={schema}
        disabled={importDisabled}
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          if (!schemaName) void renameNewSchema(defaultSchemaName(sourceDocumentName))
        }}
      />
      {historyOpen && (
        <ModalDialog className={dialogCls} ariaLabel="Schema history" onDismiss={() => setHistoryOpen(false)}>
          <h3 className="text-secondary font-semibold text-ink">Schema history</h3>
          <div className="scrollbar-subtle mt-2 max-h-80 overflow-y-auto">
            {snap.history.map((revision) => (
              <button
                key={revision.schemaRevisionId}
                type="button"
                className="block w-full rounded-md px-3 py-2 text-left outline-none hover:bg-accent-ghost focus-visible:bg-accent-ghost"
                aria-label={`Revision ${revision.revisionNumber}${revision.revisionNumber === snap.currentRevisionNumber ? ' · Current' : ''}: ${revision.summary}`}
                disabled={creatingFromHistory || snap.previewingRevisionId !== null}
                onClick={() => void previewHistory(revision)}
              >
                <span className="block text-secondary font-semibold text-ink">
                  Revision {revision.revisionNumber}{revision.revisionNumber === snap.currentRevisionNumber ? ' · Current' : ''}
                </span>
                <span className="block text-compact text-ink-muted">{revision.origin} · {revision.summary}</span>
                <span className="block text-overline text-ink-faint">{new Date(revision.createdAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </ModalDialog>
      )}
      {regenerateOpen && (
        <ModalDialog className={dialogCls} ariaLabel="Regenerate from the document" onDismiss={() => setRegenerateOpen(false)}>
          <h3 className="mb-2 text-secondary font-semibold text-ink">Regenerate from the document</h3>
          <SchemaInstructionsDrawer instructions={instructions} />
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setRegenerateOpen(false)}>Cancel</Button>
            <Button
              variant="positive"
              disabled={snap.generating}
              onClick={() => {
                setRegenerateOpen(false)
                onGenerateInstructions?.([instructions.text, fieldDescriptionsInstruction(nodes)].filter(Boolean).join('\n\n'))
              }}
            >
              Regenerate schema{instructions.countLabel}
            </Button>
          </div>
        </ModalDialog>
      )}
      {confirmingDeleteSchema && (
        <ModalDialog className={dialogCls} ariaLabel="Clear current schema" onDismiss={() => setConfirmingDeleteSchema(false)}>
          <p className="text-secondary font-semibold text-ink">Clear current schema?</p>
          <p className="mt-1 text-compact leading-relaxed text-ink-muted">
            This clears the current editor only. Saved Schema Revisions remain in history.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmingDeleteSchema(false)}>Cancel</Button>
            {/* A clear the workspace refuses keeps the dialog open; a clear it accepts resets the editor, closing it. */}
            <Button variant="danger" onClick={() => void deleteSchema()}>Clear schema</Button>
          </div>
        </ModalDialog>
      )}

      {/* Drag overlay chip */}
      {dragging && (
        <div
          style={{ position: 'fixed', left: dragX + 18, top: dragY - 16, pointerEvents: 'none', zIndex: 9999 }}
          className="flex select-none items-center gap-1.5 rounded-lg border-[1.5px] border-accent bg-surface px-3 py-1.5 font-mono text-secondary font-medium text-ink shadow-[0_4px_20px_rgba(51,48,44,.22)] whitespace-nowrap"
        >
          <span className="text-sm">{dragMode === 'indent' ? '→' : dragMode === 'outdent' ? '←' : '⠿'}</span>
          {dragging.name}
        </div>
      )}
    </div>
  )
}

export default SchemaPanel
