import { randomUUID } from 'node:crypto'
import { DBOS } from '@dbos-inc/dbos-sdk'
import type { ModelConnection } from '../shared/modelConfig.contract.js'
import { sameModelKeyAddress, type ModelKeyAddress } from '../shared/modelKeys.contract.js'
import { ApiError } from './_http.js'

/** How long a provider attempt waits for a page to resend a missing key before it fails with `model_key_required`. */
export const MODEL_KEY_WAIT_MS = 60_000

type KeyedConnection = Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'>
type Held = ModelKeyAddress & Readonly<{ key: string }>

export class ModelKeyRequiredError extends ApiError {
  /** Only a page resending the key can fix this, so neither the AI SDK nor a DBOS step may retry it. */
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

/** One `PUT /api/model-keys` request's writes for its account. */
export type ModelKeyHandoff = {
  /** Stores the key unless the account signed out since the handoff began; says whether it did. */
  put(connectionId: string, address: ModelKeyAddress, key: string): boolean
  remove(connectionId: string): void
}

/** Studio's in-memory copy of the keys pages hand it, per Researcher Account and Model Connection. Never persisted. */
export type ModelKeyCache = {
  put(accountId: string, connectionId: string, address: ModelKeyAddress, key: string): void
  remove(accountId: string, connectionId: string): void
  /** Sign-out: drops the account's keys and voids every handoff of the account begun before it. */
  forgetAccount(accountId: string): void
  /**
   * Begins a handoff. A handoff still reading the configuration when its account signs out would otherwise put the
   * keys back after the eviction, so its `put` stores nothing once `forgetAccount` has run for the account.
   */
  handoff(accountId: string): ModelKeyHandoff
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
  const signOuts = new Map<string, number>()
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
      signOuts.set(accountId, (signOuts.get(accountId) ?? 0) + 1)
    },
    handoff(accountId) {
      const began = signOuts.get(accountId) ?? 0
      return {
        put(connectionId, address, key) {
          if ((signOuts.get(accountId) ?? 0) !== began) return false
          cache.put(accountId, connectionId, address, key)
          return true
        },
        remove(connectionId) {
          cache.remove(accountId, connectionId)
        },
      }
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
 * The provider attempt's signal with DBOS's `cancelSignal` added when the attempt runs inside a step, so a cancelled
 * workflow ends a key wait or a provider call about 1 s later (spec, *Cancellation → Studio model calls*). It is
 * composed here, at the model boundary, so every attempt carries it — the AI SDK's retries, NuExtract's own fetch,
 * keyed and keyless connections — whatever the caller passed. Outside a step it returns `signal` unchanged.
 */
export function withStepCancellation(
  signal: AbortSignal | undefined,
  cancel: AbortSignal | undefined = DBOS.stepStatus?.cancelSignal,
): AbortSignal | undefined {
  if (!cancel || cancel === signal) return signal
  return signal ? AbortSignal.any([signal, cancel]) : cancel
}

/**
 * The key for one provider attempt: from the cache, or after waiting up to `waitMs` for a page to resend it. The wait
 * ends early when `signal` aborts or, inside a DBOS step, when the workflow is cancelled; nothing after either runs.
 */
export async function requireModelKey(
  cache: ModelKeyCache,
  accountId: string,
  connection: KeyedConnection,
  signal: AbortSignal | undefined,
  waitMs = MODEL_KEY_WAIT_MS,
): Promise<string> {
  const bounded = withStepCancellation(signal)
  const key = await cache.wait(accountId, connection, bounded, waitMs)
  if (key === null) throw new ModelKeyRequiredError()
  bounded?.throwIfAborted()
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
