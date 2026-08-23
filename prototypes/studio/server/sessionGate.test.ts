import type { ResearcherAccountRecord, ResearcherAccountStore } from 'db'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/_http.js'
import {
  createAuthenticationBackend,
  type AuthenticationState,
} from './auth.js'
import { createSessionManager } from './session.js'
import {
  createSessionGate,
  type SessionGateApiDecision,
  type SessionGatePageDecision,
} from './sessionGate.js'

const ORIGIN = 'https://studio.example'
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001'
const EMAIL = 'researcher@example.org'
const SECRET = Buffer.alloc(32, 9)
const RENEWAL = 'free_session=renewed; Path=/; Secure; HttpOnly; SameSite=Strict'
const CLEAR = 'free_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict'
const FIXED_TIME = Date.UTC(2026, 7, 20)

function accountRecord(
  mustChangePassword: boolean,
): ResearcherAccountRecord {
  return {
    id: ACCOUNT_ID,
    email: EMAIL,
    passwordHash: 'hash:unused',
    mustChangePassword,
    disabledAt: null,
    sessionVersion: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  }
}

const ANONYMOUS_CLEAN: AuthenticationState = {
  authenticated: false,
  clearCookie: false,
}
const ANONYMOUS_STALE: AuthenticationState = {
  authenticated: false,
  clearCookie: true,
}
const AUTHENTICATED: AuthenticationState = {
  authenticated: true,
  account: accountRecord(false),
  renewalCookie: RENEWAL,
}
const PASSWORD_PENDING: AuthenticationState = {
  authenticated: true,
  account: accountRecord(true),
  renewalCookie: RENEWAL,
}

function request(method: string, path: string): Request {
  return new Request(`${ORIGIN}${path}`, { method })
}

function stubGate(state: AuthenticationState) {
  const inspect = vi.fn(async () => state)
  return {
    inspect,
    gate: createSessionGate({
      backend: { inspect },
      clearSessionCookie: () => CLEAR,
    }),
  }
}

function decisionCookie(
  decision: SessionGateApiDecision | SessionGatePageDecision,
): string | undefined {
  return 'setCookie' in decision ? decision.setCookie : undefined
}

/** Table A expectations: what the API surface decides today. */
type ApiExpectation =
  | { verdict: 'bypass' }
  | { verdict: 'proceed'; setCookie?: string }
  | {
      verdict: 'deny'
      reason: 'unauthenticated' | 'passwordChangeRequired'
      setCookie?: string
    }

const BYPASS: ApiExpectation = { verdict: 'bypass' }
/** Anonymous with no cookie at all: 401 and nothing to clear. */
const DENY_401: ApiExpectation = { verdict: 'deny', reason: 'unauthenticated' }
/** Anonymous with a stale cookie: 401 plus the clear cookie. */
const DENY_401_CLEAR: ApiExpectation = {
  verdict: 'deny',
  reason: 'unauthenticated',
  setCookie: CLEAR,
}
/** 403 with no renewal. Commit 2 (plan §5.2) adds the renewal cookie here. */
const DENY_403_NO_RENEWAL: ApiExpectation = {
  verdict: 'deny',
  reason: 'passwordChangeRequired',
}
const PROCEED_RENEWED: ApiExpectation = {
  verdict: 'proceed',
  setCookie: RENEWAL,
}
/** Handler-owned cookie paths: renewal suppressed by pathname today. */
const PROCEED_SUPPRESSED: ApiExpectation = { verdict: 'proceed' }

