import { browserStudioPath } from '../studioUrl.js'
import {
  authSessionSchema,
  type AuthenticatedSession,
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

const jsonHeaders = {
  Accept: 'application/json',
  'Content-Type': 'application/json',
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

export async function login(
  email: string,
  password: string,
): Promise<AuthenticatedSession> {
  const session = await sessionFrom(
    await fetch(browserStudioPath('/api/auth/login'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: jsonHeaders,
      body: JSON.stringify({ email, password }),
    }),
  )
  if (!session.authenticated)
    throw new Error('The login response did not establish a session.')
  return session
}

export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const response = await fetch(browserStudioPath('/api/auth/password'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: jsonHeaders,
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (!response.ok) throw await authHttpError(response)
}

export async function logout(): Promise<void> {
  const response = await fetch(browserStudioPath('/api/auth/logout'), {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) throw await authHttpError(response)
}
