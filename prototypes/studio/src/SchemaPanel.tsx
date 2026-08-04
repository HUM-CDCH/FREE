import { useEffect, useRef, useState } from 'react'
import { requestSchemaEdit } from './api'
import type { AnnotationsMode, ExtractionStrategy } from './api'
import { applyOps } from './schemaOps'
import { countTemplateFields, isRecord } from './template'
import { type SchemaNode, mkId, templateToNodes, nodesToTemplate } from './schemaNode'
import { collectIds, summarizeSchemaChange, type SchemaHistoryEntry } from './schemaHistory'
import { SegmentedControl } from './ui'

// ────────────────────────────────────────────────────────────────────────────
// Exported types (App.tsx depends on TemplateState)
// ────────────────────────────────────────────────────────────────────────────

export type TemplateState =
  | { status: 'idle' }
  | { status: 'generating' }
  | { status: 'ready'; nodes: SchemaNode[]; inputsKey: string; edited?: boolean }
  | { status: 'error'; message: string }

// ────────────────────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────────────────────

type SchemaPanelProps = {
  state: TemplateState
  stale: boolean
  onGenerate: () => void
  onNodesChange: (nodes: SchemaNode[], message: string) => void
  onChatSchemaChange: (nodes: SchemaNode[], message: string) => void
  history: SchemaHistoryEntry[]
  extractionStrategy: ExtractionStrategy
  onExtractionStrategyChange: (strategy: ExtractionStrategy) => void
  annotationCount: number
  annotationsMode: AnnotationsMode
  onAnnotationsModeChange: (mode: AnnotationsMode) => void
  documentMarkdown: string | null
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

type FieldEditing = { id: string; name: string; type: string }

type ChatMsg = { role: 'user' | 'assistant'; text: string }

type NodeDiffStatus = 'added' | 'removed'

type PendingChange = {
  displayNodes: SchemaNode[]
  diffMap: Map<string, NodeDiffStatus>
  // Keyed by the real node id (never a "-ghost" id) — one entry per logical
  // change (add / remove / rename+retype), independent of accept/reject.
  rejectedKeys: Set<string>
}


// Diff computation (task 7.3)
// ────────────────────────────────────────────────────────────────────────────

function buildDiffPreview(
  oldNodes: SchemaNode[],
  newNodes: SchemaNode[],
): { displayNodes: SchemaNode[]; diffMap: Map<string, NodeDiffStatus> } {
  const oldById = collectIds(oldNodes)
  const newById = collectIds(newNodes)
  const diffMap = new Map<string, NodeDiffStatus>()
  // ghost nodes: old versions of modified nodes, shown in red above the new version
  const ghostMap = new Map<string, SchemaNode>()

  for (const [id, newNode] of newById) {
    const oldNode = oldById.get(id)
    if (!oldNode) {
      diffMap.set(id, 'added')
    } else if (oldNode.name !== newNode.name || oldNode.type !== newNode.type) {
      // split into ghost (old, red) + actual (new, green)
      const ghostId = `${id}-ghost`
      ghostMap.set(ghostId, { id: ghostId, name: oldNode.name, type: oldNode.type })
      diffMap.set(ghostId, 'removed')
      diffMap.set(id, 'added')
    }
  }
  for (const id of oldById.keys()) {
    if (!newById.has(id)) diffMap.set(id, 'removed')
  }

  function mergeLevel(newLevel: SchemaNode[], oldLevel: SchemaNode[]): SchemaNode[] {
    const result: SchemaNode[] = []
    let newIdx = 0
    for (let oi = 0; oi < oldLevel.length; oi++) {
      const oldNode = oldLevel[oi]
      if (diffMap.get(oldNode.id) === 'removed') {
        // truly removed — inject at original position
        result.push(oldNode)
      } else {
        // node present in newLevel (unmodified or modified/added)
        while (newIdx < newLevel.length && newLevel[newIdx].id !== oldNode.id) {
          result.push(newLevel[newIdx++])
        }
        if (newIdx < newLevel.length && newLevel[newIdx].id === oldNode.id) {
          const n = newLevel[newIdx++]
          // for modified nodes, inject old ghost immediately before the new version
          const ghostId = `${n.id}-ghost`
          if (ghostMap.has(ghostId)) result.push(ghostMap.get(ghostId)!)
          result.push(n.children ? { ...n, children: mergeLevel(n.children, oldNode.children ?? []) } : n)
        }
      }
    }
    while (newIdx < newLevel.length) result.push(newLevel[newIdx++])
    return result
  }

  const displayNodes = diffMap.size === 0 ? newNodes : mergeLevel(newNodes, oldNodes)
  return { displayNodes, diffMap }
}

// A modified field is split into a "-ghost" (old) row and a real (new) row —
// both belong to the same logical change, keyed by the real id.
function changeKeyOf(nodeId: string): string {
  return nodeId.replace(/-ghost$/, '')
}

// Whether `nodeId` is the root of a wholesale added/removed subtree — i.e. a
// genuinely new or deleted node, as opposed to the "new" half of a
// rename/retype pair (which keeps its subtree's independent diffs intact).
// Descendants of a wholesale add/remove all get their own diffMap entries
// too (buildDiffPreview flattens ids recursively), but those are echoes of
// the same change, not independent decisions — see resolveAcceptedNodes and
// its render-side counterpart in SchemaPanel's row renderers.
function isWholesaleDiffRoot(diffMap: Map<string, NodeDiffStatus>, nodeId: string): boolean {
  const status = diffMap.get(nodeId)
  if (status === 'removed') return !nodeId.endsWith('-ghost')
  if (status === 'added') return diffMap.get(`${nodeId}-ghost`) !== 'removed'
  return false
}

// Resolves `displayNodes` (which contains every proposed change, positioned
// for preview) down to the tree that should actually be committed, given
// which logical changes the researcher rejected. `displayNodes` already has
// removed/old nodes reinserted at their original position (see mergeLevel
// above), so this only has to decide, per row, whether to keep the old or
// the new version — no separate position-tracking is needed.
function resolveAcceptedNodes(
  displayLevel: SchemaNode[],
  diffMap: Map<string, NodeDiffStatus>,
  rejectedKeys: Set<string>,
): SchemaNode[] {
  const out: SchemaNode[] = []
  for (let i = 0; i < displayLevel.length; i++) {
    const node = displayLevel[i]
    const status = diffMap.get(node.id)

    if (status === undefined) {
      out.push(node.children ? { ...node, children: resolveAcceptedNodes(node.children, diffMap, rejectedKeys) } : node)
      continue
    }

    if (node.id.endsWith('-ghost')) {
      const realId = changeKeyOf(node.id)
      if (rejectedKeys.has(realId)) {
        // rename/retype rejected — keep the old version, skip the paired new row
        out.push(node.children
          ? { ...node, id: realId, children: resolveAcceptedNodes(node.children, diffMap, rejectedKeys) }
          : { ...node, id: realId })
        i++
      }
      // accepted — drop the ghost, let the loop reach the paired new row below
      continue
    }

    if (status === 'added') {
      if (rejectedKeys.has(node.id)) continue // reverts an add, or the new half of a rejected rename/retype
      out.push(node.children ? { ...node, children: resolveAcceptedNodes(node.children, diffMap, rejectedKeys) } : node)
      continue
    }

    // status === 'removed' (real id, not a ghost) — a wholesale deletion.
    // Keep the *entire* original subtree verbatim when rejected: descendants
    // carry their own 'removed' diffMap entries too (buildDiffPreview
    // flattens ids recursively), but those are echoes of this same removal,
    // not independent decisions, so they must not be re-resolved here.
    if (rejectedKeys.has(node.id)) {
      out.push(node)
    }
  }
  return out
}

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
    if (n.id === targetId)
      return { ...n, type: n.children !== undefined ? n.type : 'object', children: [...(n.children ?? []), moved] }
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
      const ch = [...(n.children ?? [])]; ch.splice(Math.max(0, Math.min(index, ch.length)), 0, moved); return { ...n, children: ch }
    }
    if (n.children) return { ...n, children: insertAtSlot(n.children, parentId, index, moved) }
    return n
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

