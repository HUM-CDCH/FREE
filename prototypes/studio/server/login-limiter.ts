import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export const LOGIN_LIMIT_EMAIL_MAX_FAILURES = 5
export const LOGIN_LIMIT_ADDRESS_MAX_FAILURES = 50
export const LOGIN_LIMIT_WINDOW_MILLISECONDS = 15 * 60 * 1_000
export const LOGIN_LIMIT_MAX_ENTRIES = 2_048

type LimiterEntry = {
  kind: 'email' | 'address'
  failures: number
  inFlight: number
  resetAt: number
}

export type LoginLimiterOptions = {
  emailMaxFailures?: number
  addressMaxFailures?: number
  windowMilliseconds?: number
  maxEntries?: number
  now?: () => number
}

export type LoginAttemptOutcome = 'success' | 'failure' | 'abandon'
export type LoginAttemptReservation =
  | { accepted: false; retryAfterSeconds: number }
  | {
      accepted: true
      complete(outcome: LoginAttemptOutcome): void
    }

export type LoginLimiter = {
  reserve(
    normalizedEmail: string,
    clientAddress: string,
  ): LoginAttemptReservation
  readonly size: number
}

export function normalizeClientAddress(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() || 'unknown'
  if (normalized.startsWith('::ffff:')) {
    const ipv4 = normalized.slice('::ffff:'.length)
    if (isIP(ipv4) === 4) return ipv4
  }
  return normalized
}

function emailBucket(normalizedEmail: string): string {
  return `email:${createHash('sha256').update(normalizedEmail).digest('base64url')}`
}

export function createLoginLimiter(
  options: LoginLimiterOptions = {},
): LoginLimiter {
  const emailMaxFailures =
    options.emailMaxFailures ?? LOGIN_LIMIT_EMAIL_MAX_FAILURES
  const addressMaxFailures =
    options.addressMaxFailures ?? LOGIN_LIMIT_ADDRESS_MAX_FAILURES
  const windowMilliseconds =
    options.windowMilliseconds ?? LOGIN_LIMIT_WINDOW_MILLISECONDS
  const maxEntries = options.maxEntries ?? LOGIN_LIMIT_MAX_ENTRIES
  const now = options.now ?? Date.now
  if (!Number.isSafeInteger(emailMaxFailures) || emailMaxFailures < 1)
    throw new Error(
      'Login limiter emailMaxFailures must be a positive integer.',
    )
  if (!Number.isSafeInteger(addressMaxFailures) || addressMaxFailures < 1)
    throw new Error(
      'Login limiter addressMaxFailures must be a positive integer.',
    )
  if (!Number.isSafeInteger(windowMilliseconds) || windowMilliseconds < 1)
    throw new Error(
      'Login limiter windowMilliseconds must be a positive integer.',
    )
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 2)
    throw new Error('Login limiter maxEntries must be at least two.')

  const entries = new Map<string, LimiterEntry>()
  const keys = (normalizedEmail: string, clientAddress: string) => [
    emailBucket(normalizedEmail),
    `address:${normalizeClientAddress(clientAddress)}`,
  ] as const
  const threshold = (entry: LimiterEntry) =>
    entry.kind === 'email' ? emailMaxFailures : addressMaxFailures

  function prune(currentTime: number): void {
    for (const [key, entry] of entries) {
      if (entry.resetAt > currentTime) continue
      if (entry.inFlight === 0) entries.delete(key)
      else {
        entry.failures = 0
        entry.resetAt = currentTime + windowMilliseconds
      }
    }
  }

  function ensureRoom(required: number): boolean {
    while (entries.size + required > maxEntries) {
      let evictable: string | undefined
      for (const [key, entry] of entries)
        if (
          entry.inFlight === 0 &&
          entry.failures < threshold(entry)
        ) {
          evictable = key
          break
        }
      // A bounded cache must not turn saturation into a global login denial.
      // Prefer dropping a dormant email block; retain address blocks as the
      // stronger protection against an attacker rotating account names.
      if (evictable === undefined)
        for (const [key, entry] of entries)
          if (entry.inFlight === 0 && entry.kind === 'email') {
            evictable = key
            break
          }
      if (evictable === undefined)
        for (const [key, entry] of entries)
          if (entry.inFlight === 0) {
            evictable = key
            break
          }
      if (evictable === undefined) return false
      entries.delete(evictable)
    }
    return true
  }

  function blockedFor(
    bucketKeys: readonly [string, string],
    currentTime: number,
  ): number | null {
    let retryAfter = 0
    for (const key of bucketKeys) {
      const entry = entries.get(key)
      if (entry && entry.failures + entry.inFlight >= threshold(entry))
        retryAfter = Math.max(
          retryAfter,
          Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1_000)),
        )
    }
    return retryAfter > 0 ? retryAfter : null
  }

  return {
    reserve(normalizedEmail, clientAddress) {
      const currentTime = now()
      prune(currentTime)
      const bucketKeys = keys(normalizedEmail, clientAddress)
      const retryAfterSeconds = blockedFor(bucketKeys, currentTime)
      if (retryAfterSeconds !== null)
        return { accepted: false as const, retryAfterSeconds }

      const missing = bucketKeys.filter((key) => !entries.has(key)).length
      if (!ensureRoom(missing))
        return { accepted: false as const, retryAfterSeconds: 1 }
      bucketKeys.forEach((key, index) => {
        const entry = entries.get(key) ?? {
          kind: index === 0 ? 'email' : 'address',
          failures: 0,
          inFlight: 0,
          resetAt: currentTime + windowMilliseconds,
        }
        entry.inFlight += 1
        entries.set(key, entry)
      })

      let completed = false
      return {
        accepted: true as const,
        complete(outcome) {
          if (completed) return
          completed = true
          const completedAt = now()
          bucketKeys.forEach((key, index) => {
            const entry = entries.get(key)
            if (!entry) return
            entry.inFlight = Math.max(0, entry.inFlight - 1)
            if (outcome === 'failure') {
              entry.failures += 1
              entry.resetAt = completedAt + windowMilliseconds
            } else if (outcome === 'success' && index === 0) {
              entry.failures = 0
            }
            if (entry.inFlight === 0 && entry.failures === 0)
              entries.delete(key)
          })
        },
      }
    },

    get size() {
      prune(now())
      return entries.size
    },
  }
}
