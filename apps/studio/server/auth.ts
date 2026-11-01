import { createHash } from 'node:crypto'
import {
  createResearcherAccountStore,
  type ResearcherAccountRecord,
  type ResearcherAccountStore,
} from 'db'
import { ApiError } from '../api/_http.js'
import type {
  EntraIdentity,
} from './entraIdentityProvider.js'
import {
  SESSION_CLOCK_SKEW_MILLISECONDS,
  type SessionManager,
  type SessionPayload,
} from './session.js'

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
  /**
   * Signs out a verified session cookie. This process refuses it before the returned promise first waits, so the
   * refusal holds with the database down; the promise rejects when the database did not save it.
   */
  revoke(cookieValue: string, session: SessionPayload): Promise<void>
  /** Whether this process signed out the cookie. Synchronous, for a check that nothing may await after. */
  revokedHere(cookieValue: string): boolean
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

const sessionDigest = (cookieValue: string) =>
  createHash('sha256').update(cookieValue).digest('base64url')

export function createAuthenticationBackend(options: {
  store?: ResearcherAccountStore
  sessions: SessionManager
  now?: () => number
}): AuthenticationBackend {
  const store = options.store ?? createResearcherAccountStore()
  const sessions = options.sessions
  const now = options.now ?? Date.now
  // Sessions signed out in this process, by digest, until they would have expired.
  const revokedSessions = new Map<string, number>()

  return {
    async inspect(request) {
      const cookie = sessions.read(request)
      if (!cookie.present) return { authenticated: false, clearCookie: false }
      if (!cookie.value)
        return { authenticated: false, clearCookie: true }

      const payload = sessions.verify(cookie.value)
      if (!payload) return { authenticated: false, clearCookie: true }

      // A signed-out session's answer clears no cookie: it can arrive after the browser signed in again.
      const digest = sessionDigest(cookie.value)
      if (revokedSessions.has(digest))
        return { authenticated: false, clearCookie: false }
      let account: ResearcherAccountRecord | null
      try {
        if (await store.isSessionRevoked(digest))
          return { authenticated: false, clearCookie: false }
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

    async revoke(cookieValue, session) {
      const time = now()
      for (const [digest, expiresAt] of revokedSessions)
        if (expiresAt <= time) revokedSessions.delete(digest)
      const digest = sessionDigest(cookieValue)
      revokedSessions.set(digest, session.expiresAt)
      // Another process's clock may run behind this one's: keep a sign-out until it has expired there too.
      await store.revokeSession(
        digest,
        new Date(session.expiresAt),
        new Date(time - SESSION_CLOCK_SKEW_MILLISECONDS),
      )
    },

    revokedHere: (cookieValue) => revokedSessions.has(sessionDigest(cookieValue)),
  }
}
