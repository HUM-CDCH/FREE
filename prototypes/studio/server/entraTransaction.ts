import {
  createHash,
  randomBytes,
} from 'node:crypto'
import { canonicalStudioBasePath } from 'studio-configuration'
import { studioPath } from '../shared/studioBasePath.js'
import {
  decodeSignedValue,
  encodeSignedValue,
  isCanonicalBase64Url,
  readSingleCookie,
} from './signedCookie.js'
import { timingSafeStringEqual } from './timingSafeStringEqual.js'
import { clearAuthCookie, serializeAuthCookie } from './authCookie.js'

export const ENTRA_TRANSACTION_COOKIE_NAME = 'free_entra_transaction'
export const ENTRA_TRANSACTION_MILLISECONDS = 10 * 60 * 1_000

const TRANSACTION_VERSION = 1
const MAX_COOKIE_VALUE_LENGTH = 4_096
const TRANSACTION_SIGNATURE_CONTEXT = 'FREE Entra transaction cookie'

export type EntraTransaction = {
  version: typeof TRANSACTION_VERSION
  state: string
  nonce: string
  codeVerifier: string
  returnTo: string
  issuedAt: number
  expiresAt: number
}

export type EntraTransactionManager = {
  create(returnTo: string): {
    transaction: EntraTransaction
    codeChallenge: string
    setCookie: string
  }
  verify(request: Request, state: string): EntraTransaction | null
  clear(): string
}

function randomValue(): string {
  return randomBytes(32).toString('base64url')
}

function validTransaction(
  value: unknown,
  now: number,
): value is EntraTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const transaction = value as Record<string, unknown>
  return (
    Object.keys(transaction).length === 7 &&
    transaction.version === TRANSACTION_VERSION &&
    typeof transaction.state === 'string' &&
    isCanonicalBase64Url(transaction.state) &&
    typeof transaction.nonce === 'string' &&
    isCanonicalBase64Url(transaction.nonce) &&
    typeof transaction.codeVerifier === 'string' &&
    isCanonicalBase64Url(transaction.codeVerifier) &&
    typeof transaction.returnTo === 'string' &&
    Number.isSafeInteger(transaction.issuedAt) &&
    Number.isSafeInteger(transaction.expiresAt) &&
    Number(transaction.issuedAt) <= now &&
    Number(transaction.expiresAt) > now &&
    Number(transaction.expiresAt) - Number(transaction.issuedAt) ===
      ENTRA_TRANSACTION_MILLISECONDS
  )
}

export function createEntraTransactionManager(
  secretValue: Uint8Array,
  basePath = '/',
  now: () => number = Date.now,
): EntraTransactionManager {
  if (secretValue.byteLength < 32)
    throw new Error('The transaction secret must contain at least 32 bytes.')
  const secret = Buffer.from(secretValue)
  const path = studioPath(canonicalStudioBasePath(basePath), '/auth')

  return {
    create(returnTo) {
      const issuedAt = now()
      const transaction: EntraTransaction = {
        version: TRANSACTION_VERSION,
        state: randomValue(),
        nonce: randomValue(),
        codeVerifier: randomValue(),
        returnTo,
        issuedAt,
        expiresAt: issuedAt + ENTRA_TRANSACTION_MILLISECONDS,
      }
      const value = encodeSignedValue(
        transaction,
        secret,
        TRANSACTION_SIGNATURE_CONTEXT,
      )
      return {
        transaction,
        codeChallenge: createHash('sha256')
          .update(transaction.codeVerifier)
          .digest('base64url'),
        setCookie: serializeAuthCookie(
          ENTRA_TRANSACTION_COOKIE_NAME,
          value,
          {
            path,
            expires: new Date(transaction.expiresAt),
            maxAge: Math.floor(ENTRA_TRANSACTION_MILLISECONDS / 1_000),
          },
        ),
      }
    },

    verify(request, state) {
      const value = readSingleCookie(
        request,
        ENTRA_TRANSACTION_COOKIE_NAME,
      ).value
      if (!value) return null
      const decoded = decodeSignedValue(
        value,
        secret,
        TRANSACTION_SIGNATURE_CONTEXT,
        MAX_COOKIE_VALUE_LENGTH,
      )
      const transaction = validTransaction(decoded, now()) ? decoded : null
      return transaction && timingSafeStringEqual(transaction.state, state)
        ? transaction
        : null
    },

    clear() {
      return clearAuthCookie(ENTRA_TRANSACTION_COOKIE_NAME, path)
    },
  }
}
