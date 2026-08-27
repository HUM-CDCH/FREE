import { canonicalStudioBasePath } from '../shared/studioBasePath.js'
import { CANONICAL_UUID } from '../shared/uuid.js'
import {
  decodeSignedValue,
  encodeSignedValue,
  readSingleCookie,
  type SingleCookie,
} from './signedCookie.js'
import { clearAuthCookie, serializeAuthCookie } from './authCookie.js'

export const SESSION_COOKIE_NAME = 'free_session'
export const SESSION_CLOCK_SKEW_MILLISECONDS = 60_000

const SESSION_VERSION = 2
const MAX_COOKIE_VALUE_LENGTH = 2_048
const SESSION_SIGNATURE_CONTEXT = 'FREE session cookie'

export type SessionPayload = {
  version: typeof SESSION_VERSION
  accountId: string
  issuedAt: number
  expiresAt: number
}

export type SessionCookie = SingleCookie

export type SessionManager = {
  issue(accountId: string, identityTokenExpiresAt: number): SessionPayload | null
  verify(value: string): SessionPayload | null
  serialize(payload: SessionPayload): string
  clear(): string
  read(request: Request): SessionCookie
}

function validPayload(value: unknown, now: number): value is SessionPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  if (
    Object.keys(payload).length !== 4 ||
    payload.version !== SESSION_VERSION ||
    typeof payload.accountId !== 'string' ||
    !CANONICAL_UUID.test(payload.accountId) ||
    !Number.isSafeInteger(payload.issuedAt) ||
    !Number.isSafeInteger(payload.expiresAt)
  )
    return false

  const issuedAt = Number(payload.issuedAt)
  const expiresAt = Number(payload.expiresAt)
  return issuedAt <= now && expiresAt > issuedAt && now < expiresAt
}

export function clearSessionCookie(path: string): string {
  return clearAuthCookie(SESSION_COOKIE_NAME, canonicalStudioBasePath(path))
}

export function readSessionCookie(request: Request): SessionCookie {
  return readSingleCookie(request, SESSION_COOKIE_NAME)
}

export function createSessionManager(
  secretValue: Uint8Array,
  now: () => number = Date.now,
  basePath = '/',
): SessionManager {
  if (secretValue.byteLength < 32)
    throw new Error('The session secret must contain at least 32 bytes.')
  const secret = Buffer.from(secretValue)
  const cookiePath = canonicalStudioBasePath(basePath)

  return {
    issue(accountId, identityTokenExpiresAt) {
      const issuedAt = now()
      const expiresAt =
        identityTokenExpiresAt - SESSION_CLOCK_SKEW_MILLISECONDS
      if (
        !CANONICAL_UUID.test(accountId) ||
        !Number.isSafeInteger(identityTokenExpiresAt) ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= issuedAt
      )
        return null
      return {
        version: SESSION_VERSION,
        accountId,
        issuedAt,
        expiresAt,
      }
    },

    verify(value) {
      const payload = decodeSignedValue(
        value,
        secret,
        SESSION_SIGNATURE_CONTEXT,
        MAX_COOKIE_VALUE_LENGTH,
      )
      return validPayload(payload, now()) ? payload : null
    },

    serialize(payload) {
      return serializeAuthCookie(
        SESSION_COOKIE_NAME,
        encodeSignedValue(payload, secret, SESSION_SIGNATURE_CONTEXT),
        {
          path: cookiePath,
          expires: new Date(payload.expiresAt),
          maxAge: Math.max(
            0,
            Math.floor((payload.expiresAt - now()) / 1_000),
          ),
        },
      )
    },

    clear: () => clearSessionCookie(cookiePath),
    read: readSessionCookie,
  }
}
