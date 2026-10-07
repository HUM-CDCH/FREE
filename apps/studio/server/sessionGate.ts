import {
  sessionView,
  type AuthenticatedState,
  type AuthenticationBackend,
  type SessionView,
} from './auth.js'

const PUBLIC_API: Readonly<Record<string, true>> = {
  'GET /api/healthz': true,
  'GET /api/auth/session': true,
}

export type SessionGateProceed = {
  verdict: 'proceed'
  authentication: AuthenticatedState
}

export type SessionGateApiDecision =
  | { verdict: 'bypass' }
  | SessionGateProceed
  | {
      verdict: 'deny'
      reason: 'unauthenticated'
      setCookie?: string
    }

export type SessionGatePageDecision =
  | SessionGateProceed
  | {
      verdict: 'deny'
      reason: 'unauthenticated'
      redirectTo: { path: '/auth/login'; returnTo: string }
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
  const denied = (clearCookie: boolean) => ({
    verdict: 'deny' as const,
    reason: 'unauthenticated' as const,
    setCookie: clearCookie ? clearSessionCookie() : undefined,
  })

  return {
    async api(request) {
      const url = new URL(request.url)
      if (PUBLIC_API[`${request.method} ${url.pathname}`] === true)
        return { verdict: 'bypass' }

      const state = await backend.inspect(request)
      return state.authenticated
        ? { verdict: 'proceed', authentication: state }
        : denied(state.clearCookie)
    },

    async page(request) {
      const url = new URL(request.url)
      const state = await backend.inspect(request)
      if (state.authenticated)
        return { verdict: 'proceed', authentication: state }
      return {
        ...denied(state.clearCookie),
        redirectTo: {
          path: '/auth/login',
          returnTo: `${url.pathname}${url.search}`,
        },
      }
    },

    async session(request) {
      const state = await backend.inspect(request)
      return {
        view: sessionView(state),
        setCookie:
          !state.authenticated && state.clearCookie
            ? clearSessionCookie()
            : undefined,
      }
    },
  }
}