// ────────────────────────────────────────────────────────────────────────────
// Shared UI sub-components
// ────────────────────────────────────────────────────────────────────────────

function WorkingIndicator() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-md border border-line bg-canvas px-4 py-8 text-center" aria-live="polite">
      <span aria-hidden="true" className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent" />
      <p className="text-[13px] font-semibold text-ink">Producing schema…</p>
      <p className="max-w-[34ch] text-xs leading-snug text-ink-muted">This can take a while on large documents.</p>
    </div>
  )
}

const genBtnCls =
  'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-[11px] font-semibold text-ink-muted outline-none transition-colors hover:border-accent/50 hover:bg-accent-soft hover:text-accent focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-60 disabled:hover:border-line disabled:hover:bg-surface disabled:hover:text-ink-muted'

function AnnotationsModeToggle({ mode, onChange }: { mode: AnnotationsMode; onChange: (mode: AnnotationsMode) => void }) {
  const seg = (active: boolean) =>
    `cursor-pointer px-2.5 py-1 text-[11px] font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40 ${active ? 'bg-ink text-canvas' : 'bg-surface text-ink-muted hover:text-ink'}`
  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-line" role="group" aria-label="How highlights shape the schema">
      <button className={seg(mode === 'hints')} type="button" aria-pressed={mode === 'hints'} onClick={() => onChange('hints')}>Hints</button>
      <button className={seg(mode === 'fields')} type="button" aria-pressed={mode === 'fields'} onClick={() => onChange('fields')}>Fields</button>
    </div>
  )
}