const API_ROWS: ReadonlyArray<{
  row: string
  method: string
  path: string
  anonymousClean: ApiExpectation
  anonymousStale: ApiExpectation
  authenticated: ApiExpectation
  passwordPending: ApiExpectation
}> = [
  {
    row: 'A1',
    method: 'GET',
    path: '/api/healthz',
    anonymousClean: BYPASS,
    anonymousStale: BYPASS,
    authenticated: BYPASS,
    passwordPending: BYPASS,
  },
  {
    // HEAD variants of public GETs are not public: method-keyed classification.
    // Plan Table A records 200 +R for the password-pending column; the code
    // denies with 403 because /api/healthz is not a mandatory-change path.
    row: 'A2',
    method: 'HEAD',
    path: '/api/healthz',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: DENY_403_NO_RENEWAL,
  },
  {
    row: 'A3',
    method: 'POST',
    path: '/api/auth/login',
    anonymousClean: BYPASS,
    anonymousStale: BYPASS,
    authenticated: BYPASS,
    passwordPending: BYPASS,
  },
  {
    row: 'A4',
    method: 'GET',
    path: '/api/auth/login',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: DENY_403_NO_RENEWAL,
  },
  {
    row: 'A5',
    method: 'GET',
    path: '/api/auth/session',
    anonymousClean: BYPASS,
    anonymousStale: BYPASS,
    authenticated: BYPASS,
    passwordPending: BYPASS,
  },
  {
    row: 'A6',
    method: 'HEAD',
    path: '/api/auth/session',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: PROCEED_RENEWED,
  },
  {
    row: 'A7',
    method: 'POST',
    path: '/api/auth/session',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: PROCEED_RENEWED,
  },
  {
    row: 'A8',
    method: 'POST',
    path: '/api/auth/password',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_SUPPRESSED,
    passwordPending: PROCEED_SUPPRESSED,
  },
  {
    row: 'A9',
    method: 'GET',
    path: '/api/auth/password',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_SUPPRESSED,
    passwordPending: PROCEED_SUPPRESSED,
  },
  {
    row: 'A10',
    method: 'POST',
    path: '/api/auth/logout',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_SUPPRESSED,
    passwordPending: PROCEED_SUPPRESSED,
  },
  {
    row: 'A11',
    method: 'GET',
    path: '/api/auth/logout',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_SUPPRESSED,
    passwordPending: PROCEED_SUPPRESSED,
  },
  {
    row: 'A12',
    method: 'GET',
    path: '/api/auth/unknown-operation',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: DENY_403_NO_RENEWAL,
  },
  {
    row: 'A13',
    method: 'GET',
    path: '/api/project-contexts',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: DENY_403_NO_RENEWAL,
  },
  {
    row: 'A13 (POST)',
    method: 'POST',
    path: '/api/project-contexts',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: DENY_403_NO_RENEWAL,
  },
  {
    row: 'A13 (bare /api)',
    method: 'GET',
    path: '/api',
    anonymousClean: DENY_401,
    anonymousStale: DENY_401_CLEAR,
    authenticated: PROCEED_RENEWED,
    passwordPending: DENY_403_NO_RENEWAL,
  },
]

async function assertApiCell(
  state: AuthenticationState,
  method: string,
  path: string,
  expected: ApiExpectation,
): Promise<void> {
  const { gate, inspect } = stubGate(state)
  const decision = await gate.api(request(method, path))

  expect(decision.verdict).toBe(expected.verdict)
  if (expected.verdict === 'bypass') {
    expect(inspect).not.toHaveBeenCalled()
    expect(Object.keys(decision)).toEqual(['verdict'])
  } else expect(inspect).toHaveBeenCalledOnce()
  if (expected.verdict === 'deny' && decision.verdict === 'deny')
    expect(decision.reason).toBe(expected.reason)
  if (expected.verdict === 'proceed' && decision.verdict === 'proceed')
    expect(decision.authentication).toBe(state)
  expect(decisionCookie(decision)).toBe(
    expected.verdict === 'bypass' ? undefined : expected.setCookie,
  )
}

