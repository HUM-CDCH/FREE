import { z } from 'zod'
import type { ModelConnection } from '../../shared/modelConfig.contract'
import { modelKeyEntrySchema, sameModelKeyAddress } from '../../shared/modelKeys.contract'

/**
 * This browser's keys for one Researcher Account, each bound to a connection's ID, provider and API base. A key is
 * never offered for another base. Accounts sharing one browser profile share its storage; the namespace keeps them
 * apart for the app, not against a script (the CSP is that defence). Entries have the shape `PUT /api/model-keys`
 * accepts, so the handoff sends them as stored.
 */
const PREFIX = 'free.modelKeys.v1:'
const storedSchema = z.record(z.string(), modelKeyEntrySchema)
type StoredModelKeys = z.infer<typeof storedSchema>
type Addressed = Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'>

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function read(accountId: string): StoredModelKeys {
  try {
    const parsed = storedSchema.safeParse(JSON.parse(storage()?.getItem(PREFIX + accountId) ?? '{}'))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

function write(accountId: string, keys: StoredModelKeys): void {
  try {
    if (Object.keys(keys).length === 0) storage()?.removeItem(PREFIX + accountId)
    else storage()?.setItem(PREFIX + accountId, JSON.stringify(keys))
  } catch {
    // Storage is optional; the page then simply holds no keys.
  }
}

export function storedModelKeys(accountId: string): StoredModelKeys {
  return read(accountId)
}

export function modelKeyFor(accountId: string, connection: Addressed): string | null {
  const entry = read(accountId)[connection.id]
  return entry && sameModelKeyAddress(entry, connection) ? entry.key : null
}

export function saveModelKey(accountId: string, connection: Addressed, key: string): void {
  write(accountId, {
    ...read(accountId),
    [connection.id]: { provider: connection.provider, baseUrl: connection.baseUrl, key },
  })
}

export function removeModelKey(accountId: string, connectionId: string): void {
  const keys = read(accountId)
  delete keys[connectionId]
  write(accountId, keys)
}

/** Drops the keys of connections that are gone, re-addressed or keyless, and returns their IDs. */
export function retainModelKeys(
  accountId: string,
  connections: readonly (Addressed & { hasKey: boolean })[],
): string[] {
  const current = new Map(connections.filter(({ hasKey }) => hasKey).map((connection) => [connection.id, connection]))
  const keys = read(accountId)
  const dropped = Object.entries(keys)
    .filter(([id, entry]) => {
      const connection = current.get(id)
      return !connection || !sameModelKeyAddress(entry, connection)
    })
    .map(([id]) => id)
  for (const id of dropped) delete keys[id]
  write(accountId, keys)
  return dropped
}

export function clearModelKeys(accountId: string): void {
  write(accountId, {})
}
