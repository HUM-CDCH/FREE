import { useCallback, useEffect, useRef, useState } from 'react'
import { authenticatedFetch } from './auth/authenticatedFetch'
import type { ChatHistory } from '../shared/schemaChat.contract'
import {
  PROJECT_CHAT_APPEND_LIMIT,
  projectChatResponseSchema,
  type ProjectChatEntry,
  type ProjectChatEntryRecord,
} from '../shared/projectChat.contract'

/** The conversation a request's model reads: at most this many characters of the latest messages… */
export const HISTORY_CHARACTER_BUDGET = 24_000
/** …and at most this many messages, well under the server's cap. */
export const HISTORY_MESSAGE_LIMIT = 200
const OMITTED: ChatHistory[number] = { role: 'note', text: 'Earlier messages are left out.' }

/**
 * The latest messages that fit the budget, oldest first. What is left out is said, and the Source Document the first
 * kept message was about stays named: the last document note before the cut goes first.
 */
export function boundedHistory(history: ChatHistory, characters = HISTORY_CHARACTER_BUDGET, messages = HISTORY_MESSAGE_LIMIT): ChatHistory {
  let used = 0
  let start = history.length
  while (start > 0 && history.length - start < messages) {
    const size = history[start - 1]!.text.length
    if (used + size > characters) break
    used += size
    start -= 1
  }
  if (start === 0) return history
  const kept = history.slice(start)
  const document = kept[0]?.role === 'note' ? undefined : history.slice(0, start).findLast(({ role, text }) => role === 'note' && text !== OMITTED.text)
  return [OMITTED, ...(document ? [document] : []), ...kept]
}

const url = (projectContextId: string, entryId?: string) =>
  `/api/project-contexts/${projectContextId}/chat${entryId ? `/${entryId}` : ''}`

async function readProjectChat(projectContextId: string, signal: AbortSignal): Promise<ProjectChatEntryRecord[]> {
  const response = await authenticatedFetch(url(projectContextId), { signal })
  if (!response.ok) throw new Error(`The chat could not be read (HTTP ${response.status}).`)
  return projectChatResponseSchema.parse(await response.json()).entries
}

async function appendProjectChat(projectContextId: string, entries: readonly { projectChatEntryId: string; entry: ProjectChatEntry }[]) {
  const response = await authenticatedFetch(url(projectContextId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries }),
  })
  if (!response.ok) throw new Error(`The chat could not be saved (HTTP ${response.status}).`)
}

async function deleteProjectChatEntry(projectContextId: string, entryId: string) {
  const response = await authenticatedFetch(url(projectContextId, entryId), { method: 'DELETE' })
  // Already gone is what was asked.
  if (!response.ok && response.status !== 404) throw new Error(`The chat entry could not be removed (HTTP ${response.status}).`)
}

export type ProjectChatLog = {
  /** The stored chat when it was read, oldest first; null while it is read, or where there is no project to keep it. */
  readonly loaded: readonly { id: string; entry: ProjectChatEntry }[] | null
  /** Some of the chat could not be saved; it is tried again with the next entry. */
  readonly unsaved: boolean
  /** Keeps entries after everything kept before them, in order; each keeps the ID given. */
  keep(entries: readonly { id: string; entry: ProjectChatEntry }[]): void
  remove(id: string): void
}

/**
 * A Project Context's stored chat: read once, then appended to in the order things are said. Writes go one after
 * another, so the stored order is the order kept here; one that fails stays queued and goes again with the next, its
 * IDs making a repeat harmless.
 */
export function useProjectChatLog(projectContextId: string | null): ProjectChatLog {
  const [loaded, setLoaded] = useState<ProjectChatLog['loaded']>(null)
  const [unsaved, setUnsaved] = useState(false)
  const queue = useRef<{ id: string; entry: ProjectChatEntry }[]>([])
  const writing = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    if (!projectContextId) return
    const controller = new AbortController()
    readProjectChat(projectContextId, controller.signal)
      .then((records) => setLoaded(records.map(({ projectChatEntryId, entry }) => ({ id: projectChatEntryId, entry }))))
      // An unreadable chat starts empty here; what is said now is still kept.
      .catch(() => { if (!controller.signal.aborted) setLoaded([]) })
    return () => controller.abort()
  }, [projectContextId])

  const flush = useCallback(() => {
    if (!projectContextId) return
    writing.current = writing.current.then(async () => {
      while (queue.current.length > 0) {
        // Out of the queue while it is sent: a removal meanwhile waits for it, then deletes what it stored.
        const batch = queue.current.splice(0, PROJECT_CHAT_APPEND_LIMIT)
        try {
          await appendProjectChat(projectContextId, batch.map(({ id, entry }) => ({ projectChatEntryId: id, entry })))
        } catch {
          queue.current.unshift(...batch)
          setUnsaved(true)
          return
        }
      }
      setUnsaved(false)
    })
  }, [projectContextId])

  const keep = useCallback((entries: readonly { id: string; entry: ProjectChatEntry }[]) => {
    if (!projectContextId || entries.length === 0) return
    queue.current.push(...entries)
    flush()
  }, [flush, projectContextId])

  const remove = useCallback((id: string) => {
    if (!projectContextId) return
    // Not yet sent: it never will be. Otherwise after every write before it, so the entry exists to remove.
    const queued = queue.current.length
    queue.current = queue.current.filter((item) => item.id !== id)
    if (queue.current.length !== queued) return
    writing.current = writing.current.then(() => deleteProjectChatEntry(projectContextId, id).catch(() => setUnsaved(true)))
  }, [projectContextId])

  return { loaded: projectContextId ? loaded : null, unsaved, keep, remove }
}