describe('Table A — API surface', () => {
  it.each(API_ROWS)('$row $method $path', async (row) => {
    await assertApiCell(
      ANONYMOUS_CLEAN,
      row.method,
      row.path,
      row.anonymousClean,
    )
    await assertApiCell(
      ANONYMOUS_STALE,
      row.method,
      row.path,
      row.anonymousStale,
    )
    await assertApiCell(AUTHENTICATED, row.method, row.path, row.authenticated)
    await assertApiCell(
      PASSWORD_PENDING,
      row.method,
      row.path,
      row.passwordPending,
    )
  })

  it('classifies public routes by method and path together', async () => {
    const { gate, inspect } = stubGate(ANONYMOUS_CLEAN)
    for (const [method, path] of [
      ['GET', '/api/healthz'],
      ['GET', '/api/auth/session'],
      ['POST', '/api/auth/login'],
    ] as const)
      expect((await gate.api(request(method, path))).verdict).toBe('bypass')
    expect(inspect).not.toHaveBeenCalled()

    for (const [method, path] of [
      ['POST', '/api/healthz'],
      ['GET', '/api/healthz/'],
      ['POST', '/api/auth/session'],
      ['GET', '/api/auth/login'],
    ] as const)
      expect((await gate.api(request(method, path))).verdict).toBe('deny')
    expect(inspect).toHaveBeenCalledTimes(4)
  })
})

describe('Table A row A5 — session surface', () => {
  it('reports an anonymous view without a cookie when none was presented', async () => {
    const { gate } = stubGate(ANONYMOUS_CLEAN)
    await expect(
      gate.session(request('GET', '/api/auth/session')),
    ).resolves.toEqual({ view: { authenticated: false }, setCookie: undefined })
  })

  it('clears a stale cookie alongside the anonymous view', async () => {
    const { gate } = stubGate(ANONYMOUS_STALE)
    await expect(
      gate.session(request('GET', '/api/auth/session')),
    ).resolves.toEqual({ view: { authenticated: false }, setCookie: CLEAR })
  })

  it('renews an authenticated session and exposes the bounded view', async () => {
    const { gate } = stubGate(AUTHENTICATED)
    await expect(
      gate.session(request('GET', '/api/auth/session')),
    ).resolves.toEqual({
      view: {
        authenticated: true,
        account: { id: ACCOUNT_ID, email: EMAIL, mustChangePassword: false },
      },
      setCookie: RENEWAL,
    })
  })

  it('remains the discovery channel while a password change is pending', async () => {
    const { gate } = stubGate(PASSWORD_PENDING)
    await expect(
      gate.session(request('GET', '/api/auth/session')),
    ).resolves.toEqual({
      view: {
        authenticated: true,
        account: { id: ACCOUNT_ID, email: EMAIL, mustChangePassword: true },
      },
      setCookie: RENEWAL,
    })
  })
})

describe('Table B row B4 — page surface', () => {
  const DEEP_LINK = '/projects/deep?tab=sources'

  it('redirects an anonymous deep link to login with returnTo and no cookie', async () => {
    const { gate } = stubGate(ANONYMOUS_CLEAN)
    await expect(gate.page(request('GET', DEEP_LINK))).resolves.toEqual({
      verdict: 'deny',
      reason: 'unauthenticated',
      redirectTo: { path: '/login', returnTo: DEEP_LINK },
      setCookie: undefined,
    })
  })

  it('clears a stale cookie on the login redirect', async () => {
    const { gate } = stubGate(ANONYMOUS_STALE)
    await expect(gate.page(request('HEAD', DEEP_LINK))).resolves.toEqual({
      verdict: 'deny',
      reason: 'unauthenticated',
      redirectTo: { path: '/login', returnTo: DEEP_LINK },
      setCookie: CLEAR,
    })
  })

  it('renews an authenticated page load', async () => {
    const { gate } = stubGate(AUTHENTICATED)
    await expect(gate.page(request('GET', DEEP_LINK))).resolves.toEqual({
      verdict: 'proceed',
      authentication: AUTHENTICATED,
      setCookie: RENEWAL,
    })
  })

  it('sends a password-pending page to /change-password with renewal and no returnTo', async () => {
    const { gate } = stubGate(PASSWORD_PENDING)
    await expect(gate.page(request('GET', DEEP_LINK))).resolves.toEqual({
      verdict: 'deny',
      reason: 'passwordChangeRequired',
      redirectTo: { path: '/change-password' },
      setCookie: RENEWAL,
    })
  })

  it('serves /change-password itself while a password change is pending', async () => {
    const { gate } = stubGate(PASSWORD_PENDING)
    await expect(
      gate.page(request('GET', '/change-password')),
    ).resolves.toEqual({
      verdict: 'proceed',
      authentication: PASSWORD_PENDING,
      setCookie: RENEWAL,
    })
  })

  it('still asks an anonymous visitor of /change-password to log in', async () => {
    const { gate } = stubGate(ANONYMOUS_CLEAN)
    await expect(
      gate.page(request('GET', '/change-password')),
    ).resolves.toEqual({
      verdict: 'deny',
      reason: 'unauthenticated',
      redirectTo: { path: '/login', returnTo: '/change-password' },
      setCookie: undefined,
    })
  })
})