// Task 5.1 – FieldEditForm (id-based, not path-based)
function FieldEditForm({ editing, onChange, onSave, onCancel }: {
  editing: FieldEditing
  onChange: (e: FieldEditing) => void
  onSave: () => void
  onCancel: () => void
}) {
  return (
    <div className="my-0.5 flex items-center gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2">
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
  stale,
  onGenerate,
  onNodesChange,
  onChatSchemaChange,
  history,
  extractionStrategy,
  onExtractionStrategyChange,
  annotationCount,
  annotationsMode,
  onAnnotationsModeChange,
  documentMarkdown,
}: SchemaPanelProps) {
  // ── render state ──
  const [nodes, setNodes] = useState<SchemaNode[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)
  const [dragging, setDragging] = useState<DragState | null>(null)
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const [overTarget, setOverTarget] = useState<DropTarget | null>(null)
  const [editing, setEditing] = useState<FieldEditing | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: 'assistant', text: "Edit through drag and drop, or describe a change. I'll show a diff to review first." },
  ])
  const [pending, setPending] = useState<PendingChange | null>(null)
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
  onNodesChangeRef.current = onNodesChange

  const ready = state.status === 'ready'
  const fieldCount = ready ? countTemplateFields(nodesToTemplate(state.nodes)) : 0
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
      setEditing(null)
      setPending(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputsKey])

  // Task 7.5 – scroll chat to bottom on new messages / pending change
  useEffect(() => {
    const el = chatRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.length, pending])

  // ── Task 4: auto-scroll helpers ──
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
        // Task 4.2: 60px edge zone, 7px/frame
        if (dragYRef.current < r.top + 60) el.scrollTop -= 7
        else if (dragYRef.current > r.bottom - 60) el.scrollTop += 7
      }
      rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  // Task 2.5 – commitDrop (reads from refs, no stale closure risk)
  function commitDrop() {
    const drag = draggingRef.current
    const target = overTargetRef.current
    if (!drag) return
    const cur = nodesRef.current
    const dx = dragXRef.current - dragStartXRef.current
    const dy = dragYRef.current - dragStartYRef.current
    const horizontalIntent = Math.abs(dx) > INDENT_THRESHOLD && Math.abs(dy) < VERTICAL_TOLERANCE

    const apply = (nodes: SchemaNode[]) => {
      nodesRef.current = nodes; setNodes(nodes)
      onNodesChangeRef.current(nodes, `⠿ Moved "${drag.name}"`)
    }

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
      nodesRef.current = finalNodes
      setNodes(finalNodes)
      onNodesChangeRef.current(finalNodes, `⠿ Moved "${drag.name}" into "${target.name}"`)
    } else {
      const { parentId, index } = target
      const si = srcIndex(cur, drag)
      const [moved, root] = extractNode(cur, drag.id)
      if (!moved) return
      let ii = index
      if (drag.parentId === (parentId ?? null) && si < ii) ii--
      const finalNodes = insertAtSlot(root, parentId ?? null, ii, moved)
      nodesRef.current = finalNodes
      setNodes(finalNodes)
      onNodesChangeRef.current(finalNodes, `⠿ Moved "${drag.name}"`)
    }
  }

  // Task 2.2 – global mouse listeners (set up once)
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
    // Task 4.3 – cancel RAF on unmount
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      stopScroll()
    }
  }, [])

  // ── Task 2.3 – drag start ──
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

  // Task 2.4 – slot targets
  function setSlotTarget(parentId: string | null, index: number) {
    if (!draggingRef.current) return
    const t: DropTarget = { type: 'slot', parentId, index }
    overTargetRef.current = t
    setOverTarget(t)
  }

  // Task 3.1 – group hover targets
  function setGroupTarget(id: string, name: string) {
    const drag = draggingRef.current
    if (!drag || drag.isGroup || drag.id === id || drag.parentId === id) return
    const t: DropTarget = { type: 'group', id, name }
    overTargetRef.current = t
    setOverTarget(t)
    setExpandedIds(s => new Set([...s, id]))
  }

  // Task 3.2 – clear group target on leave
  function clearGroupTarget(id: string) {
    if (overTargetRef.current?.type === 'group' && overTargetRef.current.id === id) {
      overTargetRef.current = null
      setOverTarget(null)
    }
  }

  // ── Task 5: inline edit ──
  function saveEdit() {
    if (!editing) return
    const oldNodes = nodesRef.current
    const name = editing.name.trim().toLowerCase().replace(/\s+/g, '_') || 'field'
    const newNodes = oldNodes.map(n => {
      if (n.id === editing.id) {
        // Task 5.2 – convert type/children
        const out: SchemaNode = { ...n, name, type: editing.type }
        if (editing.type === 'object' || editing.type === 'array') {
          if (!out.children) out.children = []
        } else {
          delete out.children
        }
        return out
      }
      if (n.children) {
        return { ...n, children: n.children.map(c => (c.id === editing.id ? { ...c, name, type: editing.type } : c)) }
      }
      return n
    })
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChange(newNodes, `✎ ${summarizeSchemaChange(oldNodes, newNodes)}`)
    setEditing(null)
  }

  function bulkRemoveNodes() {
    const oldNodes = nodesRef.current
    let newNodes = oldNodes
    for (const id of selectedIds) {
      const [, after] = extractNode(newNodes, id)
      newNodes = after
    }
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChange(newNodes, `✎ ${summarizeSchemaChange(oldNodes, newNodes)}`)
    if (editing && selectedIds.has(editing.id)) setEditing(null)
    setSelectedIds(new Set())
  }

  function toggleSelected(id: string) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function updateNodeDescription(id: string, description: string | undefined) {
    const oldNodes = nodesRef.current
    function update(ns: SchemaNode[]): SchemaNode[] {
      return ns.map(n => {
        if (n.id === id) return { ...n, description }
        if (n.children) return { ...n, children: update(n.children) }
        return n
      })
    }
    const newNodes = update(oldNodes)
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChangeRef.current(newNodes, `✎ ${summarizeSchemaChange(oldNodes, newNodes)}`)
  }

  function addField() {
    const cur = nodesRef.current
    let name = 'nyt_felt'
    let suffix = 2
    while (cur.some(n => n.name === name)) name = `nyt_felt_${suffix++}`
    const id = mkId()
    const newNodes = [...cur, { id, name, type: 'verbatim-string' }]
    nodesRef.current = newNodes
    setNodes(newNodes)
    onNodesChange(newNodes, `✎ ${summarizeSchemaChange(cur, newNodes)}`)
    setView('fields')
    setEditing({ id, name, type: 'verbatim-string' })
  }

  // const SUGGESTIONS = [
  //   { id: 's1', label: 'Add a field', prompt: 'Add one new relevant field to this schema.' },
  //   { id: 's2', label: 'Remove a field', prompt: 'Remove the least important field from this schema.' },
  //   { id: 's3', label: 'Change a field type', prompt: 'Find a field whose type seems wrong and correct it.' },
  // ]


  // ── Tasks 6–8: chat ──
  async function sendChatMessage(text: string) {
    if (!text.trim() || chatLoading || pending) return
    const userMsg = text.trim()
    setChat(c => [...c, { role: 'user', text: userMsg }])
    setChatInput('')
    setChatLoading(true)
    const controller = new AbortController()
    chatAbortRef.current = controller

    try {
      const ops = await requestSchemaEdit(nodesRef.current, userMsg, documentMarkdown, controller.signal)
      const newNodes = applyOps(nodesRef.current, ops)
      const { displayNodes, diffMap } = buildDiffPreview(nodesRef.current, newNodes)
      if (diffMap.size === 0) {
        setChat(c => [...c, { role: 'assistant', text: 'No changes needed — the schema already matches your request.' }])
      } else {
        setPending({ displayNodes, diffMap, rejectedKeys: new Set() })
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        setChat(c => [...c, { role: 'assistant', text: 'Cancelled.' }])
      } else {
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

  // Task 8.2 – apply pending
  function applyPending() {
    if (!pending) return
    const oldNodes = nodesRef.current
    const finalNodes = resolveAcceptedNodes(pending.displayNodes, pending.diffMap, pending.rejectedKeys)
    nodesRef.current = finalNodes
    setNodes(finalNodes)
    onChatSchemaChange(finalNodes, `✦ ${summarizeSchemaChange(oldNodes, finalNodes)} (via chat)`)
    setChat(c => [...c, { role: 'assistant', text: '✓ Schema changes applied.' }])
    setPending(null)
  }

  // Toggles whether one proposed change (keyed by its real node id) is
  // included when the pending diff is applied.
  function toggleChangeRejected(key: string) {
    setPending(p => {
      if (!p) return p
      const next = new Set(p.rejectedKeys)
      next.has(key) ? next.delete(key) : next.add(key)
      return { ...p, rejectedKeys: next }
    })
  }

  // Task 8.3 – discard
  function discardPending() {
    setChat(c => [...c, { role: 'assistant', text: 'Okay — discarded, no changes made.' }])
    setPending(null)
  }

  // function pickSuggestion(s: (typeof SUGGESTIONS)[number]) {
  //   setUsedSuggs(u => [...u, s.id])
  //   void sendChatMessage(s.prompt)
  // }

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

  // Task 5.3 – disable edit buttons while dragging
  const editDisabled = !!dragging

  // Task 8.4 – disable chat input while pending
  const chatBlocked = !!pending || chatLoading

  // Whether at least one proposed change is still accepted (not rejected) —
  // "Apply changes" is a no-op otherwise.
  const hasAcceptedChanges = pending
    ? [...pending.diffMap.keys()].some(id => !pending.rejectedKeys.has(changeKeyOf(id)))
    : false

  // const activeSuggs = SUGGESTIONS.filter(s => !usedSuggs.includes(s.id))

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
    const diffStatus = pending?.diffMap.get(node.id) ?? null
    const isDiff = diffStatus !== null
    const isGhostRow = node.id.endsWith('-ghost')
    const changeKey = changeKeyOf(node.id)
    const isRejected = isDiff && (pending?.rejectedKeys.has(changeKey) ?? false)
    const showToggle = isDiff && !isGhostRow
    const diffBg = diffStatus === 'added' ? 'bg-green-soft' : diffStatus === 'removed' ? 'bg-danger-soft' : ''
    const diffText = diffStatus === 'added' ? 'text-green' : diffStatus === 'removed' ? 'text-danger line-through' : 'text-ink'
    const absorbedByForChildren = pending && isWholesaleDiffRoot(pending.diffMap, node.id) ? changeKey : null

    return (
      <div key={node.id}>
        {/* drop slot before this field */}
        <div className={slotCls(null, i)} onMouseEnter={() => setSlotTarget(null, i)} />

        {isEditing && editing && !isDiff ? (
          <FieldEditForm editing={editing} onChange={setEditing} onSave={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <div
            className={`${rowCls(node.id, intoGroup, isDragging)} ${diffBg} ${isRejected ? 'opacity-45' : ''}`}
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
            <span className={`min-w-0 truncate font-mono text-[13.5px] font-medium ${diffText}`}>{node.name}</span>
            {intoGroup && !isDiff && (
              <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white whitespace-nowrap">
                into {node.name}
              </span>
            )}
            <span className="min-w-0 flex-1" />
            {showToggle && (
              <button
                className={`shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10.5px] font-semibold outline-none transition-colors ${isRejected ? 'text-ink-muted hover:text-accent' : 'text-danger hover:brightness-90'}`}
                type="button"
                title={isRejected ? 'Restore this change' : 'Reject this change'}
                onClick={e => { e.stopPropagation(); toggleChangeRejected(changeKey) }}
              >
                {isRejected ? '↺ Restore' : '✕ Reject'}
              </button>
            )}
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
                onClick={() => setEditing({ id: node.id, name: node.name, type: node.type })}
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
              </button>
            )}
            {!isDiff && (
              <input
                type="checkbox"
                className="shrink-0 cursor-pointer accent-accent"
                checked={selectedIds.has(node.id)}
                onChange={() => toggleSelected(node.id)}
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
            {(node.children ?? []).map((child, j) => renderChildField(child, node.id, j, absorbedByForChildren))}
            <div
              className={slotCls(node.id, (node.children ?? []).length)}
              onMouseEnter={() => setSlotTarget(node.id, (node.children ?? []).length)}
            />
          </div>
        )}
      </div>
    )
  }

  // `absorbedBy` is the change-key of the nearest ancestor whose ENTIRE
  // subtree was wholesale added/removed (not renamed/retyped) — such an
  // ancestor's descendants get their own diffMap entries too, but those are
  // just echoes of the same change, so they inherit its key instead of
  // getting their own independent accept/reject toggle. Null means this row
  // is itself the top of whatever change it's part of.
  function renderChildField(child: SchemaNode, parentId: string, j: number, absorbedBy: string | null): React.ReactNode {
    const isDragging = dragging?.id === child.id
    const isEditing = editing?.id === child.id
    const isGroup = child.children !== undefined
    const intoGroup = dragMode === 'normal' && overTarget?.type === 'group' && overTarget.id === child.id
    const isExpanded = expandedIds.has(child.id) || intoGroup
    const diffStatus = pending?.diffMap.get(child.id) ?? null
    const isDiff = diffStatus !== null
    const isGhostRow = child.id.endsWith('-ghost')
    const ownChangeKey = changeKeyOf(child.id)
    const changeKey = absorbedBy ?? ownChangeKey
    const isRejected = isDiff && (pending?.rejectedKeys.has(changeKey) ?? false)
    const showToggle = isDiff && !isGhostRow && absorbedBy === null
    const diffBg = diffStatus === 'added' ? 'bg-green-soft' : diffStatus === 'removed' ? 'bg-danger-soft' : ''
    const diffText = diffStatus === 'added' ? 'text-green' : diffStatus === 'removed' ? 'text-danger line-through' : 'text-ink'
    const absorbedByForChildren = absorbedBy ?? (pending && isWholesaleDiffRoot(pending.diffMap, child.id) ? ownChangeKey : null)

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
          <FieldEditForm editing={editing} onChange={setEditing} onSave={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <div
            className={`-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 border transition-opacity duration-100 ${intoGroup && !isDiff ? 'border-accent/40 bg-accent-soft' : 'border-transparent'} ${isDragging ? 'opacity-40' : ''} ${diffBg} ${isRejected ? 'opacity-45' : ''}`}
          >
            {!isDiff && (
              <span
                className="shrink-0 cursor-grab select-none px-0.5 text-[13px] leading-none text-ink-faint"
                onMouseDown={e => startDrag(e, child.id, parentId, child.name, isGroup)}
              >
                ⠿
              </span>
            )}
            <span className={`min-w-0 truncate font-mono text-[13.5px] font-medium ${diffText}`}>{child.name}</span>
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
            {showToggle && (
              <button
                className={`shrink-0 cursor-pointer whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[10.5px] font-semibold outline-none transition-colors ${isRejected ? 'text-ink-muted hover:text-accent' : 'text-danger hover:brightness-90'}`}
                type="button"
                title={isRejected ? 'Restore this change' : 'Reject this change'}
                onClick={e => { e.stopPropagation(); toggleChangeRejected(changeKey) }}
              >
                {isRejected ? '↺ Restore' : '✕ Reject'}
              </button>
            )}
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
                onClick={() => setEditing({ id: child.id, name: child.name, type: child.type })}
              >
                <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>
              </button>
            )}
            {!isDiff && (
              <input
                type="checkbox"
                className="shrink-0 cursor-pointer accent-accent"
                checked={selectedIds.has(child.id)}
                onChange={() => toggleSelected(child.id)}
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
            {(child.children ?? []).map((grandchild, k) => renderChildField(grandchild, child.id, k, absorbedByForChildren))}
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
      <header className="flex shrink-0 flex-col gap-1.5 border-b border-line px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-ink-muted">Extraction Schema</h2>
          <p className="truncate font-mono text-[13px] font-medium text-ink">
            {extractionStrategy === 'catalog' ? 'Catalog schema' : 'Article schema'}
          </p>
        </div>
        <div className="flex shrink-0 items-center justify-between gap-2">
          {/* Chosen before generation — it shapes the generation prompt itself
              (see schemaPrompt), so it stays available in every schema state,
              not just once a schema already exists. */}
          <SegmentedControl
            aria-label="Extraction strategy"
            value={extractionStrategy}
            onChange={onExtractionStrategyChange}
            options={[
              { value: 'article', label: 'Article', title: 'One continuous document — always extract in a single pass' },
              { value: 'catalog', label: 'Catalog', title: 'Many similar records (e.g. one section per grave) — extract each section independently' },
            ]}
          />
          {ready && (
            <div className="flex shrink-0 overflow-hidden rounded-md border border-line">
              <button className={tabCls(view === 'fields')} type="button" aria-pressed={view === 'fields'} onClick={() => setView('fields')}>Fields</button>
              <button className={`${tabCls(view === 'json')} font-mono`} type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}>{'JSON'}</button>
            </div>
          )}
        </div>
      </header>

      {/* ── Schema list / states ── */}
      <div ref={scrollRef} className="scrollbar-subtle min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {state.status === 'idle' && (
          <div className="rounded-xl border border-dashed border-line-strong px-4 py-6 text-center">
            <p className="text-[13px] font-semibold text-ink">No schema yet</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              FREE produces the extraction schema from the document with the extraction model.
            </p>
            {annotationCount > 0 && (
              <div className="mt-3 flex items-center justify-center gap-2">
                <span className="text-[11px] text-ink-faint">Use highlights as</span>
                <AnnotationsModeToggle mode={annotationsMode} onChange={onAnnotationsModeChange} />
              </div>
            )}
            <button className={`${genBtnCls} mt-3`} type="button" onClick={onGenerate}>Generate schema</button>
          </div>
        )}

        {state.status === 'generating' && <WorkingIndicator />}

        {state.status === 'error' && (
          <div className="rounded-xl border border-dashed border-danger/40 px-4 py-6 text-center">
            <p className="text-[13px] leading-snug text-danger">{state.message}</p>
            <button className={`${genBtnCls} mt-3`} type="button" onClick={onGenerate}>Retry</button>
          </div>
        )}

        {ready && view === 'json' && (
          <div className="flex flex-col gap-1.5">
            {!jsonEditMode ? (
              <div className="relative">
                <pre className="overflow-x-auto whitespace-pre rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink">
                  {JSON.stringify(nodesToTemplate(nodes), null, 2)}
                </pre>
                <button
                  className="absolute right-2 top-2 cursor-pointer rounded border border-line bg-surface px-1.5 py-0.5 font-sans text-[10px] font-semibold text-ink-muted outline-none transition-colors hover:border-accent hover:text-accent"
                  type="button"
                  onClick={() => {
                    setJsonDraft(JSON.stringify(nodesToTemplate(nodes), null, 2))
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
                        const oldNodes = nodesRef.current
                        const newNodes = templateToNodes(parsed)
                        nodesRef.current = newNodes
                        setNodes(newNodes)
                        onNodesChangeRef.current(newNodes, `✎ ${summarizeSchemaChange(oldNodes, newNodes)} (via JSON editor)`)
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
            {selectedIds.size > 0 && (
              <div className="mb-2 flex items-center justify-between rounded-lg border border-danger/30 bg-danger-soft px-3 py-1.5">
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
              {(pending ? pending.displayNodes : nodes).map((node, i) => renderRootField(node, i))}
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

      {/* ── Task 6: Chat panel (visible when schema is ready) ── */}
      {ready && (
        <div className="flex shrink-0 flex-col border-t border-line bg-surface-muted" style={{ maxHeight: 224 }}>
          <div className="flex shrink-0 items-center justify-between border-b border-line px-3.5 py-1">
            <span className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Chat</span>
            <div className="relative">
              <button
                className="cursor-pointer rounded-md border border-line bg-surface p-1 text-ink-muted outline-none transition-colors hover:border-accent/50 hover:text-accent disabled:cursor-default disabled:opacity-40"
                type="button"
                title="Schema edit history"
                disabled={history.length === 0}
                onClick={() => setHistoryOpen((open) => !open)}
              >
                <svg width="13" height="13" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-13a1 1 0 10-2 0v5a1 1 0 00.293.707l3 3a1 1 0 001.414-1.414L11 9.586V5z" clipRule="evenodd"/></svg>
              </button>
              {historyOpen && (
                <div className="scrollbar-subtle absolute right-0 bottom-full z-20 mb-1.5 max-h-80 w-72 overflow-y-auto rounded-lg border border-line bg-surface shadow-[0_4px_20px_rgba(51,48,44,.16)]">
                  {history.length === 0 ? (
                    <p className="px-3 py-3 text-[12px] text-ink-muted">No edits yet.</p>
                  ) : (
                    <ul className="flex flex-col divide-y divide-line">
                      {[...history].reverse().map((entry) => (
                        <li key={entry.id}>
                          <button
                            className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left outline-none transition-colors hover:bg-accent-ghost/40 focus-visible:bg-accent-ghost/40"
                            type="button"
                            onClick={() => {
                              nodesRef.current = entry.nodes
                              setNodes(entry.nodes)
                              onNodesChange(entry.nodes, `Restored: ${entry.message}`)
                              setHistoryOpen(false)
                            }}
                          >
                            <span className="text-[12px] font-medium text-ink">{entry.message}</span>
                            <span className="text-[10.5px] text-ink-faint">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* Task 6.2 – message list */}
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
            <div className="shrink-0 flex items-center gap-2 border-t border-line px-3.5 py-2.5">
              <button
                className="cursor-pointer rounded-md border border-accent bg-accent px-3.5 py-1.5 font-sans text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108 disabled:cursor-default disabled:border-line-strong disabled:bg-surface disabled:text-ink-faint"
                type="button"
                disabled={!hasAcceptedChanges}
                title={hasAcceptedChanges ? undefined : 'All changes rejected — nothing to apply'}
                onClick={applyPending}
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
          )}

          {/* Task 6.3 – suggestion chips (hidden while pending / loading) */}
          {/* {activeSuggs.length > 0 && !chatBlocked && (
            <div className="flex shrink-0 flex-wrap gap-1.5 px-3.5 pb-1.5 pt-1">
              {activeSuggs.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className="cursor-pointer rounded-full border border-line-strong bg-surface px-3 py-1 font-sans text-[11px] font-medium text-ink outline-none hover:border-accent/50 hover:text-accent"
                  onClick={() => pickSuggestion(s)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          )} */}

          {/* Task 6.4 – text input */}
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
          {ready && (stale ? (
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-500" />
              Highlights changed — regenerate to update the schema
            </span>
          ) : (
            `${fieldCount} field${fieldCount === 1 ? '' : 's'} `
          ))}
          {state.status === 'idle' && 'Generate to produce the schema from the document'}
          {state.status === 'error' && 'Generation failed'}
        </p>
        {ready && (
          <div className="flex shrink-0 items-center gap-2">
            {annotationCount > 0 && <AnnotationsModeToggle mode={annotationsMode} onChange={onAnnotationsModeChange} />}
            <button className={genBtnCls} type="button" onClick={onGenerate}>Regenerate</button>
          </div>
        )}
      </footer>

      {/* Task 2.6 – drag overlay chip (fixed, follows cursor) */}
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
