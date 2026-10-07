import type { ResearcherAccountRecord } from 'db'
import { describe, expect, it, vi } from 'vitest'
import type { AuthenticationState } from './auth.js'
import { createSessionGate } from './sessionGate.js'

const ORIGIN = 'https://studio.example'
const CLEAR =
  'free_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax'
const EXPIRES_AT = Date.UTC(2026, 7, 20, 10)
const ACCOUNT: ResearcherAccountRecord = {
  id: '10000000-0000-4000-8000-000000000001',
  tenantId: '10000000-0000-4000-8000-000000000002',
  objectId: '10000000-0000-4000-8000-000000000003',
  displayName: 'Ada Researcher',
  createdAt: new Date('2026-08-01T00:00:00Z'),
  updatedAt: new Date('2026-08-01T00:00:00Z'),
}

const ANONYMOUS: AuthenticationState = {
  authenticated: false,
  clearCookie: false,
}
const STALE: AuthenticationState = {
  authenticated: false,
  clearCookie: true,
}
const AUTHENTICATED: AuthenticationState = {
  authenticated: true,
  account: ACCOUNT,
  expiresAt: EXPIRES_AT,
}

function request(method: string, path: string): Request {
  return new Request(`${ORIGIN}${path}`, { method })
}

function fixture(state: AuthenticationState) {
  const inspect = vi.fn(async () => state)
  return {
    inspect,
    gate: createSessionGate({
      backend: { inspect },
      clearSessionCookie: () => CLEAR,
    }),
  }
}

describe('session gate', () => {
  it.each([
    ['GET', '/api/healthz'],
    ['GET', '/api/auth/session'],
  ])('bypasses only the public %s %s endpoint', async (method, path) => {
    const { gate, inspect } = fixture(ANONYMOUS)
    await expect(gate.api(request(method, path))).resolves.toEqual({
      verdict: 'bypass',
    })
    expect(inspect).not.toHaveBeenCalled()
  })

  it.each([
    ['HEAD', '/api/healthz'],
    ['POST', '/api/auth/session'],
    ['POST', '/api/auth/login'],
    ['POST', '/api/auth/password'],
    ['GET', '/api/project-contexts'],
  ])('protects every non-public API pair: %s %s', async (method, path) => {
    const { gate } = fixture(ANONYMOUS)
    await expect(gate.api(request(method, path))).resolves.toEqual({
      verdict: 'deny',
      reason: 'unauthenticated',
      setCookie: undefined,
    })
  })

  it('clears invalid sessions and never renews authenticated sessions', async () => {
    const stale = fixture(STALE)
    await expect(
      stale.gate.api(request('GET', '/api/project-contexts')),
    ).resolves.toEqual({
      verdict: 'deny',
      reason: 'unauthenticated',
      setCookie: CLEAR,
    })

    const authenticated = fixture(AUTHENTICATED)
    await expect(
      authenticated.gate.api(request('GET', '/api/project-contexts')),
    ).resolves.toEqual({
      verdict: 'proceed',
      authentication: AUTHENTICATED,
    })
  })

  it('redirects protected pages to Entra login with the internal deep link', async () => {
    const { gate } = fixture(STALE)
    await expect(
      gate.page(request('GET', '/projects/one?tab=review')),
    ).resolves.toEqual({
      verdict: 'deny',
      reason: 'unauthenticated',
      redirectTo: {
        path: '/auth/login',
        returnTo: '/projects/one?tab=review',
      },
      setCookie: CLEAR,
    })
  })

  it('returns a bounded session view without a renewal cookie', async () => {
    const { gate } = fixture(AUTHENTICATED)
    await expect(
      gate.session(request('GET', '/api/auth/session')),
    ).resolves.toEqual({
      view: {
        authenticated: true,
        account: { id: ACCOUNT.id, displayName: ACCOUNT.displayName },
        expiresAt: new Date(EXPIRES_AT).toISOString(),
      },
      setCookie: undefined,
    })
  })
})