type BackendFixture = {
  gate: ReturnType<typeof createSessionGate>
  findById: ReturnType<typeof vi.fn>
  sessionCookie: string
  clearCookie: string
  renewalCookie: string
}

/**
 * A real authentication backend over a real session manager, so 503 fixtures
 * carry a cryptographically valid issued cookie whose account lookup rejects.
 */
async function backendFixture(
  options: { mustChangePassword?: boolean } = {},
): Promise<BackendFixture> {
  const account = accountRecord(options.mustChangePassword ?? false)
  const sessions = createSessionManager(SECRET, () => FIXED_TIME)
  const findById = vi.fn(async (id: string) =>
    id === account.id ? account : null,
  )
  const store: ResearcherAccountStore = {
    create: vi.fn(async () => account),
    findByEmail: vi.fn(async () => account),
    findById,
    replacePassword: vi.fn(async () => null),
    disable: vi.fn(async () => null),
  }
  const backend = await createAuthenticationBackend({
    store,
    sessions,
    dummyPasswordHash: 'hash:unused',
  })
  const issued = sessions.issue(account.id, account.sessionVersion)
  const renewed = sessions.renew(issued)!
  return {
    gate: createSessionGate({
      backend,
      clearSessionCookie: () => sessions.clear(),
    }),
    findById,
    sessionCookie: sessions.serialize(issued).split(';', 1)[0],
    clearCookie: sessions.clear(),
    renewalCookie: sessions.serialize(renewed),
  }
}

function cookieRequest(
  method: string,
  path: string,
  sessionCookie?: string,
): Request {
  return new Request(
    `${ORIGIN}${path}`,
    sessionCookie ? { method, headers: { cookie: sessionCookie } } : { method },
  )
}

describe('store failure and inspection accounting', () => {
  it('propagates authentication_unavailable on every surface', async () => {
    const surfaces: ReadonlyArray<
      [string, (fixture: BackendFixture) => Promise<unknown>]
    > = [
      [
        'session',
        (fixture) =>
          fixture.gate.session(
            cookieRequest('GET', '/api/auth/session', fixture.sessionCookie),
          ),
      ],
      [
        'protected API',
        (fixture) =>
          fixture.gate.api(
            cookieRequest('GET', '/api/project-contexts', fixture.sessionCookie),
          ),
      ],
      [
        'page',
        (fixture) =>
          fixture.gate.page(
            cookieRequest('GET', '/projects/deep', fixture.sessionCookie),
          ),
      ],
    ]

    for (const [name, invoke] of surfaces) {
      const fixture = await backendFixture()
      fixture.findById.mockRejectedValue(new Error('store unavailable'))
      const rejection = await invoke(fixture).then(
        () => null,
        (error: unknown) => error,
      )
      expect(rejection, name).toBeInstanceOf(ApiError)
      expect(rejection, name).toMatchObject({
        status: 503,
        code: 'authentication_unavailable',
      })
    }
  })

  it('never touches the store for a clean anonymous request', async () => {
    const fixture = await backendFixture()
    const api = await fixture.gate.api(
      cookieRequest('GET', '/api/project-contexts'),
    )
    const page = await fixture.gate.page(cookieRequest('GET', '/projects/deep'))
    const session = await fixture.gate.session(
      cookieRequest('GET', '/api/auth/session'),
    )

    expect(fixture.findById).not.toHaveBeenCalled()
    expect(api).toEqual({
      verdict: 'deny',
      reason: 'unauthenticated',
      setCookie: undefined,
    })
    expect(page.verdict).toBe('deny')
    expect(decisionCookie(page)).toBeUndefined()
    expect(session.setCookie).toBeUndefined()
  })

  it('inspects twice when the guard and the session route both run (A6)', async () => {
    const fixture = await backendFixture()
    const head = cookieRequest(
      'HEAD',
      '/api/auth/session',
      fixture.sessionCookie,
    )

    const guard = await fixture.gate.api(head)
    const route = await fixture.gate.session(head)

    expect(fixture.findById).toHaveBeenCalledTimes(2)
    expect(guard).toMatchObject({ verdict: 'proceed' })
    expect(decisionCookie(guard)).toBe(fixture.renewalCookie)
    expect(route.setCookie).toBe(fixture.renewalCookie)
  })

  it('surfaces a store failure that only hits the second inspection (A6)', async () => {
    const fixture = await backendFixture()
    const head = cookieRequest(
      'HEAD',
      '/api/auth/session',
      fixture.sessionCookie,
    )
    fixture.findById.mockImplementationOnce(async () => accountRecord(false))
    fixture.findById.mockImplementationOnce(async () => {
      throw new Error('store unavailable')
    })

    expect(await fixture.gate.api(head)).toMatchObject({ verdict: 'proceed' })
    await expect(fixture.gate.session(head)).rejects.toMatchObject({
      status: 503,
      code: 'authentication_unavailable',
    })
    expect(fixture.findById).toHaveBeenCalledTimes(2)
  })
})

