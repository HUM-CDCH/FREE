import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE_NAME = 'free_session'
export const SESSION_IDLE_MILLISECONDS = 12 * 60 * 60 * 1_000
export const SESSION_ABSOLUTE_MILLISECONDS = 7 * 24 * 60 * 60 * 1_000

const SESSION_VERSION = 1
const MAX_COOKIE_VALUE_LENGTH = 2_048
const BASE64URL = /^[A-Za-z0-9_-]+$/
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type SessionPayload = {
  version: typeof SESSION_VERSION
  accountId: string
  sessionVersion: number
  issuedAt: number
  expiresAt: number
}

export type SessionCookie = {
  present: boolean
  value: string | null
}

export type SessionManager = {
  issue(accountId: string, sessionVersion: number): SessionPayload
  verify(value: string): SessionPayload | null
  renew(payload: SessionPayload): SessionPayload | null
  serialize(payload: SessionPayload): string
  clear(): string
  read(request: Request): SessionCookie
}

function canonicalBase64Url(value: string): Buffer | null {
  if (!value || !BASE64URL.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url')
    return decoded.toString('base64url') === value ? decoded : null
  } catch {
    return null
  }
}

function validPayload(value: unknown, now: number): value is SessionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (
    Object.keys(payload).length !== 5 ||
    payload.version !== SESSION_VERSION ||
    typeof payload.accountId !== 'string' ||
    !CANONICAL_UUID.test(payload.accountId) ||
    !Number.isSafeInteger(payload.sessionVersion) ||
    Number(payload.sessionVersion) < 0 ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt)
  )
    return false

  const issuedAt = Number(payload.issuedAt)
  const expiresAt = Number(payload.expiresAt)
  const absoluteExpiry = issuedAt + SESSION_ABSOLUTE_MILLISECONDS
  return (
    Number.isSafeInteger(absoluteExpiry) &&
    issuedAt <= now &&
    expiresAt > issuedAt &&
    now < expiresAt &&
    expiresAt <= absoluteExpiry &&
    now < absoluteExpiry
  )
}

function signature(encodedPayload: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(encodedPayload).digest()
}

function encode(payload: SessionPayload, secret: Buffer): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encodedPayload}.${signature(encodedPayload, secret).toString('base64url')}`
}

function decode(value: string, secret: Buffer, now: number): SessionPayload | null {
  if (value.length > MAX_COOKIE_VALUE_LENGTH) return null
  const segments = value.split('.')
  if (segments.length !== 2) return null
  const [encodedPayload, encodedSignature] = segments
  const suppliedSignature = canonicalBase64Url(encodedSignature)
  if (!canonicalBase64Url(encodedPayload) || !suppliedSignature) return null

  const expectedSignature = signature(encodedPayload, secret)
  if (
    suppliedSignature.byteLength !== expectedSignature.byteLength ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  )
    return null

  try {
    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, 'base64url').toString('utf8'),
    )
    return validPayload(payload, now) ? payload : null
  } catch {
    return null
  }
}

function serializeCookie(value: string, expiresAt: number, now: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1_000))
  return `${SESSION_COOKIE_NAME}=${value}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=Strict`
}

export function readSessionCookie(request: Request): SessionCookie {
  const header = request.headers.get('cookie')
  if (!header) return { present: false, value: null }

  let found: string | undefined
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    if (name !== SESSION_COOKIE_NAME) continue
    if (found !== undefined) return { present: true, value: null }
    found = part.slice(separator + 1).trim()
  }
  return found === undefined
    ? { present: false, value: null }
    : { present: true, value: found || null }
}

export function createSessionManager(
  secretValue: Uint8Array,
  now: () => number = Date.now,
): SessionManager {
  if (secretValue.byteLength < 32)
    throw new Error('The session secret must contain at least 32 bytes.')
  const secret = Buffer.from(secretValue)

  return {
    issue(accountId, sessionVersion) {
      const issuedAt = now()
      return {
        version: SESSION_VERSION,
        accountId,
        sessionVersion,
        issuedAt,
        expiresAt: issuedAt + SESSION_IDLE_MILLISECONDS,
      }
    },

    verify(value) {
      return decode(value, secret, now())
    },

    renew(payload) {
      const currentTime = now()
      const absoluteExpiry =
        payload.issuedAt + SESSION_ABSOLUTE_MILLISECONDS
      if (currentTime >= payload.expiresAt || currentTime >= absoluteExpiry)
        return null
      return {
        ...payload,
        expiresAt: Math.min(
          currentTime + SESSION_IDLE_MILLISECONDS,
          absoluteExpiry,
        ),
      }
    },

    serialize(payload) {
      const currentTime = now()
      return serializeCookie(encode(payload, secret), payload.expiresAt, currentTime)
    },

    clear: clearSessionCookie,
    read: readSessionCookie,
  }
}
