const RECOVERY_KINDS = [
  'extraction-review',
  'schema-draft',
  'batch-schema-draft',
] as const

export type SessionRecoveryKind = (typeof RECOVERY_KINDS)[number]

type RecoveryEntry = {
  kind: SessionRecoveryKind
  resourceId: string
  value: unknown
}

type RecoveryEnvelope = {
  version: 1
  accountId: string
  capturedAt: number
  entries: RecoveryEntry[]
}

const STORAGE_KEY = 'free.auth.recovery.v1'
const SIGNED_OUT_KEY = 'free.auth.signed-out'
const MAX_AGE_MILLISECONDS = 30 * 60 * 1000
const MAX_ENTRY_COUNT = 10
const MAX_SERIALIZED_BYTES = 1024 * 1024
const kinds = new Set<SessionRecoveryKind>(RECOVERY_KINDS)
const captures = new Map<string, () => RecoveryEntry | null>()

let currentAccountId: string | null = null
let authenticationRedirecting = false

function storage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

function removeStoredRecovery(store: Storage | null): void {
  try {
    store?.removeItem(STORAGE_KEY)
  } catch {
    // Storage is optional; authentication must still proceed when unavailable.
  }
}

function isEntry(value: unknown): value is RecoveryEntry {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RecoveryEntry>
  return (
    typeof candidate.kind === 'string' &&
    kinds.has(candidate.kind as SessionRecoveryKind) &&
    typeof candidate.resourceId === 'string' &&
    candidate.resourceId.length > 0 &&
    candidate.resourceId.length <= 512 &&
    'value' in candidate
  )
}

function readEnvelope(store: Storage | null): RecoveryEnvelope | null {
  let parsed: unknown
  try {
    const serialized = store?.getItem(STORAGE_KEY)
    if (!serialized) return null
    parsed = JSON.parse(serialized)
  } catch {
    removeStoredRecovery(store)
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    removeStoredRecovery(store)
    return null
  }
  const candidate = parsed as Partial<RecoveryEnvelope>
  const age = Date.now() - Number(candidate.capturedAt)
  if (
    candidate.version !== 1 ||
    typeof candidate.accountId !== 'string' ||
    candidate.accountId.length === 0 ||
    !Number.isSafeInteger(candidate.capturedAt) ||
    age < 0 ||
    age > MAX_AGE_MILLISECONDS ||
    !Array.isArray(candidate.entries) ||
    candidate.entries.length > MAX_ENTRY_COUNT ||
    !candidate.entries.every(isEntry)
  ) {
    removeStoredRecovery(store)
    return null
  }
  return candidate as RecoveryEnvelope
}

function writeEnvelope(store: Storage | null, envelope: RecoveryEnvelope): void {
  try {
    const serialized = JSON.stringify(envelope)
    if (serialized.length > MAX_SERIALIZED_BYTES) {
      removeStoredRecovery(store)
      return
    }
    store?.setItem(STORAGE_KEY, serialized)
  } catch {
    removeStoredRecovery(store)
  }
}

function entryKey(kind: SessionRecoveryKind, resourceId: string): string {
  return `${kind}\u0000${resourceId}`
}

/** Establish the local account boundary before any recovered value is read. */
export function setSessionRecoveryAccount(accountId: string): void {
  currentAccountId = accountId
  authenticationRedirecting = false
  const store = storage()
  const envelope = readEnvelope(store)
  if (envelope && envelope.accountId !== accountId) removeStoredRecovery(store)
  try {
    store?.removeItem(SIGNED_OUT_KEY)
  } catch {
    // Storage is optional; an authenticated response remains authoritative.
  }
}

/** Register one active resource's minimal, JSON-safe unsaved state. */
export function registerSessionRecoveryCapture(
  kind: SessionRecoveryKind,
  resourceId: string,
  capture: () => unknown | null,
): () => void {
  const key = entryKey(kind, resourceId)
  const entryCapture = () => {
    const value = capture()
    return value === null ? null : { kind, resourceId, value }
  }
  captures.set(key, entryCapture)
  return () => {
    if (captures.get(key) === entryCapture) captures.delete(key)
  }
}

/** Snapshot active resources synchronously before the browser leaves for Entra. */
export function captureSessionRecovery(): void {
  authenticationRedirecting = true
  const store = storage()
  if (!currentAccountId) {
    removeStoredRecovery(store)
    return
  }
  const entries = Array.from(captures.values(), (capture) => capture()).filter(
    (entry): entry is RecoveryEntry => entry !== null,
  )
  if (entries.length === 0) {
    removeStoredRecovery(store)
    return
  }
  writeEnvelope(store, {
    version: 1,
    accountId: currentAccountId,
    capturedAt: Date.now(),
    entries: entries.slice(0, MAX_ENTRY_COUNT),
  })
}

/** Consume a value only after the owning resource validates it against server state. */
export function consumeSessionRecovery<T>(
  kind: SessionRecoveryKind,
  resourceId: string,
  validate: (value: unknown) => T | null,
): T | null {
  const store = storage()
  const envelope = readEnvelope(store)
  if (!envelope || envelope.accountId !== currentAccountId) {
    if (envelope) removeStoredRecovery(store)
    return null
  }
  const index = envelope.entries.findIndex(
    (entry) => entry.kind === kind && entry.resourceId === resourceId,
  )
  if (index < 0) return null
  const [entry] = envelope.entries.splice(index, 1)
  if (envelope.entries.length === 0) removeStoredRecovery(store)
  else writeEnvelope(store, envelope)
  try {
    return validate(entry.value)
  } catch {
    return null
  }
}

export function removeSessionRecovery(
  kind: SessionRecoveryKind,
  resourceId: string,
): void {
  const store = storage()
  const envelope = readEnvelope(store)
  if (!envelope) return
  envelope.entries = envelope.entries.filter(
    (entry) => entry.kind !== kind || entry.resourceId !== resourceId,
  )
  if (envelope.entries.length === 0) removeStoredRecovery(store)
  else writeEnvelope(store, envelope)
}

export function clearSessionRecovery(): void {
  currentAccountId = null
  authenticationRedirecting = false
  removeStoredRecovery(storage())
}

/** Remember explicit logout across Back navigations in this browser tab. */
export function markSessionSignedOut(): void {
  clearSessionRecovery()
  try {
    storage()?.setItem(SIGNED_OUT_KEY, '1')
  } catch {
    // Storage is optional; server-side session invalidation still applies.
  }
}

export function clearSessionSignedOut(): void {
  try {
    storage()?.removeItem(SIGNED_OUT_KEY)
  } catch {
    // Storage is optional.
  }
}

export function isSessionSignedOut(): boolean {
  try {
    return storage()?.getItem(SIGNED_OUT_KEY) === '1'
  } catch {
    return false
  }
}

export function isAuthenticationRedirecting(): boolean {
  return authenticationRedirecting
}