describe('cross-surface agreement', () => {
  it('clears exactly once on a tampered-signature cookie, without a store lookup', async () => {
    const fixture = await backendFixture()
    const last = fixture.sessionCookie.at(-1)!
    const tampered = `${fixture.sessionCookie.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`

    const api = await fixture.gate.api(
      cookieRequest('GET', '/api/project-contexts', tampered),
    )
    const page = await fixture.gate.page(
      cookieRequest('GET', '/projects/deep', tampered),
    )
    const session = await fixture.gate.session(
      cookieRequest('GET', '/api/auth/session', tampered),
    )

    expect(fixture.findById).not.toHaveBeenCalled()
    for (const cookie of [
      decisionCookie(api),
      decisionCookie(page),
      session.setCookie,
    ]) {
      expect(cookie).toBe(fixture.clearCookie)
      expect(cookie).toContain('Max-Age=0')
    }
    expect(session.view).toEqual({ authenticated: false })
  })

  it('renews exactly once on every surface for a valid session', async () => {
    const fixture = await backendFixture()
    const api = await fixture.gate.api(
      cookieRequest('GET', '/api/project-contexts', fixture.sessionCookie),
    )
    const page = await fixture.gate.page(
      cookieRequest('GET', '/projects/deep', fixture.sessionCookie),
    )
    const session = await fixture.gate.session(
      cookieRequest('GET', '/api/auth/session', fixture.sessionCookie),
    )

    for (const cookie of [
      decisionCookie(api),
      decisionCookie(page),
      session.setCookie,
    ]) {
      expect(cookie).toBe(fixture.renewalCookie)
      expect(cookie).not.toContain('Max-Age=0')
    }
  })

  it('denies a password-pending researcher differently per surface', async () => {
    const fixture = await backendFixture({ mustChangePassword: true })
    const api = await fixture.gate.api(
      cookieRequest('GET', '/api/project-contexts', fixture.sessionCookie),
    )
    const page = await fixture.gate.page(
      cookieRequest('GET', '/projects/deep', fixture.sessionCookie),
    )

    // ⚠ Commit 2 (plan §5.2) adds the renewal cookie to the API denial.
    expect(api).toEqual({
      verdict: 'deny',
      reason: 'passwordChangeRequired',
    })
    expect(page).toEqual({
      verdict: 'deny',
      reason: 'passwordChangeRequired',
      redirectTo: { path: '/change-password' },
      setCookie: fixture.renewalCookie,
    })
  })
})
