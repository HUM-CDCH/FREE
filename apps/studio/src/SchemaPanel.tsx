import { SchemaDefinitionBody } from './SchemaView'
import { SchemaImport } from './SchemaImport'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { sourceCoverageNotice } from './sourceCoverageNotice'
import type { SchemaEditorController } from './currentSchemaRevision'
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
  type SchemaDefinition,
} from 'extraction/schema'
import type { SchemaRevisionSummary } from '../shared/schemaRevision.contract'
import { Button, EmptyState, ModalDialog, SegmentedControl, Toast } from './ui'
import FieldRow, { SchemaTree } from './FieldRow'
import { useToast } from './useToast'
import ActionsMenu, { type ActionItem } from './ActionsMenu'
import SchemaNameEditor from './SchemaNameEditor'
import { SchemaSaveStatus } from './SchemaSaveStatus'
import { defaultSchemaName } from './schemaNames'
import type { SchemaProposalReview } from './useSchemaProposalReview'
import {
  moveSchemaNodes,
  removeSchemaNode,
  restoreSchemaNode,
  schemaAncestorIds,
  schemaDragMode,
  updateSchemaNode,
} from './schemaEditorTree'

const EMPTY_NODES: SchemaNode[] = []

/** Current templates read compactly; older definitions that cannot use that format remain inspectable. */
function templateCode(definition: SchemaDefinition): string {
  try { return JSON.stringify(schemaDefinitionToTemplate(definition), null, 2) }
  catch { return JSON.stringify(definition, null, 2) }
}

/** `ids` taken out of the collapsed set, so those groups show their children. */
const withoutIds = (current: ReadonlySet<string>, ids: Iterable<string>) => {
  const next = new Set(current)
  for (const id of ids) next.delete(id)
  return next
}


export const CONVERSATION_EMPTY = "Edit through drag and drop, or describe a change. I'll show you the changes before you apply them."

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
  /** The Article/Catalog choice under the schema name; null until one is saved. */
  recordScope?: { value: RecordScope | null; onChange: (scope: RecordScope) => void; disabled?: boolean }
  /** How catalogue entries are found, beside the record scope; omitted or null where it does not apply. */
  boundaries?: {
    value: string
    options: ReadonlyArray<{ id: string; label: string }>
    onChange: (id: string) => void
    disabled?: boolean
  } | null
  /** Host-owned review and conversation; the editor never starts a conversation. */
  proposalReview: SchemaProposalReview
  revealed: { seq: number; ids: Iterable<string> }
  onRegenerate?: () => void
}

type DragState = {
  id: string
  parentId: string | null
  name: string
  isGroup: boolean
  epoch: number
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
  description?: string
  newField?: boolean
  newValue?: string
}

function editedField(node: SchemaNode, name: string, editing: FieldEditing): SchemaNode {
  const base = { id: node.id, name, ...(editing.description && { description: editing.description }), ...(node.valueSource && { valueSource: node.valueSource }), ...(node.evidencePolicy && { evidencePolicy: node.evidencePolicy }) }
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
    description: node.description,
    name: node.name,
    type: node.type,
    itemType: node.type === 'array' ? (node.children === undefined ? node.itemType : null) : undefined,
    allowedValues: node.type === 'string' ? node.allowedValues : undefined,
  }
}




// ────────────────────────────────────────────────────────────────────────────
// Data model and converters
// ────────────────────────────────────────────────────────────────────────────



// ────────────────────────────────────────────────────────────────────────────
// Node tree helpers (tasks 2.5, 3.4)
// ────────────────────────────────────────────────────────────────────────────




// ────────────────────────────────────────────────────────────────────────────
// Shared UI sub-components
// ────────────────────────────────────────────────────────────────────────────

function WorkingIndicator({ onStop }: { onStop: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-line bg-canvas px-4 py-8 text-center" aria-live="polite">
      <span aria-hidden="true" className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent" />
      <p className="text-content font-semibold text-ink">Producing template…</p>
      <p className="max-w-[34ch] text-secondary leading-snug text-ink-muted">This can take a while on large documents.</p>
      <Button variant="danger" size="sm" className="mt-1" onClick={onStop}>Stop</Button>
    </div>
  )
}

const dialogCls =
  'm-auto w-full max-w-sm overscroll-contain rounded-card border border-line bg-surface p-4 text-ink backdrop:overflow-hidden backdrop:overscroll-contain backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]'

/** The record description's height in rows (§5): two at rest, growing with its wrapped text to six. */
const DESCRIPTION_ROWS = { min: 2, max: 6 }
/** `leading-relaxed` at `text-secondary` (12px × 1.625), for a computed style that has none (jsdom). */
const DESCRIPTION_LINE_HEIGHT = 19.5

/** The record description's rows for its wrapped text (not only its line breaks), from two to six: measured at the
 *  minimum so it can shrink too. The rows are written to the element directly; React renders the constant minimum. */
function fitDescriptionRows(element: HTMLTextAreaElement) {
  element.rows = DESCRIPTION_ROWS.min
  const style = getComputedStyle(element)
  const lineHeight = parseFloat(style.lineHeight) || DESCRIPTION_LINE_HEIGHT
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
  const lines = Math.round((element.scrollHeight - padding) / lineHeight)
  element.rows = Math.min(DESCRIPTION_ROWS.max, Math.max(DESCRIPTION_ROWS.min, lines))
}

