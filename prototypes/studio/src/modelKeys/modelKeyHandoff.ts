import { authenticatedFetch } from '../auth/authenticatedFetch'
import { storedModelKeys } from './modelKeyStore'

const pendingRemovals = new Map<string, Set<string>>()
let running: Promise<void> | null = null
let queued: Promise<void> | null = null

function queueRemovals(accountId: string, removed: Iterable<string>): void {
  const removals = pendingRemovals.get(accountId) ?? new Set<string>()
  for (const id of removed) removals.add(id)
  if (removals.size > 0) pendingRemovals.set(accountId, removals)
}

/**
 * Hands this browser's keys for `accountId` to Studio (`PUT /api/model-keys`), with `null` for each removed key.
 * Best effort: resolves even when Studio is unreachable or refuses, and keeps the removals for the next call. A call
 * made while one runs sends once more after it (concurrent callers share that follow-up), so the newest state always
 * arrives.
 */
export function sendModelKeys(accountId: string, removed: readonly string[] = []): Promise<void> {
  queueRemovals(accountId, removed)
  if (!running) {
    running = put(accountId).finally(() => {
      running = null
    })
    return running
  }
  queued ??= running.then(() => {
    queued = null
    return sendModelKeys(accountId)
  })
  return queued
}

async function put(accountId: string): Promise<void> {
  const removals = [...(pendingRemovals.get(accountId) ?? [])]
  pendingRemovals.delete(accountId)
  const keys: Record<string, ReturnType<typeof storedModelKeys>[string] | null> = Object.fromEntries(
    removals.map((id) => [id, null]),
  )
  for (const [id, entry] of Object.entries(storedModelKeys(accountId))) keys[id] = entry
  if (Object.keys(keys).length === 0) return
  try {
    const response = await authenticatedFetch('/api/model-keys', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: accountId, keys }),
    })
    if (!response.ok) queueRemovals(accountId, removals)
  } catch {
    queueRemovals(accountId, removals)
  }
}
