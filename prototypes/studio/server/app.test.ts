import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
  ResearcherProjectStore,
} from 'db'
import type { ServerResponse } from 'node:http'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  createResearcherApiHandlers as createProjectContextApiHandlers,
} from '../api/project_contexts.js'
import {
  createApiDispatcher,
  createApiHandlerRegistry,
  type ApiDispatcher,
} from './api-dispatcher.js'
import { validatePassword } from './password.js'
import {
  createLoginLimiter,
  type LoginLimiter,
} from './login-limiter.js'
import {
  createStudioApp,
  sendNodeResponse,
  GENERAL_API_REQUEST_LIMIT,
  type StudioApp,
  type StudioBindings,
} from './app.js'
import {
  createRequestPeerVerifier,
  loadStudioServerConfig,
} from './config.js'
import {
  createSessionManager,
  SESSION_IDLE_MILLISECONDS,
} from './session.js'

it('preserves separate Set-Cookie fields in the Node response adapter', async () => {
  const headers = new Headers()
  headers.append('Set-Cookie', 'session=first; Path=/; HttpOnly')
  headers.append('Set-Cookie', 'csrf=second; Path=/; Secure')
  const written = new Map<string, string | number | readonly string[]>()
  const outgoing = {
    statusCode: 0,
    setHeader(name: string, value: string | number | readonly string[]) {
      written.set(name, value)
      return this
    },
    end: vi.fn(),
  } as unknown as ServerResponse

  await sendNodeResponse(new Response(null, { status: 204, headers }), outgoing)

  expect(written.get('set-cookie')).toEqual([
    'session=first; Path=/; HttpOnly',
    'csrf=second; Path=/; Secure',
  ])
})

const ORIGIN = 'https://studio.example'
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001'
const EMAIL = 'researcher@example.org'
const TEMPORARY_PASSWORD = 'temporary password 123'
const REPLACEMENT_PASSWORD = 'replacement password 456'
const SECRET = Buffer.alloc(32, 9)
const CLIENT = { clientAddress: '192.0.2.10' }

type Fixture = {
  app: StudioApp
  account(): ResearcherAccountRecord
  updateAccount(update: Partial<ResearcherAccountRecord>): void
  store: ResearcherAccountStore
  dispatcher: Mock<ApiDispatcher>
  researcherProjectStore: Mock<
    (researcherAccountId: string) => ResearcherProjectStore
  >
  clientHandler: Mock<(request: Request) => Promise<Response>>
  verify: Mock<
    (password: string, representation: string) => Promise<boolean>
  >
}

type FixtureOptions = {
  basePath?: string
  mustChangePassword?: boolean
  disabled?: boolean
  now?: () => number
  limiter?: LoginLimiter
  apiDispatcher?: ApiDispatcher
  researcherProjectStore?: (
    researcherAccountId: string,
  ) => ResearcherProjectStore
  requestPeer?: (bindings: StudioBindings) => void
  viteDevelopmentAssets?: boolean
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  let account: ResearcherAccountRecord = {
    id: ACCOUNT_ID,
    email: EMAIL,
    passwordHash: `hash:${TEMPORARY_PASSWORD}`,
    mustChangePassword: options.mustChangePassword ?? false,
    disabledAt: options.disabled ? new Date('2026-08-20T00:00:00Z') : null,
    sessionVersion: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  }
  const store: ResearcherAccountStore = {
    create: vi.fn(async () => account),
    findByEmail: vi.fn(async (email) =>
      email.trim().toLowerCase() === account.email ? account : null,
    ),
    findById: vi.fn(async (id) => (id === account.id ? account : null)),
    replacePassword: vi.fn(
      async (
        id,
        expectedSessionVersion,
        passwordHash,
        mustChangePassword,
      ) => {
        if (
          id !== account.id ||
          expectedSessionVersion !== account.sessionVersion
        )
          return null
        account = {
          ...account,
          passwordHash,
          mustChangePassword,
          sessionVersion: account.sessionVersion + 1,
          updatedAt: new Date(account.updatedAt.getTime() + 1),
        }
        return account
      },
    ),
    disable: vi.fn(async (id, disabledAt = new Date()) => {
      if (id !== account.id) return null
      account = {
        ...account,
        disabledAt,
        sessionVersion: account.sessionVersion + 1,
      }
      return account
    }),
  }
  const verify = vi.fn(async (password: string, representation: string) =>
    representation === `hash:${password}`,
  )
  const defaultDispatcher: ApiDispatcher = async (request) => {
    const pathname = new URL(request.url).pathname
    return Response.json({ protected: pathname })
  }
  const dispatcher = vi.fn(options.apiDispatcher ?? defaultDispatcher)
  const researcherProjectStore = vi.fn(
    options.researcherProjectStore ??
      ((researcherAccountId: string) =>
        ({ researcherAccountId }) as ResearcherProjectStore),
  )
  const clientHandler = vi.fn(async () => new Response('studio-client'))
  const app = await createStudioApp({
    studioOrigin: ORIGIN,
    basePath: options.basePath ?? '/',
    sessionSecret: SECRET,
    accountStore: store,
    limiter: options.limiter,
    now: options.now,
    apiDispatcher: dispatcher,
    researcherProjectStore,
    clientHandler,
    viteDevelopmentAssets: options.viteDevelopmentAssets,
    requestPeer: options.requestPeer,
    dummyPasswordHash: 'hash:dummy password verification',
    passwords: {
      validate: validatePassword,
      hash: async (password) => {
        validatePassword(password)
        return `hash:${password}`
      },
      verify,
    },
  })
  return {
    app,
    account: () => account,
    updateAccount(update) {
      account = { ...account, ...update }
    },
    store,
    dispatcher,
    researcherProjectStore,
    clientHandler,
    verify,
  }
}

