import {
  createResearcherAccountStore,
  type ResearcherAccountRecord,
  type ResearcherAccountStore,
} from 'db'
import { ApiError } from '../api/_http.js'
import type {
  EntraIdentity,
} from './entraIdentityProvider.js'
import type { SessionManager } from './session.js'

export type SessionView =
  | { authenticated: false }
  | {
      authenticated: true
      account: {
        id: string
        displayName: string
      }
      expiresAt: string
    }

export type UnauthenticatedState = {
  authenticated: false
  clearCookie: boolean
}

export type AuthenticatedState = {
  authenticated: true
  account: ResearcherAccountRecord
  expiresAt: number
}

export type AuthenticationState = UnauthenticatedState | AuthenticatedState

export type SignInResult = {
  state: AuthenticatedState
  sessionCookie: string
}

export type AuthenticationBackend = {
  inspect(request: Request): Promise<AuthenticationState>
  signIn(identity: EntraIdentity): Promise<SignInResult>
}

function authenticationUnavailable(cause: unknown): ApiError {
  return new ApiError(
    503,
    'authentication_unavailable',
    'Authentication is temporarily unavailable.',
    { cause },
  )
}

export function sessionView(state: AuthenticationState): SessionView {
  if (!state.authenticated) return { authenticated: false }
  return {
    authenticated: true,
    account: {
      id: state.account.id,
      displayName: state.account.displayName,
    },
    expiresAt: new Date(state.expiresAt).toISOString(),
  }
}

export function createAuthenticationBackend(options: {
  store?: ResearcherAccountStore
  sessions: SessionManager
}): AuthenticationBackend {
  const store = options.store ?? createResearcherAccountStore()
  const sessions = options.sessions

  return {
    async inspect(request) {
      const cookie = sessions.read(request)
      if (!cookie.present) return { authenticated: false, clearCookie: false }
      if (!cookie.value)
        return { authenticated: false, clearCookie: true }

      const payload = sessions.verify(cookie.value)
      if (!payload) return { authenticated: false, clearCookie: true }

      let account: ResearcherAccountRecord | null
      try {
        account = await store.findById(payload.accountId)
      } catch (cause) {
        throw authenticationUnavailable(cause)
      }
      if (!account) return { authenticated: false, clearCookie: true }
      return {
        authenticated: true,
        account,
        expiresAt: payload.expiresAt,
      }
    },

    async signIn(identity) {
      let account: ResearcherAccountRecord
      try {
        account = await store.findOrCreate(identity)
      } catch (cause) {
        throw authenticationUnavailable(cause)
      }
      const payload = sessions.issue(account.id, identity.expiresAt)
      if (!payload)
        throw new ApiError(
          401,
          'identity_token_expired',
          'The Entra ID token is too close to expiration.',
        )
      const state: AuthenticatedState = {
        authenticated: true,
        account,
        expiresAt: payload.expiresAt,
      }
      return { state, sessionCookie: sessions.serialize(payload) }
    },
  }
}
