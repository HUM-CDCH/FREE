import { browserStudioPath } from '../studioUrl.js'
import {
  authSessionSchema,
  type AuthSession,
} from '../../shared/authSession.contract'

export type {
  AuthSession,
  AuthenticatedSession,
} from '../../shared/authSession.contract'

export class AuthHttpError extends Error {
  readonly status: number
  readonly code: string | null

  constructor(status: number, code: string | null) {
    super(`Authentication request failed with status ${status}.`)
    this.name = 'AuthHttpError'
    this.status = status
    this.code = code
  }
}

async function authHttpError(response: Response): Promise<AuthHttpError> {
  const body: unknown = await response.json().catch(() => null)
  const error =
    body && typeof body === 'object' && 'error' in body
      ? (body.error as unknown)
      : null
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : null
  return new AuthHttpError(response.status, code)
}

async function sessionFrom(response: Response): Promise<AuthSession> {
  if (!response.ok) throw await authHttpError(response)
  try {
    return authSessionSchema.parse(await response.json())
  } catch {
    throw new Error('The authentication response is invalid.')
  }
}

export async function getAuthSession(signal?: AbortSignal): Promise<AuthSession> {
  return sessionFrom(
    await fetch(browserStudioPath('/api/auth/session'), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    }),
  )
}