function cookie(response: Response): string {
  const setCookie = response.headers.get('set-cookie')
  if (!setCookie) throw new Error('Expected a session cookie.')
  return setCookie.split(';', 1)[0]
}

async function login(
  app: StudioApp,
  email = EMAIL,
  password = TEMPORARY_PASSWORD,
): Promise<Response> {
  return app.request(
    `${ORIGIN}/api/auth/login`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email, password }),
    },
    CLIENT,
  )
}

async function session(app: StudioApp, sessionCookie?: string): Promise<Response> {
  return app.request(
    `${ORIGIN}/api/auth/session`,
    sessionCookie ? { headers: { cookie: sessionCookie } } : undefined,
    CLIENT,
  )
}

async function errorBody(response: Response) {
  return response.json() as Promise<{
    error: { code: string; message: string }
  }>
}

describe('authentication routes', () => {
  it('logs in an active account and exposes only the bounded session view', async () => {
    const { app, verify } = await fixture()
    const response = await login(app, ' Researcher@Example.ORG ')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      account: {
        id: ACCOUNT_ID,
        email: EMAIL,
        mustChangePassword: false,
      },
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
    const setCookie = response.headers.get('set-cookie')!
    expect(setCookie).toContain('Secure')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(verify).toHaveBeenCalledWith(
      TEMPORARY_PASSWORD,
      `hash:${TEMPORARY_PASSWORD}`,
    )
  })

  it('uses one generic failure for unknown, wrong-password, and disabled accounts', async () => {
    const unknown = await fixture()
    const wrong = await fixture()
    const disabled = await fixture({ disabled: true })

    const responses = [
      await login(unknown.app, 'unknown@example.org', TEMPORARY_PASSWORD),
      await login(wrong.app, EMAIL, 'incorrect password 123'),
      await login(disabled.app, EMAIL, TEMPORARY_PASSWORD),
    ]
    const expected = {
      error: {
        code: 'invalid_credentials',
        message: 'Email or password is incorrect.',
      },
    }
    for (const response of responses) {
      expect(response.status).toBe(401)
      await expect(response.json()).resolves.toEqual(expected)
    }
    expect(unknown.verify).toHaveBeenCalledWith(
      TEMPORARY_PASSWORD,
      'hash:dummy password verification',
    )
    expect(disabled.verify).toHaveBeenCalledWith(
      TEMPORARY_PASSWORD,
      'hash:dummy password verification',
    )
  })

  it('limits before another expensive verification and returns Retry-After', async () => {
    const limiter = createLoginLimiter({
      emailMaxFailures: 1,
      addressMaxFailures: 1,
      windowMilliseconds: 30_000,
      maxEntries: 8,
    })
    const { app, verify } = await fixture({ limiter })

    expect((await login(app, EMAIL, 'incorrect password 123')).status).toBe(401)
    const calls = verify.mock.calls.length
    const throttled = await login(app, EMAIL, 'incorrect password 123')
    expect(throttled.status).toBe(429)
    expect(throttled.headers.get('retry-after')).toBe('30')
    await expect(errorBody(throttled)).resolves.toEqual({
      error: {
        code: 'too_many_attempts',
        message: 'Too many login attempts. Try again later.',
      },
    })
    expect(verify).toHaveBeenCalledTimes(calls)
  })

  it('forces replacement, revokes the temporary cookie, and requires a new login', async () => {
    const test = await fixture({ mustChangePassword: true })
    const loggedIn = await login(test.app)
    const temporaryCookie = cookie(loggedIn)

    const protectedApi = await test.app.request(
      `${ORIGIN}/api/project-contexts`,
      { headers: { cookie: temporaryCookie } },
      CLIENT,
    )
    expect(protectedApi.status).toBe(403)
    await expect(errorBody(protectedApi)).resolves.toMatchObject({
      error: { code: 'password_change_required' },
    })
    expect(test.dispatcher).not.toHaveBeenCalled()
    expect(test.researcherProjectStore).not.toHaveBeenCalled()

    const navigation = await test.app.request(
      `${ORIGIN}/projects/${ACCOUNT_ID}`,
      { headers: { cookie: temporaryCookie } },
      CLIENT,
    )
    expect(navigation.status).toBe(302)
    expect(navigation.headers.get('location')).toBe('/change-password')

    await expect((await session(test.app, temporaryCookie)).json()).resolves.toEqual({
      authenticated: true,
      account: {
        id: ACCOUNT_ID,
        email: EMAIL,
        mustChangePassword: true,
      },
    })

    const changed = await test.app.request(
      `${ORIGIN}/api/auth/password`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: temporaryCookie,
          origin: ORIGIN,
        },
        body: JSON.stringify({
          currentPassword: TEMPORARY_PASSWORD,
          newPassword: REPLACEMENT_PASSWORD,
        }),
      },
      CLIENT,
    )
    expect(changed.status).toBe(204)
    expect(changed.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(test.account()).toMatchObject({
      passwordHash: `hash:${REPLACEMENT_PASSWORD}`,
      mustChangePassword: false,
      sessionVersion: 1,
    })

    await expect((await session(test.app, temporaryCookie)).json()).resolves.toEqual({
      authenticated: false,
    })
    const normalLogin = await login(test.app, EMAIL, REPLACEMENT_PASSWORD)
    expect(normalLogin.status).toBe(200)
    await expect(normalLogin.json()).resolves.toMatchObject({
      authenticated: true,
      account: { mustChangePassword: false },
    })
    const allowed = await test.app.request(
      `${ORIGIN}/api/project-contexts`,
      { headers: { cookie: cookie(normalLogin) } },
      CLIENT,
    )
    expect(allowed.status).toBe(200)
    await expect(allowed.json()).resolves.toEqual({
      protected: '/api/project-contexts',
    })
    expect(test.dispatcher).toHaveBeenCalledOnce()
  })

  it('rejects an invalid replacement without changing password authority', async () => {
    const test = await fixture({ mustChangePassword: true })
    const temporaryCookie = cookie(await login(test.app))
    const before = test.account()
    const response = await test.app.request(
      `${ORIGIN}/api/auth/password`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: temporaryCookie,
          origin: ORIGIN,
        },
        body: JSON.stringify({
          currentPassword: TEMPORARY_PASSWORD,
          newPassword: 'short',
        }),
      },
      CLIENT,
    )

    expect(response.status).toBe(400)
    await expect(errorBody(response)).resolves.toEqual({
      error: {
        code: 'invalid_password',
        message: 'Password must contain between 6 and 128 Unicode characters.',
      },
    })
    expect(test.account()).toEqual(before)
    expect(test.store.replacePassword).not.toHaveBeenCalled()
  })

  it('cannot overwrite an operator reset that races password change', async () => {
    const test = await fixture({ mustChangePassword: true })
    const temporaryCookie = cookie(await login(test.app))
    test.verify.mockImplementationOnce(async () => {
      test.updateAccount({
        passwordHash: 'hash:operator reset password',
        sessionVersion: 1,
        mustChangePassword: true,
      })
      return true
    })

    const response = await test.app.request(
      `${ORIGIN}/api/auth/password`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: temporaryCookie,
          origin: ORIGIN,
        },
        body: JSON.stringify({
          currentPassword: TEMPORARY_PASSWORD,
          newPassword: REPLACEMENT_PASSWORD,
        }),
      },
      CLIENT,
    )

    expect(response.status).toBe(401)
    expect(test.account()).toMatchObject({
      passwordHash: 'hash:operator reset password',
      sessionVersion: 1,
      mustChangePassword: true,
    })
    expect(test.store.replacePassword).toHaveBeenCalledWith(
      ACCOUNT_ID,
      0,
      `hash:${REPLACEMENT_PASSWORD}`,
      false,
    )
  })

  it('requires authentication for logout and clears an authenticated browser', async () => {
    const { app } = await fixture()
    const unauthenticated = await app.request(
      `${ORIGIN}/api/auth/logout`,
      { method: 'POST', headers: { origin: ORIGIN } },
      CLIENT,
    )
    expect(unauthenticated.status).toBe(401)

    const activeCookie = cookie(await login(app))
    const loggedOut = await app.request(
      `${ORIGIN}/api/auth/logout`,
      {
        method: 'POST',
        headers: { cookie: activeCookie, origin: ORIGIN },
      },
      CLIENT,
    )
    expect(loggedOut.status).toBe(204)
    expect(loggedOut.headers.get('set-cookie')).toContain('Max-Age=0')
    await expect((await session(app)).json()).resolves.toEqual({
      authenticated: false,
    })
  })
})