// Field editing uses stable ids, not paths.
function FieldEditForm({ editing, error, focus = 'name', onChange, onSave, onCancel }: {
  editing: FieldEditing
  error: string | null
  /** The input focused on opening: the name, or the allowed values when the row's values pill opened the form. */
  focus?: 'name' | 'values' | 'notes'
  onChange: (e: FieldEditing) => void
  onSave: () => void
  onCancel: () => void
}) {
  const nameId = useId()
  const notesId = useId()
  const newValue = editing.newValue ?? ''
  const setNewValue = (newValue: string) => onChange({ ...editing, newValue })

  function addValue() {
    const value = newValue.trim()
    if (!value) return
    const current = editing.allowedValues ?? []
    if (current.includes(value)) { setNewValue(''); return }
    onChange({ ...editing, allowedValues: [...current, value], newValue: '' })
  }

  function removeValue(value: string) {
    const remaining = (editing.allowedValues ?? []).filter((v) => v !== value)
    onChange({ ...editing, allowedValues: remaining.length > 0 ? remaining : undefined })
  }

  if (focus === 'notes') return (
    <div className="my-0.5 flex flex-col gap-2 rounded-md border border-accent bg-accent-ghost p-2.5">
      <label htmlFor={notesId} className="text-secondary font-semibold [overflow-wrap:anywhere]">Notes for {editing.name}</label>
      <textarea id={notesId} aria-label="Field notes" autoFocus rows={3}
        className="w-full resize-y rounded border border-line bg-surface p-2 text-secondary outline-none focus-visible:border-accent"
        value={editing.description ?? ''} onChange={e => onChange({ ...editing, description: e.target.value })} />
      {error && <p role="alert" className="text-compact text-danger [overflow-wrap:anywhere]">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="positive" onClick={onSave}>Save</Button>
      </div>
    </div>
  )

  return (
    <div className="my-0.5 flex flex-col gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <label htmlFor={nameId} className="text-overline text-ink-muted">Name</label>
        <input id={nameId}
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-xs font-semibold text-ink outline-none focus-visible:border-accent"
          value={editing.name}
          placeholder="field_name"
          aria-label="Field name"
          autoFocus={focus === 'name'}
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
                <span key={value} className="flex min-w-0 max-w-full items-center gap-1 rounded bg-canvas px-1.5 py-0.5 font-mono text-overline text-ink">
                  <span className="min-w-0 truncate" title={value}>{value}</span>
                  <button
                    type="button"
                    className="shrink-0 cursor-pointer text-ink-faint outline-none hover:text-danger"
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
              aria-label="Add allowed value"
              autoFocus={focus === 'values'}
              value={newValue}
              placeholder="add value…"
              onChange={e => setNewValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addValue() } }}
            />
            <Button onClick={addValue}>Add</Button>
          </div>
        </div>
      )}
      <label htmlFor={notesId} className="text-secondary">Field notes
        <textarea id={notesId} aria-label="Field notes" className="block w-full rounded border border-line bg-surface p-2" value={editing.description ?? ''} onChange={e => onChange({ ...editing, description: e.target.value })} />
      </label>
      {error && <span className="text-overline font-semibold text-danger [overflow-wrap:anywhere]" role="alert">{error}</span>}
    </div>
  )
}

