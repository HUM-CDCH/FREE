import {
  sessionView,
  type AuthenticatedState,
  type AuthenticationBackend,
  type SessionView,
} from './auth.js'

/**
 * The single place that turns `backend.inspect()` into the consequences the two
 * request surfaces need. Hono-free and Response-free: a Fetch `Request` enters,
 * a semantic decision plus serialized Set-Cookie strings leave.
 */

const PUBLIC_API: Readonly<Record<string, true>> = {
  'GET /api/healthz': true,
  'GET /api/auth/session': true,
  'POST /api/auth/login': true,
}
const MANDATORY_CHANGE_API: Readonly<Record<string, true>> = {
  '/api/auth/session': true,
  '/api/auth/password': true,
  '/api/auth/logout': true,
}
const RENEWAL_SUPPRESSED_API: Readonly<Record<string, true>> = {
  '/api/auth/password': true,
  '/api/auth/logout': true,
}

export type SessionGateDenyReason = 'unauthenticated' | 'passwordChangeRequired'

export type SessionGateProceed = {
  verdict: 'proceed'
  authentication: AuthenticatedState
  setCookie?: string
}

export type SessionGateApiDecision =
  /** Public API route: no inspection, no cookies, no authentication variable. */
  | { verdict: 'bypass' }
  | SessionGateProceed
  | {
      verdict: 'deny'
      reason: SessionGateDenyReason
      /** Clear-cookie value on unauthenticated; renewal value where the rules say so. */
      setCookie?: string
    }

export type SessionGatePageDecision =
  | SessionGateProceed
  | {
      verdict: 'deny'
      reason: SessionGateDenyReason
      redirectTo: { path: '/login' | '/change-password'; returnTo?: string }
      setCookie?: string
    }

export type SessionGateSessionResult = {
  view: SessionView
  setCookie?: string
}

export type SessionGate = {
  api(request: Request): Promise<SessionGateApiDecision>
  page(request: Request): Promise<SessionGatePageDecision>
  session(request: Request): Promise<SessionGateSessionResult>
}

export function createSessionGate(deps: {
  backend: Pick<AuthenticationBackend, 'inspect'>
  clearSessionCookie(): string
}): SessionGate {
  const { backend, clearSessionCookie } = deps

  return {
    async api(request) {
      const pathname = new URL(request.url).pathname
      if (PUBLIC_API[`${request.method} ${pathname}`] === true)
        return { verdict: 'bypass' }

      const state = await backend.inspect(request)
      if (!state.authenticated)
        return {
          verdict: 'deny',
          reason: 'unauthenticated',
          setCookie: state.clearCookie ? clearSessionCookie() : undefined,
        }
      if (
        state.account.mustChangePassword &&
        MANDATORY_CHANGE_API[pathname] !== true
      )
        return { verdict: 'deny', reason: 'passwordChangeRequired' }

      return {
        verdict: 'proceed',
        authentication: state,
        setCookie:
          RENEWAL_SUPPRESSED_API[pathname] === true
            ? undefined
            : state.renewalCookie,
      }
    },

    async page(request) {
      const url = new URL(request.url)
      const state = await backend.inspect(request)
      if (!state.authenticated)
        return {
          verdict: 'deny',
          reason: 'unauthenticated',
          redirectTo: {
            path: '/login',
            returnTo: `${url.pathname}${url.search}`,
          },
          setCookie: state.clearCookie ? clearSessionCookie() : undefined,
        }
      if (
        state.account.mustChangePassword &&
        url.pathname !== '/change-password'
      )
        return {
          verdict: 'deny',
          reason: 'passwordChangeRequired',
          redirectTo: { path: '/change-password' },
          setCookie: state.renewalCookie,
        }

      return {
        verdict: 'proceed',
        authentication: state,
        setCookie: state.renewalCookie,
      }
    },

    async session(request) {
      const state = await backend.inspect(request)
      return {
        view: sessionView(state),
        setCookie: state.authenticated
          ? state.renewalCookie
          : state.clearCookie
            ? clearSessionCookie()
            : undefined,
      }
    },
  }
}
