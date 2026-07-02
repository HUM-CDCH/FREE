import { useEffect, useRef, useState } from 'react'
import type { AnnotationsMode } from './api'
import { requestSchema } from './api'
import { FIELD_TYPES, countTemplateFields, isRecord } from './template'

// ────────────────────────────────────────────────────────────────────────────
// Exported types (App.tsx depends on TemplateState)
// ────────────────────────────────────────────────────────────────────────────

export type TemplateState =
  | { status: 'idle' }
  | { status: 'generating' }
  | { status: 'ready'; template: unknown; inputsKey: string; edited?: boolean }
  | { status: 'error'; message: string }

// ────────────────────────────────────────────────────────────────────────────
// Internal types
// ────────────────────────────────────────────────────────────────────────────

type SchemaPanelProps = {
  state: TemplateState
  stale: boolean
  onGenerate: () => void
  onTemplateChange: (template: unknown, message: string) => void
  annotationCount: number
  annotationsMode: AnnotationsMode
  onAnnotationsModeChange: (mode: AnnotationsMode) => void
  documentMarkdown?: string | null
}

type SchemaNode = {
  id: string
  name: string
  type: string
  children?: SchemaNode[]
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

type DiffLine = { sign: '+' | '−' | '~'; text: string }

type PendingChange = { newTemplate: unknown; newNodes: SchemaNode[]; lines: DiffLine[] }

// ────────────────────────────────────────────────────────────────────────────
// Task 1.1–1.4: Data model & converters
// ────────────────────────────────────────────────────────────────────────────

let _uid = 1
const mkId = () => `n${_uid++}`

function templateToNodes(v: unknown): SchemaNode[] {
  if (!isRecord(v)) return []
  return Object.entries(v).map(([name, child]) => {
    if (Array.isArray(child)) {
      const first = child[0]
      if (isRecord(first)) return { id: mkId(), name, type: 'array', children: templateToNodes(first) }
      return { id: mkId(), name, type: String(first ?? 'string') }
    }
    if (isRecord(child)) return { id: mkId(), name, type: 'object', children: templateToNodes(child) }
    return { id: mkId(), name, type: String(child) }
  })
}

function nodesToTemplate(nodes: SchemaNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const n of nodes) {
    if (n.children !== undefined) {
      out[n.name] = n.type === 'array' ? [nodesToTemplate(n.children)] : nodesToTemplate(n.children)
    } else {
      out[n.name] = n.type
    }
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Diff computation (task 7.3)
// ────────────────────────────────────────────────────────────────────────────

function flattenNodes(nodes: SchemaNode[], prefix = ''): Map<string, string> {
  const m = new Map<string, string>()
  for (const n of nodes) {
    const k = prefix ? `${prefix} › ${n.name}` : n.name
    m.set(k, n.type)
    if (n.children) for (const [ck, cv] of flattenNodes(n.children, k)) m.set(ck, cv)
  }
  return m
}

function computeDiff(oldNodes: SchemaNode[], newNodes: SchemaNode[]): DiffLine[] {
  const a = flattenNodes(oldNodes)
  const b = flattenNodes(newNodes)
  const lines: DiffLine[] = []
  for (const [k, t] of b) {
    if (!a.has(k)) lines.push({ sign: '+', text: `${k} : ${t}` })
    else if (a.get(k) !== t) lines.push({ sign: '~', text: `${k} : ${a.get(k)} → ${t}` })
  }
  for (const k of a.keys()) if (!b.has(k)) lines.push({ sign: '−', text: k })
  return lines
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

// Right drag: move node into the previous sibling (one level deeper)
function indentNode(nodes: SchemaNode[], id: string, parentId: string | null): SchemaNode[] {
  const findSiblings = (arr: SchemaNode[]): SchemaNode[] | null => {
    for (const n of arr) {
      if (n.id === parentId) return n.children ?? null
      if (n.children) { const r = findSiblings(n.children); if (r) return r }
    }
    return null
  }
  const siblings = parentId === null ? nodes : (findSiblings(nodes) ?? nodes)
  const idx = siblings.findIndex(n => n.id === id)
  if (idx <= 0) return nodes
  const [moved, without] = extractNode(nodes, id)
  if (!moved) return nodes
  return insertIntoNode(without, siblings[idx - 1].id, moved)
}

// Left drag: move node out of its parent, insert after parent (one level shallower)
function outdentNode(nodes: SchemaNode[], id: string, parentId: string): SchemaNode[] {
  const [moved, without] = extractNode(nodes, id)
  if (!moved) return nodes
  const rootIdx = without.findIndex(n => n.id === parentId)
  if (rootIdx !== -1) {
    const out = [...without]; out.splice(rootIdx + 1, 0, moved); return out
  }
  const insertAfter = (arr: SchemaNode[]): SchemaNode[] | null => {
    for (let i = 0; i < arr.length; i++) {
      if (!arr[i].children) continue
      const ci = arr[i].children!.findIndex(c => c.id === parentId)
      if (ci !== -1) {
        const ch = [...arr[i].children!]; ch.splice(ci + 1, 0, moved)
        const out = [...arr]; out[i] = { ...arr[i], children: ch }; return out
      }
      const deeper = insertAfter(arr[i].children!)
      if (deeper) { const out = [...arr]; out[i] = { ...arr[i], children: deeper }; return out }
    }
    return null
  }
  return insertAfter(without) ?? without
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
  const opts: string[] = [...FIELD_TYPES]
  if (!opts.includes(editing.type)) opts.unshift(editing.type)
  return (
    <div className="my-0.5 flex flex-col gap-1.5 rounded-lg border border-accent bg-accent-ghost px-2.5 py-2">
      <input
        className="min-w-0 rounded-md border border-line-strong bg-surface px-2 py-1 font-mono text-xs font-semibold text-ink outline-none focus-visible:border-accent"
        value={editing.name}
        placeholder="field_name"
        autoFocus
        onChange={e => onChange({ ...editing, name: e.target.value })}
        onKeyDown={e => { if (e.key === 'Enter') onSave(); if (e.key === 'Escape') onCancel() }}
      />
      <div className="flex items-center gap-1.5">
        <select
          className="min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-1.5 py-1 font-mono text-[11px] text-ink outline-none focus-visible:border-accent"
          value={editing.type}
          onChange={e => onChange({ ...editing, type: e.target.value })}
        >
          {opts.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <button className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-2.5 py-1 text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108" type="button" onClick={onSave}>Save</button>
        <button className="shrink-0 cursor-pointer rounded-md border border-line-strong bg-surface px-2 py-1 text-[11.5px] font-semibold text-ink-muted outline-none hover:text-accent" type="button" onClick={onCancel}>✕</button>
      </div>
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
  onTemplateChange,
  annotationCount,
  annotationsMode,
  onAnnotationsModeChange,
  documentMarkdown,
}: SchemaPanelProps) {
  // ── render state ──
  const [nodes, setNodes] = useState<SchemaNode[]>([])
  const [dragging, setDragging] = useState<DragState | null>(null)
  const [dragX, setDragX] = useState(0)
  const [dragY, setDragY] = useState(0)
  const [overTarget, setOverTarget] = useState<DropTarget | null>(null)
  const [editing, setEditing] = useState<FieldEditing | null>(null)
  const [chat, setChat] = useState<ChatMsg[]>([
    { role: 'assistant', text: "Edit fields by hand, or describe a change — I'll show a diff to review first." },
  ])
  const [pending, setPending] = useState<PendingChange | null>(null)
  const [usedSuggs, setUsedSuggs] = useState<string[]>([])
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [view, setView] = useState<'fields' | 'json'>('fields')
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())

  // ── refs for event handlers (avoid stale closures) ──
  const nodesRef = useRef<SchemaNode[]>([])
  const draggingRef = useRef<DragState | null>(null)
  const overTargetRef = useRef<DropTarget | null>(null)
  const dragYRef = useRef(0)
  const dragXRef = useRef(0)
  const dragStartXRef = useRef(0)
  const rafRef = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const onTemplateChangeRef = useRef(onTemplateChange)
  onTemplateChangeRef.current = onTemplateChange

  const ready = state.status === 'ready'
  const fieldCount = ready ? countTemplateFields(state.template) : 0
  const inputsKey = state.status === 'ready' ? state.inputsKey : null
  const dx = dragging ? dragX - dragStartXRef.current : 0
  const dragMode = dx > INDENT_THRESHOLD ? 'indent' : dx < -INDENT_THRESHOLD ? 'outdent' : 'normal'

  // Task 1.2 / 1.3 – sync nodes when a new schema is generated
  useEffect(() => {
    if (state.status === 'ready') {
      const n = templateToNodes(state.template)
      setNodes(n)
      nodesRef.current = n
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

    if (dx > INDENT_THRESHOLD) {
      const finalNodes = indentNode(cur, drag.id, drag.parentId)
      if (finalNodes !== cur) {
        nodesRef.current = finalNodes
        setNodes(finalNodes)
        onTemplateChangeRef.current(nodesToTemplate(finalNodes), '⠿ Schema reordered')
      }
      return
    }

    if (dx < -INDENT_THRESHOLD && drag.parentId !== null) {
      const finalNodes = outdentNode(cur, drag.id, drag.parentId)
      nodesRef.current = finalNodes
      setNodes(finalNodes)
      onTemplateChangeRef.current(nodesToTemplate(finalNodes), '⠿ Schema reordered')
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
      onTemplateChangeRef.current(nodesToTemplate(finalNodes), '⠿ Schema reordered')
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
      onTemplateChangeRef.current(nodesToTemplate(finalNodes), '⠿ Schema reordered')
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const name = editing.name.trim().toLowerCase().replace(/\s+/g, '_') || 'field'
    const newNodes = nodesRef.current.map(n => {
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
    onTemplateChange(nodesToTemplate(newNodes), '✎ Schema updated')
    setEditing(null)
  }

  function removeNode(id: string) {
    const [, newNodes] = extractNode(nodesRef.current, id)
    nodesRef.current = newNodes
    setNodes(newNodes)
    onTemplateChange(nodesToTemplate(newNodes), 'Field removed from schema')
    if (editing?.id === id) setEditing(null)
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
    onTemplateChange(nodesToTemplate(newNodes), '✎ Schema updated')
    setView('fields')
    setEditing({ id, name, type: 'verbatim-string' })
  }

  // ── Tasks 6–8: chat ──
  const SUGGESTIONS = [
    { id: 's1', label: 'Add a field', prompt: 'Add one new relevant field to this schema.' },
    { id: 's2', label: 'Remove a field', prompt: 'Remove the least important field from this schema.' },
    { id: 's3', label: 'Change a field type', prompt: 'Find a field whose type seems wrong and correct it.' },
  ]

  async function sendChatMessage(text: string) {
    if (!text.trim() || chatLoading || pending) return
    const userMsg = text.trim()
    setChat(c => [...c, { role: 'user', text: userMsg }])
    setChatInput('')
    setChatLoading(true)

    try {
      const currentTemplate = nodesToTemplate(nodesRef.current)
      // Task 7.2 – call /api/generate_schema with current template as context
      const newTemplate = await requestSchema(
        new Blob([''], { type: 'text/plain' }),
        'schema.txt',
        undefined,
        {
          markdown: documentMarkdown ?? `Existing schema:\n${JSON.stringify(currentTemplate, null, 2)}`,
          annotations: [{
            text: `Current schema:\n${JSON.stringify(currentTemplate, null, 2)}\n\nResearcher request: ${userMsg}`,
            pageNumber: 1,
          }],
          annotationsMode: 'hints',
        },
      )
      // Task 7.3 – compute diff
      const newNodes = templateToNodes(newTemplate)
      const lines = computeDiff(nodesRef.current, newNodes)
      if (lines.length === 0) {
        setChat(c => [...c, { role: 'assistant', text: 'No changes needed — the schema already matches your request.' }])
      } else {
        // Task 7.4 – set pending
        setPending({ newTemplate, newNodes, lines })
      }
    } catch (err) {
      setChat(c => [...c, { role: 'assistant', text: `Error: ${err instanceof Error ? err.message : 'Request failed'}` }])
    } finally {
      setChatLoading(false)
    }
  }

  // Task 8.2 – apply pending
  function applyPending() {
    if (!pending) return
    nodesRef.current = pending.newNodes
    setNodes(pending.newNodes)
    onTemplateChange(pending.newTemplate, '✦ Schema updated via chat')
    setChat(c => [...c, { role: 'assistant', text: `✓ Applied ${pending.lines.length} change${pending.lines.length === 1 ? '' : 's'}.` }])
    setPending(null)
  }

  // Task 8.3 – discard
  function discardPending() {
    setChat(c => [...c, { role: 'assistant', text: 'Okay — discarded, no changes made.' }])
    setPending(null)
  }

  function pickSuggestion(s: (typeof SUGGESTIONS)[number]) {
    setUsedSuggs(u => [...u, s.id])
    void sendChatMessage(s.prompt)
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

  const signCls = (sign: '+' | '−' | '~') => ({
    '+': 'w-3.5 text-center font-mono font-bold text-[13px] text-green shrink-0',
    '−': 'w-3.5 text-center font-mono font-bold text-[13px] text-danger shrink-0',
    '~': 'w-3.5 text-center font-mono font-bold text-[13px] text-stale shrink-0',
  }[sign])

  // Task 5.3 – disable edit buttons while dragging
  const editDisabled = !!dragging

  // Task 8.4 – disable chat input while pending
  const chatBlocked = !!pending || chatLoading

  const activeSuggs = SUGGESTIONS.filter(s => !usedSuggs.includes(s.id))

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

    return (
      <div key={node.id}>
        {/* Task 2.4 – drop slot before this field */}
        <div className={slotCls(null, i)} onMouseEnter={() => setSlotTarget(null, i)} />

        {isEditing && editing ? (
          <FieldEditForm editing={editing} onChange={setEditing} onSave={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <>
            {/* Task 2.3 / 3.1 – field row with drag handle and group hover */}
            <div
              className={rowCls(node.id, intoGroup, isDragging)}
              onMouseEnter={() => setGroupTarget(node.id, node.name)}
              onMouseLeave={() => clearGroupTarget(node.id)}
            >
              <span
                className="shrink-0 cursor-grab select-none px-0.5 text-sm leading-none text-ink-faint"
                onMouseDown={e => startDrag(e, node.id, null, node.name, isGroup)}
              >
                ⠿
              </span>
              <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-ink">{node.name}</span>
              {/* Task 3.3 – "into [group]" badge */}
              {intoGroup && (
                <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white whitespace-nowrap">
                  into {node.name}
                </span>
              )}
              <span className="min-w-0 flex-1" />
              {/* {isGroup ? (
                <span className="shrink-0 font-sans text-[9px] font-semibold uppercase tracking-[0.06em] text-ink-faint">{node.type}</span>
              ) : (
                <span className="shrink-0 rounded-full bg-surface-muted px-2 py-0.5 font-mono text-[10px] font-medium leading-none text-ink-muted">{node.type}</span>
              )} */}
              <button
                className="shrink-0 cursor-pointer px-1 text-[11px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent disabled:opacity-40"
                type="button"
                title={`Edit ${node.name}`}
                disabled={editDisabled}
                onClick={() => setEditing({ id: node.id, name: node.name, type: node.type })}
              >
                ✎
              </button>
              <button
                className="shrink-0 cursor-pointer px-1 text-[10px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent"
                type="button"
                title={`Remove ${node.name}`}
                onClick={() => removeNode(node.id)}
              >
                ✕
              </button>
            </div>

            {/* Nested children area */}
            {isGroup && (
              <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
                {(node.children ?? []).map((child, j) => renderChildField(child, node.id, j))}
                {/* End slot for the group */}
                <div
                  className={slotCls(node.id, (node.children ?? []).length)}
                  onMouseEnter={() => setSlotTarget(node.id, (node.children ?? []).length)}
                />
                {/* Task 3.5 – empty group placeholder during drag */}
                {/* {(node.children ?? []).length === 0 && dragging && (
                  <div className="rounded-lg border-[1.5px] border-dashed border-line-strong px-3 py-2 text-center font-sans text-[11px] text-ink-faint">
                    drag a field in here
                  </div>
                )} */}
              </div>
            )}
          </>
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

    const toggleExpand = (e: React.MouseEvent) => {
      e.stopPropagation()
      setExpandedIds(s => { const ns = new Set(s); ns.has(child.id) ? ns.delete(child.id) : ns.add(child.id); return ns })
    }

    return (
      <div
        key={child.id}
        onMouseEnter={() => setGroupTarget(child.id, child.name)}
        onMouseLeave={() => clearGroupTarget(child.id)}
      >
        <div className={slotCls(parentId, j)} onMouseEnter={e => { e.stopPropagation(); setSlotTarget(parentId, j) }} />
        {isEditing && editing ? (
          <FieldEditForm editing={editing} onChange={setEditing} onSave={saveEdit} onCancel={() => setEditing(null)} />
        ) : (
          <>
            <div
              className={`-mx-2 flex items-center gap-2 rounded-md px-2 py-1.5 border transition-opacity duration-100 ${intoGroup ? 'border-accent/40 bg-accent-soft' : 'border-transparent'} ${isDragging ? 'opacity-40' : ''}`}
            >
              <span
                className="shrink-0 cursor-grab select-none px-0.5 text-[13px] leading-none text-ink-faint"
                onMouseDown={e => startDrag(e, child.id, parentId, child.name, isGroup)}
              >
                ⠿
              </span>
              <span className="min-w-0 truncate font-mono text-[12.5px] font-medium text-ink-muted">{child.name}</span>
              {isGroup && (
                <span
                  className="shrink-0 flex items-center text-ink-faint hover:text-accent cursor-pointer transition-colors"
                  onClick={toggleExpand}
                >
                  <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}>
                    <polygon points="0,0 8,4 0,8" />
                  </svg>
                </span>
              )}
              {intoGroup && (
                <span className="shrink-0 rounded-full bg-accent px-2.5 py-0.5 font-sans text-[10px] font-semibold tracking-wide text-white whitespace-nowrap">
                  into {child.name}
                </span>
              )}
              <span className="min-w-0 flex-1" />
              <button
                className="shrink-0 cursor-pointer px-1 text-[11px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent disabled:opacity-40"
                type="button"
                title={`Edit ${child.name}`}
                disabled={editDisabled}
                onClick={() => setEditing({ id: child.id, name: child.name, type: child.type })}
              >
                ✎
              </button>
              <button
                className="shrink-0 cursor-pointer px-1 text-[10px] leading-none text-ink-faint outline-none transition-colors hover:text-accent focus-visible:text-accent"
                type="button"
                title={`Remove ${child.name}`}
                onClick={() => removeNode(child.id)}
              >
                ✕
              </button>
            </div>
            {isGroup && isExpanded && (
              <div className="ml-3.5 mt-0.5 border-l border-line pl-3">
                {(child.children ?? []).map((grandchild, k) => renderChildField(grandchild, child.id, k))}
                <div
                  className={slotCls(child.id, (child.children ?? []).length)}
                  onMouseEnter={() => setSlotTarget(child.id, (child.children ?? []).length)}
                />
                {/* {(child.children ?? []).length === 0 && dragging && (
                  <div className="rounded-lg border-[1.5px] border-dashed border-line-strong px-3 py-2 text-center font-sans text-[11px] text-ink-faint">
                    drag a field in here
                  </div>
                )} */}
              </div>
            )}
          </>
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
          <h2 className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-ink-muted">Extraction Schema</h2>
          <p className="truncate font-mono text-xs font-medium text-ink">Beretning_Ellekilde_8_13.pdf</p>
        </div>
        {ready && (
          <div className="flex shrink-0 overflow-hidden rounded-md border border-line">
            <button className={tabCls(view === 'fields')} type="button" aria-pressed={view === 'fields'} onClick={() => setView('fields')}>Fields</button>
            <button className={`${tabCls(view === 'json')} font-mono`} type="button" aria-pressed={view === 'json'} onClick={() => setView('json')}>{'JSON'}</button>
          </div>
        )}
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
          <pre className="overflow-x-auto whitespace-pre rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed text-ink">
            {JSON.stringify(nodesToTemplate(nodes), null, 2)}
          </pre>
        )}

        {ready && view === 'fields' && (
          <>
            <div className="flex flex-col">
              {nodes.map((node, i) => renderRootField(node, i))}
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
              {/* Task 8.1 – pending diff card */}
              {pending && (
                <div className="self-stretch overflow-hidden rounded-[11px_11px_11px_3px] border border-accent-soft bg-surface">
                  <div className="flex items-center gap-1.5 border-b border-line px-3 py-2">
                    <span className="font-sans text-[9.5px] font-bold uppercase tracking-[0.1em] text-ink-muted">Proposed changes</span>
                    <span className="font-sans text-[10px] text-ink-faint">— review before applying</span>
                  </div>
                  <ul className="flex flex-col gap-1.5 px-3 py-2">
                    {pending.lines.map((line, i) => (
                      <li key={i} className="flex items-baseline gap-2">
                        <span className={signCls(line.sign)}>{line.sign}</span>
                        <span className="font-mono text-[11px] font-medium leading-snug text-ink">{line.text}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex gap-2 px-3 pb-2.5">
                    <button
                      className="cursor-pointer rounded-md border border-accent bg-accent px-3.5 py-1.5 font-sans text-[11.5px] font-bold text-white outline-none transition-[filter] hover:brightness-108"
                      type="button"
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
                </div>
              )}
            </div>
          </div>

          {/* Task 6.3 – suggestion chips (hidden while pending / loading) */}
          {activeSuggs.length > 0 && !chatBlocked && (
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
          )}

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
              <button
                type="button"
                className="grid size-6 shrink-0 cursor-pointer place-items-center rounded-md bg-accent text-xs text-white outline-none hover:brightness-108 disabled:opacity-40"
                disabled={!chatInput.trim() || chatBlocked}
                onClick={() => void sendChatMessage(chatInput)}
              >
                ↑
              </button>
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
            `${fieldCount} field${fieldCount === 1 ? '' : 's'} }`
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