function SchemaPanel({
  schema,
  onGenerateInstructions,
  onClearDraft,
  sourceDocumentName,
  sourceRepresentationId,
  schemaName,
  onRenameSchema,
  recordScope,
  boundaries,
  proposalReview,
  revealed,
  onRegenerate,
}: SchemaPanelProps) {
  const snap = useSyncExternalStore(schema.subscribe, schema.snapshot)
  const inputHandle = schema.inputHandle()
  const descriptionInputId = useId()
  const codeInputId = useId()
  const nodes =
    snap.historicalPreview?.schemaNodes ?? snap.draft?.schemaNodes ?? EMPTY_NODES
  const editorReadOnly = snap.historicalPreview !== null
  // ── render state ──
  const [dragging, setDragging] = useState<DragState | null>(null)
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const [overTarget, setOverTarget] = useState<DropTarget | null>(null)
  const editing = snap.input?.kind === 'field' ? JSON.parse(snap.input.value) as FieldEditing : null
  const editingError = snap.input?.error ?? (snap.input?.stale ? 'The template changed. Copy your input, then Cancel.' : null)
  const [editFocus, setEditFocus] = useState<'name' | 'values' | 'notes'>('name')
  function setEditing(next: FieldEditing | null) {
    if (!next) return
    inputHandle?.update(JSON.stringify(next))
  }
  const [mutationError, setMutationError] = useState<string | null>(null)
  const { toast: panelToast, showToast: showPanelToast, dismissToast: dismissPanelToast, holdToast: holdPanelToast } = useToast()
  const { pending, acceptedChangeIds, replay } = proposalReview
  const [moving, setMoving] = useState<{ id: string; parentId: string | null; isGroup: boolean; epoch: number } | null>(null)
  const [moveParent, setMoveParent] = useState<string | null>(null)
  const [moveIndex, setMoveIndex] = useState(0)
  const moveParentId = useId()
  const movePositionId = useId()
  const [view, setView] = useState<'fields' | 'code'>('fields')
  /** Groups the researcher closed. Every other group shows its children, wherever it first appears (§6). */
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => new Set())
  const jsonEditMode = snap.input?.kind === 'json'
  const jsonDraft = jsonEditMode ? snap.input!.value : ''
  const jsonEditError = editingError
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [creatingFromHistory, setCreatingFromHistory] = useState(false)
  const [confirmingDeleteSchema, setConfirmingDeleteSchema] = useState(false)
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
  const recordDescriptionDraft = snap.input?.kind === 'description' ? snap.input.value : snap.historicalPreview?.recordDescription ?? snap.draft?.recordDescription ?? ''
  // A proposal that arrives or is reopened shows its changes: the groups holding them open.
  // Adjusted while rendering, as the request that sets it is no longer the panel's own handler.
  const [revealedSeq, setRevealedSeq] = useState(revealed.seq)
  if (revealedSeq !== revealed.seq) {
    setRevealedSeq(revealed.seq)
    setCollapsedIds((current) => withoutIds(current, revealed.ids))
  }
  const creatingFromHistoryRef = useRef(false)

  const ready = snap.view === 'editing'
  // A recovered running request continues a send made before the reload, and a send opens the conversation.
  const shownScope = snap.historicalPreview ? snap.historicalPreview.recordScope ?? null : recordScope?.value ?? null
  // The drag's start is set with `dragging` in the same handler, so it is current whenever a drag renders. Unchanged
  // since the chat moved out of the panel, which is what lets the compiler lint this component now.
  // eslint-disable-next-line react-hooks/refs
  const dx = dragging ? dragX - dragStartXRef.current : 0
  // eslint-disable-next-line react-hooks/refs
  const dy = dragging ? dragY - dragStartYRef.current : 0
  const dragMode = schemaDragMode(dx, dy)

  const resetEditorUi = useCallback(
    (cleared = false) => {
      setMutationError(null)
      setView('fields')
      setCollapsedIds(new Set())
      setHistoryError(null)
      setConfirmingDeleteSchema(false)
      setMoving(null)
      // A pending Undo belongs to the replaced draft: restoring into the new one would graft an old field onto it.
      draggingRef.current = null
      overTargetRef.current = null
      setDragging(null)
      setOverTarget(null)
      dismissPanelToast()
      if (cleared) {
        setHistoryOpen(false)
      }
    },
    [dismissPanelToast, setView, setCollapsedIds, setConfirmingDeleteSchema, setMoving, setHistoryOpen],
  )
  const observedReplacementVersion = useRef(snap.replacementVersion)
  useEffect(() => {
    if (observedReplacementVersion.current === snap.replacementVersion) return
    observedReplacementVersion.current = snap.replacementVersion
    resetEditorUi()
  }, [resetEditorUi, snap.replacementVersion])

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
    const result = schema.commit(() => nextNodes, '⠿ Template reordered')
    if (result.ok) setMutationError(null)
    else if (result.reason === 'duplicate-name')
      setMutationError(
        `Cannot move field: a sibling field already uses “${result.duplicateName}”.`,
      )
    else setMutationError('No template draft is open.')
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
          : 'Could not load the historical Template Revision.',
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
          : 'Could not create a Current Template Revision from history.',
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

  function begin(kind: 'field' | 'description' | 'json', value: string, commit: (value: string) => SchemaDefinition) {
    try { schema.beginInput(kind, value, commit); setMutationError(null) }
    catch (error) { setMutationError(error instanceof Error ? error.message : 'Editor busy.') }
  }
  function startCodeEdit() {
    const base = schema.snapshot().draft
    if (!base) return
    begin('json', JSON.stringify(base, null, 2), value => {
      const parsed = JSON.parse(value)
      const visit = (nodes: Array<Record<string, unknown>>): Array<Record<string, unknown>> => nodes.map(node => ({ ...node, id: node.id ?? mkId(), ...(Array.isArray(node.children) ? { children: visit(node.children) } : {}) }))
      return { ...parsed, schemaNodes: visit(parsed.schemaNodes) } as SchemaDefinition
    })
  }
  const importDisabled = editorReadOnly || snap.useBlockedReason !== null || !schema.operationScope()?.projectContextId
  const menuItems: ActionItem[] = [
    { id: 'import', label: 'Import from Excel codebook…', onSelect: () => { if (!schema.snapshot().useBlockedReason) setImportOpen(true) }, disabled: importDisabled },
    // "Edit as code" opens the code view ready to edit (§5); Fields | Code switches to it for reading. A session already
    // open keeps its unsaved code and its error: choosing the action again only shows it.
    { id: 'code', label: 'Edit as code', onSelect: () => { if (!jsonEditMode) startCodeEdit() }, disabled: snap.editingBlockedReason !== null && !jsonEditMode },
    {
      id: 'history', label: 'History', onSelect: () => setHistoryOpen(true),
      disabled: snap.history.length === 0 || creatingFromHistory || snap.creatingFromRevisionId !== null || snap.previewingRevisionId !== null,
    },
    ...(onRegenerate
      ? [{ id: 'regenerate', label: 'Regenerate from the document…', onSelect: () => onRegenerate?.(), disabled: snap.useBlockedReason !== null }]
      : []),
    { id: 'clear', label: 'Clear template', tone: 'danger' as const, divider: true, onSelect: () => setConfirmingDeleteSchema(true), disabled: snap.editingBlockedReason !== null },
  ]

  /** Measures the explicitly opened record-description form. */
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  // Grows by content, not by line breaks: measured on every edit and whenever the textarea mounts.
  useLayoutEffect(() => {
    if (descriptionRef.current) fitDescriptionRows(descriptionRef.current)
  }, [recordDescriptionDraft, ready, view, editorReadOnly, snap.input?.kind])
  // And whenever its width changes with no edit: a rail resize re-wraps the text, and so does the Schema tab shown again
  // after it was hidden (0px wide while hidden, so it is measured once it is shown). Height-only notifications are the
  // rows just set; measuring on them would loop. The measurement waits for the next frame: resizing the observed
  // element inside its own notification is the "ResizeObserver loop" error.
  useEffect(() => {
    const element = descriptionRef.current
    if (!element || typeof ResizeObserver === 'undefined') return
    let width: number | null = null
    let frame = 0
    const observer = new ResizeObserver((entries) => {
      const next = entries[entries.length - 1]!.contentRect.width
      if (next === width) return
      width = next
      if (next === 0) return
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => fitDescriptionRows(element))
    })
    observer.observe(element)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [ready, view, editorReadOnly, snap.input?.kind])
  /** Names a schema that has none yet (an import); a rejected rename shows like any other failed edit. */
  async function renameNewSchema(name: string) {
    const rejected = await onRenameSchema?.(name)
    if (rejected) setMutationError(rejected)
  }


  function commitDrop() {
    const drag = draggingRef.current
    if (!drag || drag.epoch !== schema.snapshot().replacementVersion) return
    if (Math.abs(dragXRef.current - dragStartXRef.current) + Math.abs(dragYRef.current - dragStartYRef.current) < 4) return
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
      // Idle, a move would re-render the panel for nothing, also while the rail is collapsed.
      if (!draggingRef.current) return
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
    if (editorReadOnly || schema.snapshot().editingBlockedReason) return
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const d: DragState = { id, parentId, name, isGroup, epoch: schema.snapshot().replacementVersion }
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

  function openField(node: SchemaNode, focus: 'name' | 'values' | 'notes' = 'name', newField = false) {
    const base = schema.snapshot().draft
    if (!base) return
    setEditFocus(focus)
    begin('field', JSON.stringify({ ...editingOf(node), newField }), value => {
      const edit = JSON.parse(value) as FieldEditing
      if (focus === 'notes') return {
        ...base,
        schemaNodes: updateSchemaNode(base.schemaNodes, node.id, current => {
          const next = { ...current }
          if (edit.description) next.description = edit.description
          else delete next.description
          return next
        }),
      }
      if (edit.newValue?.trim()) throw new Error('Add the pending allowed value or clear it before saving.')
      if (edit.type === 'string' && edit.allowedValues?.length === 1) throw new Error('Need at least 2 allowed values.')
      const name = edit.name.trim().toLowerCase().replace(/\s+/g, '_')
      if (!name) throw new Error('Enter a field name.')
      return { ...base, schemaNodes: newField ? [...base.schemaNodes, editedField(node, name, edit)] : updateSchemaNode(base.schemaNodes, node.id, current => editedField(current, name, edit)) }
    })
  }
  function focusAfterEdit() {
    const fieldId = editing?.id
    const kind = snap.input?.kind
    if (kind === 'json') return // The modal restores its opener.
    queueMicrotask(() => {
      if (kind === 'description') {
        scrollRef.current?.querySelector<HTMLElement>('[aria-label="Edit description"]')?.focus()
        return
      }
      const field = Array.from(fieldListRef.current?.querySelectorAll<HTMLElement>('[data-schema-node-id]') ?? [])
        .find(element => element.dataset.schemaNodeId === fieldId)
      const target = field?.querySelector<HTMLElement>('[role="listitem"]') ?? addFieldRef.current
      target?.focus()
    })
  }
  function saveEdit() { if (inputHandle?.save()) focusAfterEdit() }
  function cancelEdit() { inputHandle?.cancel(); focusAfterEdit() }

  /** One click removes the field and its subtree; Undo puts it back where it was for eight seconds (§6). Both commits
   *  carry an empty label: the controller toasts every non-empty label at the top of the document (`onCommitMessage`,
   *  wired in `App.tsx`), and the panel's toast is the one notice for delete and undo. */
  function deleteField(node: SchemaNode, parentId: string | null, index: number) {
    const epoch = schema.snapshot().replacementVersion
    const focusTarget = rowAfterDeleting(node.id)
    const result = schema.commit((current) => removeSchemaNode(current, node.id)[1], '')
    if (!result.ok) {
      setMutationError(
        result.reason === 'no-draft' ? 'No template draft is open.' : result.reason === 'validation' ? result.message : `A sibling field already uses “${result.duplicateName}”.`,
      )
      return
    }
    // Keyboard focus stays in the list rather than falling to the page when the focused row goes.
    focusTarget?.focus()
    showPanelToast('Field removed', {
      durationMs: 8_000,
      action: {
        label: 'Undo',
        onAction: () => {
          if (schema.snapshot().input) { setMutationError('Save or Cancel the open edit before Undo.'); return }
          // Computed from the live snapshot before anything is committed: an impossible restore commits nothing.
          if (schema.snapshot().replacementVersion !== epoch) return
          const current = schema.snapshot().draft?.schemaNodes
          const restored = current ? restoreSchemaNode(current, node, parentId, index) : null
          if (!restored || !schema.commit(() => restored, '').ok) showPanelToast('Could not restore the field')
        },
      },
    })
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
    openField({ id: mkId(), name: '', type: 'verbatim-string' }, 'name', true)
  }
  function editDescription() {
    const base = schema.snapshot().draft
    if (base) begin('description', base.recordDescription, value => ({ ...base, recordDescription: value }))
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

  const editDisabled = editorReadOnly || !!dragging || snap.editingBlockedReason !== null
  const instructing = (snap.view === 'empty' || snap.view === 'failed') && !!onGenerateInstructions
  const originalField = editing && enumerateFieldPaths(nodes).find(field => field.id === editing.id)?.node
  const inlineEditing = editing && originalField && !editing.newField && !snap.input?.stale && !pending && !editorReadOnly && view === 'fields'
    && [...schemaAncestorIds(nodes, new Set([editing.id]))].filter(id => id !== editing.id).every(id => !collapsedIds.has(id))
  const losesChildren = originalField?.children?.length && editing?.type !== 'object' && !(editing?.type === 'array' && editing.itemType === null)
  const losesValues = originalField?.allowedValues?.length && editing?.type !== 'string'
  const losesItemType = originalField?.itemType && editing?.type !== 'array'
  const editForm = editing && <>
    {(losesChildren || losesValues || losesItemType) && <p role="status" className="text-compact text-danger">Saving this type will remove {losesChildren ? 'child fields and their metadata' : losesValues ? 'allowed values' : 'the array item type'}.</p>}
    <FieldEditForm editing={editing} error={editingError} focus={editFocus} onChange={setEditing} onSave={saveEdit} onCancel={cancelEdit} />
  </>

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
    if (inlineEditing && editing.id === node.id) return editForm
    // The row itself is the group target, at every level: the slot above it and its children below are targets of their
    // own, and the pointer moving from either onto the row must replace their target.
    return (
      <FieldRow node={node} isGroup={isGroup} expanded={isExpanded}
        onToggleExpanded={() => setCollapsedIds((current) => { const next = new Set(current); if (next.has(node.id)) next.delete(node.id); else next.add(node.id); return next })}
        change={change} outcome={change && replay?.outcomes.get(change.id)} impliedRemoved={ancestorRemoved}
        acceptance={change ? { accepted: acceptedChangeIds.has(change.id), onToggle: proposalReview.toggle } : undefined}
        readOnly={editorReadOnly} editDisabled={editDisabled} dragging={isDragging} dragActive={!!dragging} intoGroup={intoGroup}
        onMouseEnter={isDiff ? undefined : () => setGroupTarget(node.id, node.name)}
        onMouseLeave={isDiff ? undefined : () => clearGroupTarget(node.id)}
        onStartDrag={(event) => startDrag(event, node.id, parentId, node.name, isGroup)}
        onEdit={() => openField(node)}
        onEditValues={() => openField(node, 'values')}
        onAddNote={() => openField(node, 'notes')}
        onMove={() => {
          setMoving({ id: node.id, parentId, isGroup, epoch: snap.replacementVersion })
          setMoveParent(parentId); setMoveIndex(index)
        }}
        onDelete={() => deleteField(node, parentId, index)}
      />
    )
  }

  const destinations = moving ? [{ id: null, label: 'Root', children: nodes }, ...enumerateFieldPaths(nodes).filter(field => field.node.children !== undefined).map(field => ({ id: field.id, label: field.path.join(' / '), children: field.node.children! }))] : []
  const destination = destinations.find(item => item.id === moveParent)
  const selectedMove = moving && moving.epoch === snap.replacementVersion && destination
    ? moveSchemaNodes(nodes, moving, { type: 'slot', parentId: moveParent, index: moveIndex }, 0, 0) : null

  // ────────────────────────────────────────────────────────────────────────
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {snap.useBlockedReason && <p role="status" className="px-4 text-compact">{snap.useBlockedReason}</p>}
      {moving && <ModalDialog onDismiss={() => setMoving(null)} className={dialogCls} ariaLabel="Move field">
        <h2 className="text-content font-semibold">Move field</h2>
        <div className="mt-3 flex min-w-0 flex-col gap-3 text-secondary">
          <label htmlFor={moveParentId} className="flex min-w-0 flex-col gap-1 font-semibold">Destination parent
          <select id={moveParentId} autoFocus className="min-h-9 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 font-normal outline-none focus-visible:border-accent" value={moveParent ?? ''} onChange={event => { setMoveParent(event.target.value || null); setMoveIndex(0) }}>
            {destinations.map(item => <option key={item.id ?? 'root'} value={item.id ?? ''}>{item.label}</option>)}
          </select>
          </label>
          <label htmlFor={movePositionId} className="flex min-w-0 flex-col gap-1 font-semibold">Insertion position
          <select id={movePositionId} className="min-h-9 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2 font-normal outline-none focus-visible:border-accent" value={moveIndex} onChange={event => setMoveIndex(Number(event.target.value))}>
            {Array.from({ length: (destination?.children.length ?? 0) + 1 }, (_, index) => <option key={index} value={index}>{destination?.children[index] ? `Before ${destination.children[index]!.name}` : 'End'}</option>)}
          </select>
          </label>
          {!selectedMove && <p role="status" className="text-compact text-ink-muted">Choose a different position. Fields must retain unique sibling names and valid source references.</p>}
        </div>
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          <Button onClick={() => setMoving(null)}>Cancel</Button>
          <Button variant="positive" disabled={!selectedMove || snap.editingBlockedReason !== null} onClick={() => {
            const current = schema.snapshot()
            if (current.replacementVersion !== moving.epoch || current.editingBlockedReason || !current.draft) return
            const next = moveSchemaNodes(current.draft.schemaNodes, moving, { type: 'slot', parentId: moveParent, index: moveIndex }, 0, 0)
            if (next) { applyMove(next); setMoving(null) }
          }}>Move</Button>
        </div>
      </ModalDialog>}
      {/* ── Header ── */}
      <header className="flex shrink-0 flex-col gap-1 border-b border-line px-4 pb-2 pt-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1 text-content font-semibold text-ink">
            {schemaName && ready ? (
              editorReadOnly || !onRenameSchema ? (
                <h2 className="h-7 truncate leading-7" title={schemaName}>{schemaName}</h2>
              ) : (
                <SchemaNameEditor name={schemaName} nameAs="h2" onSubmit={onRenameSchema} />
              )
            ) : (
              <h2 className="h-7 truncate leading-7" title={sourceDocumentName}>{sourceDocumentName}</h2>
            )}
          </div>
          {ready && (
            <div className="flex shrink-0 items-center gap-2">
              <SegmentedControl
                aria-label="Template view"
                value={view}
                onChange={setView}
                options={[{ value: 'fields', label: 'Fields' }, { value: 'code', label: 'Code' }]}
              />
              {!editorReadOnly && <ActionsMenu label="Template actions" items={menuItems} />}
            </div>
          )}
        </div>
        {ready && (recordScope || boundaries) && (
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-secondary text-ink-muted">
            {recordScope && (
              <span className="inline-flex items-center gap-0.5">
                {/* A historical preview shows that revision's scope, read-only like the rest of the preview. */}
                <select
                  aria-label="Record scope"
                  className={`min-h-6 cursor-pointer appearance-none bg-transparent outline-none hover:text-ink disabled:cursor-default ${
                    shownScope === null ? 'font-semibold text-accent' : 'text-ink-muted'
                  }`}
                  value={shownScope ?? ''}
                  disabled={recordScope.disabled || editorReadOnly || snap.editingBlockedReason !== null}
                  onChange={(event) => { if (!editorReadOnly) recordScope.onChange(event.target.value as RecordScope) }}
                >
                  {shownScope === null && <option value="" disabled>Choose Article or Catalog</option>}
                  <option value="document">Article · one object for the document</option>
                  <option value="records">Catalog · a collection of records</option>
                </select>
                <span aria-hidden="true" className="text-ink-faint">▾</span>
              </span>
            )}
            {boundaries && (
              <label className="inline-flex min-w-0 max-w-full items-center gap-1">
                Boundaries
                <select
                  aria-label="Boundaries"
                  className="min-h-6 min-w-0 cursor-pointer appearance-none bg-transparent text-ink outline-none disabled:cursor-default"
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

      {/* ── Schema list / states, and the panel's toast over their bottom edge: clear of the conversation and the footer
          below, and not scrolling away with the fields. ── */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {historyError && <p role="alert" className="mb-2 text-xs text-danger [overflow-wrap:anywhere]">{historyError}</p>}
          {snap.historicalPreview && (
            // A column: the text reads across the panel and the commands wrap beneath it, at the 264px rail too.
            <div
              className="mb-3 flex flex-col gap-2 rounded-md border border-accent/30 bg-accent-ghost px-3 py-2"
              role="status"
            >
              <p className="min-w-0 text-compact text-ink">
                Viewing historical Template Revision{' '}
                {snap.historicalPreview.revisionNumber}. This preview is read-only.
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Button onClick={() => schema.closeHistoricalPreview()}>Close preview</Button>
                <Button variant="positive" disabled={creatingFromHistory} onClick={() => void createFromHistory()}>
                  Create Current Template Revision
                </Button>
              </div>
            </div>
          )}
          {ready && snap.generating && (
            <div className="mb-3 flex items-center justify-between gap-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2" role="status">
              <p className="text-compact text-ink">Regenerating. The current saved template remains available.</p>
              <Button variant="danger" onClick={() => schema.cancelGeneration()}>Stop</Button>
            </div>
          )}
          {ready && snap.sourceCoverage && snap.sourceCoverage.sourceRepresentationRevisionId === sourceRepresentationId && (
            <div className="mb-3 rounded-md border border-line px-3 py-2" role="note">
              <p className="text-compact text-ink-muted [overflow-wrap:anywhere]">{sourceCoverageNotice(snap.sourceCoverage)}</p>
            </div>
          )}
          {ready && snap.generationError && (
            <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2" role="alert">
              <p className="text-compact text-danger [overflow-wrap:anywhere]">Regeneration failed: {snap.generationError} The current saved template is unchanged.</p>
            </div>
          )}
          {snap.cancellationError && (
            <div className="mb-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2" role="alert">
              <p className="text-compact text-danger [overflow-wrap:anywhere]">{snap.cancellationError}</p>
            </div>
          )}
          {snap.save?.status === 'conflict' && (
            <div
              className="mb-2 flex items-center justify-between gap-3 rounded-md border border-danger/30 bg-danger-soft px-3 py-2"
              role="alert"
            >
              <p className="text-compact text-danger">
                The Current Template Revision changed elsewhere.
              </p>
              <button
                className="min-h-6 shrink-0 cursor-pointer rounded-md border border-danger/40 bg-surface px-2 py-1 text-compact font-semibold text-danger outline-none hover:bg-danger-soft"
                type="button"
                onClick={() => schema.reloadCurrent()}
              >
                Reload Current Template Revision
              </button>
            </div>
          )}
          {instructing ? (
            // Before the first schema the panel is the conversation: what should steer generation, then Generate
            // schema. Generating is the panel's one way in; a codebook import is chosen a step earlier, on the
            // Schemas tab, and what a record is gets said here.
            // With nothing said yet, Generate schema stands alone at the body's centre; after instructions it follows them.
            // Docked, the conversation and Generate schema live in the rail's chat; the body only points there.

              <div className="flex min-h-full flex-col justify-center gap-2">
                {snap.view === 'empty' ? (
                  <p className="mx-auto max-w-[34ch] text-center text-secondary leading-relaxed text-ink-muted">
                    Ask about the document or say what to extract in the chat below, then generate the template there.
                  </p>
                ) : (
                  <div className="flex flex-col items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2" role="alert">
                    <p className="text-compact leading-snug text-danger [overflow-wrap:anywhere]">{snap.generationError}</p>
                  </div>
                )}
              </div>
          ) : (
            <>
              {snap.view === 'empty' && <EmptyState title="No template yet" />}
              {snap.view === 'failed' && (
                <div className="rounded-xl border border-dashed border-danger/40 px-4 py-6 text-center">
                  <p className="text-content leading-snug text-danger [overflow-wrap:anywhere]">{snap.generationError}</p>
                </div>
              )}
            </>
          )}
          {snap.view === 'empty' && mutationError && (
            <p className="mt-2 text-compact font-semibold text-danger [overflow-wrap:anywhere]" role="alert">{mutationError}</p>
          )}

          {snap.view === 'generating' && <WorkingIndicator onStop={() => schema.cancelGeneration()} />}

          {ready && !snap.historicalPreview && view === 'code' && <div><pre className="overflow-x-auto whitespace-pre rounded border border-line p-2 font-mono text-compact">{templateCode(snap.draft!)}</pre>{!editorReadOnly && <Button className="mt-2" disabled={snap.editingBlockedReason !== null} onClick={startCodeEdit}>Edit</Button>}</div>}
          {jsonEditMode && <ModalDialog className="m-auto w-[90vw] max-w-5xl rounded-card border border-line bg-surface p-4 text-ink" ariaLabel="Edit template code" dismissDisabled onDismiss={cancelEdit}>
            <h3>Edit template code</h3>
            <p className="mt-1 text-secondary text-ink-muted">The complete definition includes field notes and source rules. Keep each existing field’s ID when editing it.</p>
            <label htmlFor={codeInputId}>Template code</label>
            <textarea id={codeInputId} aria-label="Template code" autoFocus spellCheck={false} wrap="off" className="my-3 h-[60vh] w-full overflow-x-auto whitespace-pre border border-line bg-canvas p-2 font-mono text-secondary" value={jsonDraft} onChange={e => inputHandle?.update(e.target.value)} />
            {jsonEditError && <p role="alert">{jsonEditError}</p>}
            <Button variant="positive" onClick={saveEdit}>Save</Button><Button onClick={cancelEdit}>Cancel</Button>
          </ModalDialog>}

          {/* A replaced field's stale input stays reachable for copying even when its row no longer exists. */}
          {editing && !inlineEditing && (!editing.newField || snap.input?.stale || view !== 'fields' || editorReadOnly) && editForm}
          {snap.historicalPreview && <SchemaDefinitionBody view={view} definition={snap.historicalPreview} recordScope={snap.historicalPreview.recordScope} />}
          {ready && !snap.historicalPreview && view === 'fields' && (
            <>
              <div className="mb-3 block">
                <span className="text-compact font-semibold text-ink-muted">What one record is</span>
                {snap.input?.kind === 'description' ? <>
                  <textarea id={descriptionInputId} ref={descriptionRef} aria-label="What one record is" autoFocus className="mt-1 block w-full resize-none rounded-[3px] border border-line bg-transparent px-2 py-1 text-secondary leading-relaxed text-ink outline-none focus:border-line-strong" rows={DESCRIPTION_ROWS.min} value={recordDescriptionDraft} onChange={event => inputHandle?.update(event.target.value)} />
                  {editingError && <p role="alert">{editingError}</p>}
                  <Button variant="positive" onClick={saveEdit}>Save</Button><Button onClick={cancelEdit}>Cancel</Button>
                </> : <button type="button" aria-label="Edit description" disabled={editDisabled} onClick={editDescription}
                  className="mt-1 block min-h-9 w-full cursor-text rounded-[3px] text-left text-secondary [overflow-wrap:anywhere] outline-none hover:bg-surface-muted focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-default">
                  {recordDescriptionDraft || 'Describe the record this template extracts…'}
                </button>}
              </div>
              {mutationError && <p className="mb-2 text-compact font-semibold text-danger [overflow-wrap:anywhere]" role="alert">{mutationError}</p>}
              {/* The list carries its rows' 8px bleed, so no row's box overflows it (§6, the 264px rail). */}
              <div ref={fieldListRef} role="list" aria-label="Template fields" className="-mx-2 flex flex-col px-2">
                <SchemaTree nodes={pending ? pending.reviewNodes : nodes} expanded={node => !collapsedIds.has(node.id) || (dragMode === 'normal' && overTarget?.type === 'group' && overTarget.id === node.id)} renderRow={renderField}
                  removed={node => pending?.changes.some(change => change.id === node.id && change.kind === 'removed') ?? false}
                  renderSlot={(parentId, index) => <div className={slotCls(parentId, index)} onMouseEnter={() => setSlotTarget(parentId, index)} />} />
                {editing?.newField && !snap.input?.stale && editForm}
              </div>
              {!editorReadOnly && <button
                ref={addFieldRef}
                className="mt-2.5 block w-full cursor-pointer rounded-lg border-[1.5px] border-dashed border-line-strong bg-transparent py-2 text-xs font-semibold text-ink-muted outline-none transition-colors hover:border-line-strong hover:text-ink focus-visible:border-accent focus-visible:text-accent"
                type="button"
                disabled={editDisabled}
                onClick={addField}
              >
                + Add field
              </button>}
            </>
          )}
        </div>
        {panelToast && (
          <div className="pointer-events-none absolute inset-x-3 bottom-3 z-20 flex justify-center">
            <Toast key={panelToast.id} message={panelToast.message} action={panelToast.action} onDismiss={() => { if (!schema.snapshot().input) dismissPanelToast() }} onHoldChange={holdPanelToast} />
          </div>
        )}
      </div>

      {/* ── Footer ── */}
      <footer className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-line px-4 py-2 text-compact text-ink-faint">
        {snap.view === 'generating' && (
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-stale" />
            Producing template from the document…
          </span>
        )}
        {snap.view === 'empty' && onGenerateInstructions && 'Generate the template from the document to continue'}
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
        <ModalDialog className={dialogCls} ariaLabel="Template history" onDismiss={() => setHistoryOpen(false)}>
          <h3 className="text-secondary font-semibold text-ink">Template history</h3>
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
                <span className="block text-compact text-ink-muted [overflow-wrap:anywhere]">{revision.origin} · {revision.summary}</span>
                <span className="block text-overline text-ink-faint">{new Date(revision.createdAt).toLocaleString()}</span>
              </button>
            ))}
          </div>
        </ModalDialog>
      )}
      {confirmingDeleteSchema && (
        <ModalDialog className={dialogCls} ariaLabel="Clear current template" onDismiss={() => setConfirmingDeleteSchema(false)}>
          <p className="text-secondary font-semibold text-ink">Clear current template?</p>
          <p className="mt-1 text-compact leading-relaxed text-ink-muted">
            This clears the current template. In batch preparation it saves empty fields and keeps the record description and scope. Saved Template Revisions remain in history.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <Button onClick={() => setConfirmingDeleteSchema(false)}>Cancel</Button>
            {/* A clear the workspace refuses keeps the dialog open; a clear it accepts resets the editor, closing it. */}
            <Button variant="danger" onClick={() => void deleteSchema()}>Clear template</Button>
          </div>
        </ModalDialog>
      )}

      {/* Drag overlay chip */}
      {dragging && (
        <div
          style={{ position: 'fixed', left: dragX + 18, top: dragY - 16, pointerEvents: 'none', zIndex: 9999 }}
          className="flex select-none items-center gap-1.5 rounded-lg border-[1.5px] border-accent bg-surface px-3 py-1.5 font-mono text-secondary font-medium text-ink shadow-[0_4px_20px_rgba(51,48,44,.22)] whitespace-nowrap max-w-80"
        >
          <span className="shrink-0 text-sm">{dragMode === 'indent' ? '→' : dragMode === 'outdent' ? '←' : '⠿'}</span>
          <span className="min-w-0 truncate">{dragging.name}</span>
        </div>
      )}
    </div>
  )
}

export default SchemaPanel