describe('session invalidation and renewal', () => {
  it('rejects tampering, account version changes, and disablement', async () => {
    const tamperTest = await fixture()
    const activeCookie = cookie(await login(tamperTest.app))
    const last = activeCookie.at(-1)!
    const tampered = `${activeCookie.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
    const tamperedResponse = await session(tamperTest.app, tampered)
    expect(tamperedResponse.status).toBe(200)
    await expect(tamperedResponse.json()).resolves.toEqual({ authenticated: false })
    expect(tamperedResponse.headers.get('set-cookie')).toContain('Max-Age=0')

    const versionTest = await fixture()
    const versionCookie = cookie(await login(versionTest.app))
    versionTest.updateAccount({ sessionVersion: 1 })
    await expect((await session(versionTest.app, versionCookie)).json()).resolves.toEqual({
      authenticated: false,
    })
    const revokedApi = await versionTest.app.request(
      `${ORIGIN}/api/project-contexts`,
      { headers: { cookie: versionCookie } },
      CLIENT,
    )
    expect(revokedApi.status).toBe(401)
    expect(versionTest.researcherProjectStore).not.toHaveBeenCalled()
    expect(versionTest.dispatcher).not.toHaveBeenCalled()

    const disabledTest = await fixture()
    const disabledCookie = cookie(await login(disabledTest.app))
    disabledTest.updateAccount({ disabledAt: new Date() })
    await expect((await session(disabledTest.app, disabledCookie)).json()).resolves.toEqual({
      authenticated: false,
    })
  })

  it('expires idle cookies but renews authenticated activity within the absolute bound', async () => {
    const issuedAt = Date.UTC(2026, 7, 20)
    let time = issuedAt
    const test = await fixture({ now: () => time })
    const original = cookie(await login(test.app))

    time += 60 * 60 * 1_000
    const inspected = await session(test.app, original)
    const renewed = cookie(inspected)
    expect(renewed).not.toBe(original)

    time = issuedAt + SESSION_IDLE_MILLISECONDS + 30 * 60 * 1_000
    await expect((await session(test.app, original)).json()).resolves.toEqual({
      authenticated: false,
    })
    await expect((await session(test.app, renewed)).json()).resolves.toMatchObject({
      authenticated: true,
    })
  })
})

describe('deny-by-default application boundary', () => {
  it('keeps health and required client assets public but blocks API handlers and navigation', async () => {
    const test = await fixture()

    const health = await test.app.request(`${ORIGIN}/api/healthz`, undefined, CLIENT)
    expect(health.status).toBe(200)
    await expect(health.json()).resolves.toEqual({ status: 'ok' })
    expect(test.dispatcher).not.toHaveBeenCalled()
    expect(test.researcherProjectStore).not.toHaveBeenCalled()

    const protectedApi = await test.app.request(
      `${ORIGIN}/api/project-contexts`,
      undefined,
      CLIENT,
    )
    expect(protectedApi.status).toBe(401)
    await expect(errorBody(protectedApi)).resolves.toEqual({
      error: {
        code: 'authentication_required',
        message: 'Authentication is required.',
      },
    })
    expect(test.dispatcher).not.toHaveBeenCalled()
    expect(test.researcherProjectStore).not.toHaveBeenCalled()

    const navigation = await test.app.request(
      `${ORIGIN}/projects/${ACCOUNT_ID}?tab=sources`,
      undefined,
      CLIENT,
    )
    expect(navigation.status).toBe(302)
    expect(navigation.headers.get('location')).toBe(
      `/login?returnTo=%2Fprojects%2F${ACCOUNT_ID}%3Ftab%3Dsources`,
    )
    expect(test.clientHandler).not.toHaveBeenCalled()

    for (const path of [
      '/login',
      '/assets/application.js',
      '/favicon.png',
    ]) {
      const asset = await test.app.request(`${ORIGIN}${path}`, undefined, CLIENT)
      expect(asset.status).toBe(200)
      expect(await asset.text()).toBe('studio-client')
    }
  })

  it('mounts every route beneath one configured public base path', async () => {
    const test = await fixture({ basePath: '/free' })

    for (const path of ['/api/healthz', '/free-adjacent/api/healthz'])
      expect(
        (await test.app.request(`${ORIGIN}${path}`, undefined, CLIENT)).status,
      ).toBe(404)

    const health = await test.app.request(
      `${ORIGIN}/free/api/healthz`,
      undefined,
      CLIENT,
    )
    expect(health.status).toBe(200)

    const loginPage = await test.app.request(
      `${ORIGIN}/free/login`,
      undefined,
      CLIENT,
    )
    expect(loginPage.status).toBe(200)
    const handledRequest = test.clientHandler.mock.calls[0][0] as Request
    expect(new URL(handledRequest.url).pathname).toBe('/login')

    const navigation = await test.app.request(
      `${ORIGIN}/free/projects/${ACCOUNT_ID}?tab=sources`,
      undefined,
      CLIENT,
    )
    expect(navigation.status).toBe(302)
    expect(navigation.headers.get('location')).toBe(
      `/free/login?returnTo=%2Fprojects%2F${ACCOUNT_ID}%3Ftab%3Dsources`,
    )

    const authenticated = await test.app.request(
      `${ORIGIN}/free/api/auth/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ email: EMAIL, password: TEMPORARY_PASSWORD }),
      },
      CLIENT,
    )
    expect(authenticated.status).toBe(200)
    expect(authenticated.headers.get('set-cookie')).toContain('Path=/free')
  })

  it('exposes only the anonymous authentication graph through the Vite development bridge', async () => {
    const production = await fixture()
    for (const path of [
      '/shared/projectContext.contract.ts',
      '/src/ProjectNavigation.tsx',
      '/@fs/workspace/source.ts',
    ]) {
      const response = await production.app.request(
        `${ORIGIN}${path}`,
        undefined,
        CLIENT,
      )
      expect(response.status).toBe(302)
    }
    expect(production.clientHandler).not.toHaveBeenCalled()

    const development = await fixture({ viteDevelopmentAssets: true })
    for (const path of [
      '/src/main.tsx',
      '/src/auth/AuthApplication.tsx',
      '/src/llmInspector/mount.tsx',
      '/src/ui/Button.tsx',
      '/src/studioUrl.ts',
      '/shared/studioBasePath.ts',
      '/src/index.css',
      '/node_modules/.vite/deps/react.js',
      '/@fs/D:/workspace/node_modules/react/index.js',
      '/shared/authSession.contract.ts'
    ]) {
      const response = await development.app.request(
        `${ORIGIN}${path}`,
        undefined,
        CLIENT,
      )
      expect(response.status).toBe(200)
    }
    for (const path of [
      '/shared/projectContext.contract.ts',
      '/src/ProjectNavigation.tsx',
      '/@fs/workspace/source.ts',
      '/@fs/D:/workspace/node_modules/../private-source.ts',
      '/@fs/D:/workspace/node_modules/%2e%2e/private-source.ts',
      '/@fs/D:/workspace/node_modules/%252e%252e/private-source.ts',
      '/node_modules/react/index.js',
    ]) {
      const response = await development.app.request(
        `${ORIGIN}${path}`,
        undefined,
        CLIENT,
      )
      expect(response.status).toBe(302)
    }
    expect(development.clientHandler).toHaveBeenCalledTimes(10)
  })

  it('creates a distinct scoped store from each reloaded account', async () => {
    const secondAccountId = '20000000-0000-4000-8000-000000000002'
    const accounts: ResearcherAccountRecord[] = [
      {
        id: ACCOUNT_ID,
        email: EMAIL,
        passwordHash: 'unused',
        mustChangePassword: false,
        disabledAt: null,
        sessionVersion: 0,
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-01T00:00:00Z'),
      },
      {
        id: secondAccountId,
        email: 'second@example.org',
        passwordHash: 'unused',
        mustChangePassword: false,
        disabledAt: null,
        sessionVersion: 0,
        createdAt: new Date('2026-08-02T00:00:00Z'),
        updatedAt: new Date('2026-08-02T00:00:00Z'),
      },
    ]
    const findById = vi.fn(async (id: string) =>
      accounts.find((account) => account.id === id) ?? null,
    )
    const accountStore: ResearcherAccountStore = {
      create: vi.fn(async () => accounts[0]),
      findByEmail: vi.fn(async (email) =>
        accounts.find((account) => account.email === email) ?? null,
      ),
      findById,
      replacePassword: vi.fn(async () => null),
      disable: vi.fn(async () => null),
    }
    const scopedStores: ResearcherProjectStore[] = []
    const researcherProjectStore = vi.fn((researcherAccountId: string) => {
      const store = { researcherAccountId } as ResearcherProjectStore
      scopedStores.push(store)
      return store
    })
    const dispatcher = vi.fn(
      async (_request: Request, store: ResearcherProjectStore) =>
        Response.json({ researcherAccountId: store.researcherAccountId }),
    )
    const time = Date.UTC(2026, 7, 20)
    const app = await createStudioApp({
      studioOrigin: ORIGIN,
      basePath: '/',
      sessionSecret: SECRET,
      accountStore,
      researcherProjectStore,
      apiDispatcher: dispatcher,
      now: () => time,
      dummyPasswordHash: 'unused',
    })
    const sessions = createSessionManager(SECRET, () => time)
    const accountCookie = (account: ResearcherAccountRecord) =>
      sessions
        .serialize(sessions.issue(account.id, account.sessionVersion))
        .split(';', 1)[0]

    for (const account of accounts) {
      const response = await app.request(
        `${ORIGIN}/api/project-contexts`,
        {
          headers: {
            cookie: accountCookie(account),
            'x-researcher-account-id':
              account.id === ACCOUNT_ID ? secondAccountId : ACCOUNT_ID,
          },
        },
        CLIENT,
      )
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toEqual({
        researcherAccountId: account.id,
      })
    }

    expect(findById.mock.calls).toEqual([[ACCOUNT_ID], [secondAccountId]])
    expect(researcherProjectStore.mock.calls).toEqual([
      [ACCOUNT_ID],
      [secondAccountId],
    ])
    expect(findById.mock.invocationCallOrder[0]).toBeLessThan(
      researcherProjectStore.mock.invocationCallOrder[0],
    )
    expect(findById.mock.invocationCallOrder[1]).toBeLessThan(
      researcherProjectStore.mock.invocationCallOrder[1],
    )
    expect(scopedStores).toHaveLength(2)
    expect(scopedStores[0]).not.toBe(scopedStores[1])
    expect(dispatcher.mock.calls[0][1]).toBe(scopedStores[0])
    expect(dispatcher.mock.calls[1][1]).toBe(scopedStores[1])
  })

  it('carries one authenticated browser session through real project handlers and a deep link', async () => {
    const createdAt = new Date('2026-08-20T06:00:00Z')
    const projects: Array<{
      projectContextId: string
      name: string
      createdAt: Date
    }> = []
    const projectStore = {
      researcherAccountId: ACCOUNT_ID,
      async createProjectContext(name: string) {
        const project = {
          projectContextId: ACCOUNT_ID,
          name,
          createdAt,
        }
        projects.push(project)
        return project
      },
      async listProjectContexts(limit: number) {
        return projects.slice(0, limit)
      },
      async getProjectContextWithDocuments(projectContextId: string) {
        const projectContext =
          projects.find(
            (project) => project.projectContextId === projectContextId,
          ) ?? null
        return projectContext
          ? { projectContext, sourceDocuments: [] }
          : null
      },
      async renameProjectContext(projectContextId: string, name: string) {
        const project =
          projects.find(
            (candidate) => candidate.projectContextId === projectContextId,
          ) ?? null
        if (project) project.name = name
        return project
      },
      async deleteProjectContext(projectContextId: string) {
        const index = projects.findIndex(
          (project) => project.projectContextId === projectContextId,
        )
        if (index < 0) return false
        projects.splice(index, 1)
        return true
      },
    }
    const scopedProjectStore = projectStore as ResearcherProjectStore
    const apiDispatcher = createApiDispatcher(
      createApiHandlerRegistry({
        '../api/project_contexts.ts': {
          createResearcherApiHandlers: createProjectContextApiHandlers,
        },
      }),
    )
    const test = await fixture({
      apiDispatcher,
      researcherProjectStore: () => scopedProjectStore,
    })
    const sessionCookie = cookie(await login(test.app))

    const created = await test.app.request(
      `${ORIGIN}/api/project-contexts`,
      {
        method: 'POST',
        headers: {
          cookie: sessionCookie,
          'content-type': 'application/json',
          origin: ORIGIN,
        },
        body: JSON.stringify({ name: 'Authenticated project' }),
      },
      CLIENT,
    )
    expect(created.status).toBe(201)
    await expect(created.json()).resolves.toMatchObject({
      projectContext: {
        projectContextId: ACCOUNT_ID,
        name: 'Authenticated project',
      },
    })

    const list = await test.app.request(
      `${ORIGIN}/api/project-contexts`,
      { headers: { cookie: sessionCookie } },
      CLIENT,
    )
    expect(list.status).toBe(200)
    await expect(list.json()).resolves.toMatchObject({
      projectContexts: [{ projectContextId: ACCOUNT_ID }],
    })

    const detail = await test.app.request(
      `${ORIGIN}/api/project-contexts/${ACCOUNT_ID}`,
      { headers: { cookie: sessionCookie } },
      CLIENT,
    )
    expect(detail.status).toBe(200)
    await expect(detail.json()).resolves.toMatchObject({
      projectContext: { projectContextId: ACCOUNT_ID },
      sourceDocuments: [],
    })

    const deepLink = await test.app.request(
      `${ORIGIN}/projects/${ACCOUNT_ID}`,
      { headers: { cookie: sessionCookie } },
      CLIENT,
    )
    expect(deepLink.status).toBe(200)
    expect(await deepLink.text()).toBe('studio-client')
  })

  it('rejects unsafe cross-origin requests before authentication or dispatch', async () => {
    const test = await fixture()
    for (const origin of [undefined, 'https://attacker.example']) {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      }
      if (origin) headers.origin = origin
      const response = await test.app.request(
        `${ORIGIN}/api/auth/login`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            email: EMAIL,
            password: TEMPORARY_PASSWORD,
          }),
        },
        CLIENT,
      )
      expect(response.status).toBe(403)
      await expect(errorBody(response)).resolves.toMatchObject({
        error: { code: 'origin_rejected' },
      })
    }
    expect(test.store.findByEmail).not.toHaveBeenCalled()
    expect(test.verify).not.toHaveBeenCalled()
    expect(test.dispatcher).not.toHaveBeenCalled()
  })

  it('authenticates before body admission and protected API dispatch', async () => {
    const test = await fixture()
    const path = `/api/project-contexts/${ACCOUNT_ID}/source-documents`
    const oversized = String(51 * 1024 * 1024 + 1)

    const denied = await test.app.request(
      `${ORIGIN}${path}`,
      {
        method: 'POST',
        headers: {
          'content-length': oversized,
          'content-type': 'application/octet-stream',
          origin: ORIGIN,
        },
        body: 'x',
      },
      CLIENT,
    )
    expect(denied.status).toBe(401)
    expect(test.dispatcher).not.toHaveBeenCalled()
    expect(test.researcherProjectStore).not.toHaveBeenCalled()

    const activeCookie = cookie(await login(test.app))
    const bounded = await test.app.request(
      `${ORIGIN}${path}`,
      {
        method: 'POST',
        headers: {
          'content-length': oversized,
          'content-type': 'application/octet-stream',
          cookie: activeCookie,
          origin: ORIGIN,
        },
        body: 'x',
      },
      CLIENT,
    )
    expect(bounded.status).toBe(413)
    await expect(errorBody(bounded)).resolves.toMatchObject({
      error: { code: 'invalid_request' },
    })
    expect(test.dispatcher).not.toHaveBeenCalled()
    expect(test.researcherProjectStore).not.toHaveBeenCalled()
  })
  it('applies the general API body limit before route handlers', async () => {
    const test = await fixture()
    const oversized = String(GENERAL_API_REQUEST_LIMIT + 1)
    const rejectedLogin = await test.app.request(
      `${ORIGIN}/api/auth/login`,
      {
        method: 'POST',
        headers: {
          'content-length': oversized,
          'content-type': 'application/json',
          origin: ORIGIN,
        },
        body: '{}',
      },
      CLIENT,
    )
    expect(rejectedLogin.status).toBe(413)
    expect(test.store.findByEmail).not.toHaveBeenCalled()
    expect(test.verify).not.toHaveBeenCalled()

    const activeCookie = cookie(await login(test.app))
    const rejectedProject = await test.app.request(
      `${ORIGIN}/api/project-contexts`,
      {
        method: 'POST',
        headers: {
          'content-length': oversized,
          'content-type': 'application/json',
          cookie: activeCookie,
          origin: ORIGIN,
        },
        body: '{}',
      },
      CLIENT,
    )
    expect(rejectedProject.status).toBe(413)
    await expect(errorBody(rejectedProject)).resolves.toMatchObject({
      error: { code: 'invalid_request' },
    })
    expect(test.dispatcher).not.toHaveBeenCalled()
    expect(test.researcherProjectStore).not.toHaveBeenCalled()
  })

  it('returns exact JSON 404/405 responses and never falls through to the client', async () => {
    const getModelConfig = vi.fn(() => Response.json({ config: true }))
    const apiDispatcher = createApiDispatcher(
      createApiHandlerRegistry({
        '../api/model_config.ts': { GET: getModelConfig },
      }),
    )
    const test = await fixture({ apiDispatcher })
    const activeCookie = cookie(await login(test.app))

    for (const pathname of ['/api/unknown', '/api/llm_inspector']) {
      const response = await test.app.request(
        `${ORIGIN}${pathname}`,
        { headers: { cookie: activeCookie } },
        CLIENT,
      )
      expect(response.status).toBe(404)
      expect(response.headers.get('content-type')).toContain('application/json')
      await expect(errorBody(response)).resolves.toEqual({
        error: { code: 'not_found', message: 'API route not found.' },
      })
    }

    const wrongModelMethod = await test.app.request(
      `${ORIGIN}/api/model_config`,
      {
        method: 'POST',
        headers: { cookie: activeCookie, origin: ORIGIN },
      },
      CLIENT,
    )
    expect(wrongModelMethod.status).toBe(405)
    expect(wrongModelMethod.headers.get('allow')).toBe('GET')
    expect(getModelConfig).not.toHaveBeenCalled()

    const wrongAuthMethod = await test.app.request(
      `${ORIGIN}/api/auth/login`,
      { headers: { cookie: activeCookie } },
      CLIENT,
    )
    expect(wrongAuthMethod.status).toBe(405)
    expect(wrongAuthMethod.headers.get('allow')).toBe('POST')
    expect(test.clientHandler).not.toHaveBeenCalled()
  })

  it('rejects a direct hosted peer before routing, even with a spoofed header', async () => {
    const config = loadStudioServerConfig({
      STUDIO_ORIGIN: ORIGIN,
      STUDIO_BASE_PATH: '/',
      FREE_SESSION_SECRET: SECRET.toString('base64'),
      FREE_STUDIO_PROXY: 'trusted-proxy',
      FREE_STUDIO_PROXY_ADDRESS: '172.30.0.2',
    })
    const test = await fixture({
      requestPeer: createRequestPeerVerifier(config),
    })
    const bindings = (remoteAddress: string) =>
      ({
        incoming: {
          headers: { 'x-real-ip': '198.51.100.7' },
          socket: { remoteAddress },
        },
      }) as unknown as StudioBindings

    const bypass = await test.app.request(
      `${ORIGIN}/api/healthz`,
      undefined,
      bindings('172.30.0.9'),
    )
    expect(bypass.status).toBe(403)
    await expect(errorBody(bypass)).resolves.toMatchObject({
      error: { code: 'proxy_peer_rejected' },
    })
    expect(test.dispatcher).not.toHaveBeenCalled()
    expect(test.clientHandler).not.toHaveBeenCalled()

    const proxied = await test.app.request(
      `${ORIGIN}/api/healthz`,
      undefined,
      bindings('::ffff:172.30.0.2'),
    )
    expect(proxied.status).toBe(200)
    await expect(proxied.json()).resolves.toEqual({ status: 'ok' })
  })

})

