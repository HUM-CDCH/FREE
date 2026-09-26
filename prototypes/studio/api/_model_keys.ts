import { randomUUID } from 'node:crypto'
import type { ModelConnection } from '../shared/modelConfig.contract.js'
import { sameModelKeyAddress, type ModelKeyAddress } from '../shared/modelKeys.contract.js'
import { ApiError } from './_http.js'

/** How long a provider attempt waits for a page to resend a missing key before it fails with `model_key_required`. */
export const MODEL_KEY_WAIT_MS = 60_000

type KeyedConnection = Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'>
type Held = ModelKeyAddress & Readonly<{ key: string }>

export class ModelKeyRequiredError extends ApiError {
  /** Only a page resending the key can fix this, so neither the AI SDK nor `durableCalls` (M5) may retry it. */
  readonly isRetryable = false
  constructor() {
    super(
      409,
      'model_key_required',
      'Studio does not hold the key for this Model Connection. Open FREE in a browser where the key is saved, then try again.',
    )
    this.name = 'ModelKeyRequiredError'
  }
}

/** Studio's in-memory copy of the keys pages hand it, per Researcher Account and Model Connection. Never persisted. */
export type ModelKeyCache = {
  put(accountId: string, connectionId: string, address: ModelKeyAddress, key: string): void
  remove(accountId: string, connectionId: string): void
  forgetAccount(accountId: string): void
  /** Keeps only keys whose connection still exists, still has `hasKey`, and still has the key's provider and base. */
  retain(accountId: string, connections: readonly (KeyedConnection & { hasKey: boolean })[]): void
  read(accountId: string, connection: KeyedConnection): string | null
  /** The key, as soon as one for this connection's address is held; `null` after `waitMs`; rejects when `signal` aborts. */
  wait(accountId: string, connection: KeyedConnection, signal: AbortSignal | undefined, waitMs?: number): Promise<string | null>
  clear(): void
}

const slot = (accountId: string, connectionId: string) => `${accountId}\u0000${connectionId}`

export function createModelKeyCache(): ModelKeyCache {
  const held = new Map<string, Held>()
  const waiters = new Map<string, Set<() => void>>()
  const ofAccount = (accountId: string) => [...held.keys()].filter((at) => at.startsWith(`${accountId}\u0000`))
  const cache: ModelKeyCache = {
    put(accountId, connectionId, address, key) {
      const at = slot(accountId, connectionId)
      held.set(at, { provider: address.provider, baseUrl: address.baseUrl, key })
      for (const wake of [...(waiters.get(at) ?? [])]) wake()
    },
    remove(accountId, connectionId) {
      held.delete(slot(accountId, connectionId))
    },
    forgetAccount(accountId) {
      for (const at of ofAccount(accountId)) held.delete(at)
    },
    retain(accountId, connections) {
      const current = new Map(connections.filter(({ hasKey }) => hasKey).map((connection) => [connection.id, connection]))
      for (const at of ofAccount(accountId)) {
        const connection = current.get(at.slice(accountId.length + 1))
        if (!connection || !sameModelKeyAddress(held.get(at)!, connection)) held.delete(at)
      }
    },
    read(accountId, connection) {
      const entry = held.get(slot(accountId, connection.id))
      return entry && sameModelKeyAddress(entry, connection) ? entry.key : null
    },
    async wait(accountId, connection, signal, waitMs = MODEL_KEY_WAIT_MS) {
      signal?.throwIfAborted()
      const ready = cache.read(accountId, connection)
      if (ready !== null) return ready
      const at = slot(accountId, connection.id)
      const { promise, resolve, reject } = Promise.withResolvers<string | null>()
      const wake = () => {
        const key = cache.read(accountId, connection)
        if (key !== null) resolve(key)
      }
      const abort = () => reject(signal!.reason)
      const timer = setTimeout(() => resolve(null), waitMs)
      const wakers = waiters.get(at) ?? new Set<() => void>()
      waiters.set(at, wakers)
      wakers.add(wake)
      signal?.addEventListener('abort', abort, { once: true })
      try {
        return await promise
      } finally {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        wakers.delete(wake)
        if (wakers.size === 0) waiters.delete(at)
      }
    },
    clear() {
      held.clear()
    },
  }
  return cache
}

/**
 * The key for one provider attempt: from the cache, or after waiting up to `waitMs` for a page to resend it. The wait
 * ends early when `signal` aborts, and nothing after it runs. In M4/M5 the caller composes DBOS's
 * `DBOS.stepStatus.cancelSignal` into `signal`.
 */
export async function requireModelKey(
  cache: ModelKeyCache,
  accountId: string,
  connection: KeyedConnection,
  signal: AbortSignal | undefined,
  waitMs = MODEL_KEY_WAIT_MS,
): Promise<string> {
  const key = await cache.wait(accountId, connection, signal, waitMs)
  if (key === null) throw new ModelKeyRequiredError()
  signal?.throwIfAborted()
  return key
}

/**
 * This Studio process's key cache and the boot ID that names it: a page that sees a new boot ID knows the keys it sent
 * are gone and sends them again. One process (decision 2), so one map; it empties when the process exits.
 */
export const studioProcess: Readonly<{ bootId: string; keys: ModelKeyCache }> = {
  bootId: randomUUID(),
  keys: createModelKeyCache(),
}
