import { mkId, type SchemaNode } from './schemaNode'

// No persistence layer exists yet (see CLAUDE.md), so schema history lives in
// sessionStorage: it survives reloads within the tab but is gone once the tab
// closes, and never leaves the browser.

export type SchemaHistoryEntry = {
  readonly id: string
  readonly timestamp: number
  readonly message: string
  readonly nodes: SchemaNode[]
}

const STORAGE_KEY = 'free.schemaHistory'
const MAX_ENTRIES = 100

export function loadSchemaHistory(): SchemaHistoryEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as SchemaHistoryEntry[]) : []
  } catch {
    return []
  }
}

function saveSchemaHistory(entries: SchemaHistoryEntry[]): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // sessionStorage unavailable or over quota — history just won't survive a reload.
  }
}

export function appendSchemaHistoryEntry(
  current: readonly SchemaHistoryEntry[],
  nodes: SchemaNode[],
  message: string,
): SchemaHistoryEntry[] {
  const entry: SchemaHistoryEntry = { id: mkId(), timestamp: Date.now(), message, nodes }
  const next = [...current, entry].slice(-MAX_ENTRIES)
  saveSchemaHistory(next)
  return next
}

export function clearSchemaHistory(): SchemaHistoryEntry[] {
  saveSchemaHistory([])
  return []
}

export function collectIds(nodes: SchemaNode[], out = new Map<string, SchemaNode>()): Map<string, SchemaNode> {
  for (const n of nodes) {
    out.set(n.id, n)
    if (n.children) collectIds(n.children, out)
  }
  return out
}

// Builds a human-readable summary of what actually changed between two node
// trees (by id), so schema history entries describe the edit instead of a
// generic label. Callers prepend their own icon (e.g. '✎ ', '✦ ') to indicate
// the edit's source (manual vs. chat).
export function summarizeSchemaChange(oldNodes: SchemaNode[], newNodes: SchemaNode[]): string {
  const oldById = collectIds(oldNodes)
  const newById = collectIds(newNodes)
  let added = 0
  let renamed = 0
  let retyped = 0
  let described = 0

  for (const [id, newNode] of newById) {
    const oldNode = oldById.get(id)
    if (!oldNode) {
      added++
      continue
    }
    if (oldNode.name !== newNode.name) renamed++
    if (oldNode.type !== newNode.type) retyped++
    if (oldNode.description !== newNode.description) described++
  }
  let removed = 0
  for (const id of oldById.keys()) {
    if (!newById.has(id)) removed++
  }

  const parts: string[] = []
  if (added) parts.push(`${added} added`)
  if (removed) parts.push(`${removed} removed`)
  if (renamed) parts.push(`${renamed} renamed`)
  if (retyped) parts.push(`${retyped} retyped`)
  if (described) parts.push(`${described} description${described !== 1 ? 's' : ''} updated`)

  return parts.length ? parts.join(', ') : 'Schema updated (no field changes)'
}