describe('session gate characterization', () => {
  async function send(
    app: StudioApp,
    method: string,
    path: string,
    sessionCookie?: string,
  ): Promise<Response> {
    const headers: Record<string, string> = { origin: ORIGIN }
    if (sessionCookie) headers.cookie = sessionCookie
    return app.request(`${ORIGIN}${path}`, { method, headers }, CLIENT)
  }

  function tamper(sessionCookie: string): string {
    const last = sessionCookie.at(-1)!
    return `${sessionCookie.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`
  }

  function renewed(response: Response): string {
    const setCookie = response.headers.get('set-cookie')
    if (!setCookie) throw new Error('Expected a renewal cookie.')
    expect(setCookie).not.toContain('Max-Age=0')
    return setCookie
  }

  it('treats HEAD /api/healthz as protected because public routes are method-keyed (A2)', async () => {
    const anonymous = await fixture()
    const clean = await send(anonymous.app, 'HEAD', '/api/healthz')
    expect(clean.status).toBe(401)
    expect(clean.headers.get('set-cookie')).toBeNull()

    const stale = await send(
      anonymous.app,
      'HEAD',
      '/api/healthz',
      tamper(cookie(await login(anonymous.app))),
    )
    expect(stale.status).toBe(401)
    expect(stale.headers.get('set-cookie')).toContain('Max-Age=0')

    const active = await fixture()
    const authenticated = await send(
      active.app,
      'HEAD',
      '/api/healthz',
      cookie(await login(active.app)),
    )
    expect(authenticated.status).toBe(200)
    expect(await authenticated.text()).toBe('')
    renewed(authenticated)

    // The plan's Table A records 200 +R here; the guard denies because
    // /api/healthz is not a mandatory-change path, and the denial renews.
    const pending = await fixture({ mustChangePassword: true })
    const denied = await send(
      pending.app,
      'HEAD',
      '/api/healthz',
      cookie(await login(pending.app)),
    )
    expect(denied.status).toBe(403)
    expect(denied.headers.get('content-type')).toContain('application/json')
    expect(await denied.text()).toBe('')
    renewed(denied)
  })

  it('inspects twice for HEAD /api/auth/session and renews once (A6)', async () => {
    const test = await fixture()
    const activeCookie = cookie(await login(test.app))
    vi.mocked(test.store.findById).mockClear()

    const response = await send(
      test.app,
      'HEAD',
      '/api/auth/session',
      activeCookie,
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
    expect(response.headers.getSetCookie()).toHaveLength(1)
    renewed(response)
    expect(test.store.findById).toHaveBeenCalledTimes(2)

    const anonymous = await send(test.app, 'HEAD', '/api/auth/session')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('set-cookie')).toBeNull()
  })

  it('renews on wrong-method requests to handler-owned paths (A9, A11)', async () => {
    for (const path of ['/api/auth/password', '/api/auth/logout']) {
      const active = await fixture()
      const wrongMethod = await send(
        active.app,
        'GET',
        path,
        cookie(await login(active.app)),
      )
      expect(wrongMethod.status, path).toBe(405)
      expect(wrongMethod.headers.get('allow'), path).toBe('POST')
      // Suppression covers only the handler-owned POST pairs.
      renewed(wrongMethod)

      const pending = await fixture({ mustChangePassword: true })
      const whilePending = await send(
        pending.app,
        'GET',
        path,
        cookie(await login(pending.app)),
      )
      expect(whilePending.status, path).toBe(405)
      renewed(whilePending)
    }
  })

  it('renews while denying a password-pending researcher (A4, A12, A13)', async () => {
    const pending = await fixture({ mustChangePassword: true })
    const pendingCookie = cookie(await login(pending.app))
    for (const path of [
      '/api/auth/login',
      '/api/auth/unknown-operation',
      '/api/project-contexts',
    ]) {
      const response = await send(pending.app, 'GET', path, pendingCookie)
      expect(response.status, path).toBe(403)
      renewed(response)
      await expect(errorBody(response), path).resolves.toMatchObject({
        error: { code: 'password_change_required' },
      })
    }
    expect(pending.dispatcher).not.toHaveBeenCalled()

    const active = await fixture()
    const activeCookie = cookie(await login(active.app))
    const wrongMethod = await send(
      active.app,
      'GET',
      '/api/auth/login',
      activeCookie,
    )
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    renewed(wrongMethod)

    const unknownOperation = await send(
      active.app,
      'GET',
      '/api/auth/unknown-operation',
      activeCookie,
    )
    expect(unknownOperation.status).toBe(404)
    await expect(errorBody(unknownOperation)).resolves.toEqual({
      error: { code: 'not_found', message: 'API route not found.' },
    })
    renewed(unknownOperation)

    const dispatched = await send(
      active.app,
      'GET',
      '/api/project-contexts',
      activeCookie,
    )
    expect(dispatched.status).toBe(200)
    renewed(dispatched)
  })

  it('serves the login page for any method without touching the session (B2)', async () => {
    const test = await fixture()
    for (const method of ['GET', 'POST', 'DELETE']) {
      const response = await send(test.app, method, '/login')
      expect(response.status, method).toBe(200)
      expect(response.headers.get('set-cookie'), method).toBeNull()
    }
    expect(test.clientHandler).toHaveBeenCalledTimes(3)
    expect(test.store.findById).not.toHaveBeenCalled()

    const rejected = await send(test.app, 'POST', '/projects/anything')
    expect(rejected.status).toBe(404)
    await expect(errorBody(rejected)).resolves.toEqual({
      error: { code: 'not_found', message: 'Page not found.' },
    })
    expect(test.store.findById).not.toHaveBeenCalled()
  })

  it('redirects a password-pending page load without returnTo and with renewal (B4)', async () => {
    const pending = await fixture({ mustChangePassword: true })
    const response = await send(
      pending.app,
      'GET',
      `/projects/${ACCOUNT_ID}?tab=sources`,
      cookie(await login(pending.app)),
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/change-password')
    renewed(response)
    expect(pending.clientHandler).not.toHaveBeenCalled()

    const allowed = await send(
      pending.app,
      'GET',
      '/change-password',
      cookie(await login(pending.app)),
    )
    expect(allowed.status).toBe(200)
    expect(await allowed.text()).toBe('studio-client')
    renewed(allowed)
  })

  it('returns 503 without a cookie when the account store fails on any surface', async () => {
    for (const path of [
      '/api/auth/session',
      '/api/project-contexts',
      `/projects/${ACCOUNT_ID}`,
    ]) {
      const test = await fixture()
      const activeCookie = cookie(await login(test.app))
      vi.mocked(test.store.findById).mockRejectedValue(
        new Error('store unavailable'),
      )

      const response = await send(test.app, 'GET', path, activeCookie)
      expect(response.status, path).toBe(503)
      expect(response.headers.get('cache-control'), path).toBe('no-store')
      expect(response.headers.get('set-cookie'), path).toBeNull()
      await expect(errorBody(response), path).resolves.toEqual({
        error: {
          code: 'authentication_unavailable',
          message: 'Authentication is temporarily unavailable.',
        },
      })
      expect(test.clientHandler, path).not.toHaveBeenCalled()
      expect(test.dispatcher, path).not.toHaveBeenCalled()
    }
  })

  it('renewal survives handler failure once the gate has proceeded', async () => {
    const test = await fixture()
    const activeCookie = cookie(await login(test.app))

    // Returned error: the ordinary post-next() append applies.
    test.dispatcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'Missing.' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
    )
    const returned = await send(test.app, 'GET', '/api/project-contexts', activeCookie)
    expect(returned.status).toBe(404)
    renewed(returned)

    // Thrown error: onError resolves the response first, then middleware resumes
    // after next(), so the append still happens. Contrast the 503 test above,
    // where the failure throws inside the guard itself before any append.
    test.dispatcher.mockRejectedValueOnce(new Error('dispatch exploded'))
    const thrown = await send(test.app, 'GET', '/api/project-contexts', activeCookie)
    expect(thrown.status).toBe(500)
    await expect(errorBody(thrown)).resolves.toEqual({
      error: {
        code: 'unexpected_failure',
        message: 'An unexpected failure occurred.',
      },
    })
    renewed(thrown)
  })
})
