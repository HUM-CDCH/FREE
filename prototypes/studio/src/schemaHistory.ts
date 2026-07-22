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
