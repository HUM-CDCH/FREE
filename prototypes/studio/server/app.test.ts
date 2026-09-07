import { describe, expect, it, vi } from 'vitest'
import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
  ResearcherProjectStore,
} from 'db'
import { createStudioApp, type StudioApp } from './app.js'
import type { EntraIdentityProvider } from './entraIdentityProvider.js'
import { createInMemoryEntraIdentityProvider } from '../test/support/inMemoryEntraIdentityProvider.js'

const ORIGIN = 'https://studio.example'
const NOW = Date.parse('2026-08-26T18:00:00.000Z')
const SECRET = new TextEncoder().encode(
  '0123456789abcdef0123456789abcdef',
)
const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001'
const REQUESTED_OBJECT_ID = '20000000-0000-4000-8000-000000000002'

type Fixture = {
  app: StudioApp
  accountStore: ResearcherAccountStore
  findOrCreate: ReturnType<typeof vi.fn>
  dispatcher: ReturnType<typeof vi.fn>
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] }
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? '']
}

function cookie(response: Response, name: string): string {
  const serialized = setCookies(response).find((value) =>
    value.startsWith(`${name}=`),
  )
  if (!serialized) throw new Error(`Missing ${name} cookie.`)
  return serialized.split(';', 1)[0]
}

async function fixture(options: {
  basePath?: string
  identityProvider?: EntraIdentityProvider
  viteDevelopmentAssets?: boolean
} = {}): Promise<Fixture> {
  let account: ResearcherAccountRecord | null = null
  const findOrCreate = vi.fn(async (identity) => {
    const timestamp = new Date(NOW)
    account = {
      id: ACCOUNT_ID,
      tenantId: identity.tenantId,
      objectId: identity.objectId,
      displayName: identity.displayName,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    return account
  })
  const accountStore: ResearcherAccountStore = {
    findOrCreate,
    findById: vi.fn(async (id) => (account?.id === id ? account : null)),
  }
  const dispatcher = vi.fn(async (_request, store: ResearcherProjectStore) =>
    Response.json({
      researcherAccountId: (store as unknown as { id: string }).id,
    }),
  )
  const app = await createStudioApp({
    studioOrigin: ORIGIN,
    basePath: options.basePath ?? '/',
    sessionSecret: SECRET,
    now: () => NOW,
    accountStore,
    identityProvider:
      options.identityProvider ??
      createInMemoryEntraIdentityProvider({ now: () => NOW }),
    viteDevelopmentAssets: options.viteDevelopmentAssets,
    apiDispatcher: dispatcher,
    researcherProjectStore: (id) => ({ id }) as unknown as ResearcherProjectStore,
    clientHandler: (request) =>
      new Response(`client:${new URL(request.url).pathname}`, {
        headers: { 'content-type': 'text/plain' },
      }),
  })
  return { app, accountStore, findOrCreate, dispatcher }
}

async function signIn(
  test: Fixture,
  returnTo = '/projects/20000000-0000-4000-8000-000000000001?tab=source#selection',
  basePath = '',
  loginParameters: Record<string, string> = {},
) {
  const login = await test.app.request(
    `${ORIGIN}${basePath}/auth/login?${new URLSearchParams({
      returnTo,
      fragmentCaptured: '1',
      ...loginParameters,
    })}`,
  )
  expect(login.status).toBe(302)
  const transactionCookie = cookie(login, 'free_entra_transaction')
  const callback = await test.app.request(login.headers.get('location')!, {
    headers: { cookie: transactionCookie },
  })
  return {
    login,
    callback,
    transactionCookie,
    sessionCookie:
      callback.status === 302 ? cookie(callback, 'free_session') : null,
  }
}

describe('Source Document request admission', () => {
  it('admits a 100 MiB PDF multipart upload under /free and rejects an oversized envelope', async () => {
    const test = await fixture({ basePath: '/free' })
    const { sessionCookie } = await signIn(test, '/free', '/free')
    const url = `${ORIGIN}/free/api/project-contexts/${ACCOUNT_ID}/source-documents`
    const form = new FormData()
    form.append('file', new File(
      ['%PDF-', new Uint8Array(100 * 1024 * 1024 - 5)],
      'boundary.pdf',
      { type: 'application/pdf' },
    ))
    const accepted = await test.app.request(url, {
      method: 'POST',
      headers: { cookie: sessionCookie!, origin: ORIGIN },
      body: form,
    })
    expect(accepted.status).toBe(200)
    await expect(accepted.json()).resolves.toEqual({ researcherAccountId: ACCOUNT_ID })

    const rejected = await test.app.request(url, {
      method: 'POST',
      headers: {
        cookie: sessionCookie!,
        origin: ORIGIN,
        'content-length': String(101 * 1024 * 1024 + 1),
        'content-type': 'multipart/form-data; boundary=test',
      },
      body: '',
    })
    expect(rejected.status).toBe(413)
  })
})

describe('Microsoft Entra authentication routes', () => {
  it('completes state/PKCE/nonce sign-in, JIT provisions, and creates a fixed session', async () => {
    const test = await fixture()
    const result = await signIn(test)

    expect(result.callback.status).toBe(302)
    expect(result.callback.headers.get('location')).toBe(
      '/projects/20000000-0000-4000-8000-000000000001?tab=source#selection',
    )
    expect(test.findOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: '00000000-0000-4000-8000-000000000001',
      objectId: '00000000-0000-4000-8000-000000000002',
      displayName: 'Development Researcher',
    }))

    const session = await test.app.request(`${ORIGIN}/api/auth/session`, {
      headers: { cookie: result.sessionCookie! },
    })
    expect(await session.json()).toEqual({
      authenticated: true,
      account: { id: ACCOUNT_ID, displayName: 'Development Researcher' },
      expiresAt: new Date(NOW + 8 * 60 * 60 * 1_000).toISOString(),
    })
    expect(session.headers.get('set-cookie')).toBeNull()

    const protectedRequest = await test.app.request(`${ORIGIN}/api/example`, {
      headers: { cookie: result.sessionCookie! },
    })
    expect(protectedRequest.status).toBe(200)
    expect(protectedRequest.headers.get('set-cookie')).toBeNull()
    expect(await protectedRequest.json()).toEqual({
      researcherAccountId: ACCOUNT_ID,
    })
  })

  it('ignores request-selected identities and uses the configured provider', async () => {
    const test = await fixture()
    await signIn(test, '/projects', '', {
      testIdentity: REQUESTED_OBJECT_ID,
    })

    expect(test.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        objectId: '00000000-0000-4000-8000-000000000002',
      }),
    )
  })

  it('compares the returned nonce itself and refuses callback replay without the transaction', async () => {
    const delegate = createInMemoryEntraIdentityProvider({ now: () => NOW })
    const wrongNonce: EntraIdentityProvider = {
      ...delegate,
      async redeemAuthorizationCode(input) {
        return { ...(await delegate.redeemAuthorizationCode(input)), nonce: 'wrong' }
      },
    }
    const mismatch = await fixture({ identityProvider: wrongNonce })
    const rejected = await signIn(mismatch)
    expect(rejected.callback.status).toBe(400)
    expect(mismatch.findOrCreate).not.toHaveBeenCalled()

    const test = await fixture()
    const accepted = await signIn(test)
    const replay = await test.app.request(
      accepted.login.headers.get('location')!,
      { headers: { cookie: accepted.transactionCookie } },
    )
    expect(replay.status).toBe(400)
    expect(test.findOrCreate).toHaveBeenCalledTimes(1)
  })

  it('does not create a local account when Entra denies authorization', async () => {
    const test = await fixture()
    const login = await test.app.request(
      `${ORIGIN}/auth/login?fragmentCaptured=1`,
    )
    const denied = new URL(login.headers.get('location')!)
    denied.searchParams.set('error', 'access_denied')

    const callback = await test.app.request(denied, {
      headers: { cookie: cookie(login, 'free_entra_transaction') },
    })

    expect(callback.status).toBe(400)
    expect(test.findOrCreate).not.toHaveBeenCalled()
  })

  it('relays the browser fragment into returnTo before leaving for Entra', async () => {
    const test = await fixture()
    const response = await test.app.request(
      `${ORIGIN}/auth/login?${new URLSearchParams({
        returnTo: '/projects',
      })}`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('content-security-policy')).toMatch(
      /script-src 'sha256-[A-Za-z0-9+/=]+'/,
    )
    const page = await response.text()
    expect(page).toContain("returnTo + location.hash")
    expect(page).toContain("url.searchParams.set('fragmentCaptured', '1')")
    expect(page).toContain('<noscript>')
    expect(page).toContain(
      '/auth/login?returnTo=%2Fprojects&amp;fragmentCaptured=1',
    )
  })

  it('fails closed to /projects for unsafe and retired return targets', async () => {
    for (const returnTo of [
      'https://evil.example/',
      '//evil.example/',
      '/auth/signed-out?next=/projects',
      '/login?returnTo=/projects',
      '/free/projects',
    ]) {
      const test = await fixture()
      const result = await signIn(test, returnTo)
      expect(result.callback.headers.get('location')).toBe('/projects')
    }
  })

  it('clears the local session before redirecting through Entra logout', async () => {
    const test = await fixture()
    const signedIn = await signIn(test)
    const response = await test.app.request(`${ORIGIN}/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: signedIn.sessionCookie! },
    })
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe(`${ORIGIN}/auth/signed-out`)
    expect(setCookies(response)).toEqual([
      'free_entra_transaction=; Max-Age=0; Path=/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
      'free_session=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
      'free_signed_out=1; Path=/; HttpOnly; Secure; SameSite=Lax',
    ])
    const signedOutMarker = cookie(response, 'free_signed_out')
    expect(signedOutMarker).toBe('free_signed_out=1')
    const back = await test.app.request(`${ORIGIN}/projects`, {
      headers: { cookie: signedOutMarker },
    })
    expect(back.headers.get('location')).toBe('/auth/signed-out#')
  })
})

describe('authentication gate and route contract', () => {
  it('redirects protected pages, denies protected APIs, and keeps signed-out public', async () => {
    const test = await fixture()
    const page = await test.app.request(
      `${ORIGIN}/projects/abc?tab=source#selection`,
    )
    expect(page.status).toBe(302)
    expect(page.headers.get('location')).toBe(
      '/auth/login?returnTo=%2Fprojects%2Fabc%3Ftab%3Dsource',
    )

    const api = await test.app.request(`${ORIGIN}/api/example`)
    expect(api.status).toBe(401)
    expect(await api.json()).toMatchObject({
      error: { code: 'authentication_required' },
    })

    const signedOut = await test.app.request(`${ORIGIN}/auth/signed-out`)
    expect(signedOut.status).toBe(200)
    expect(await signedOut.text()).toBe('client:/auth/signed-out')
  })

  it('does not retain password-era pages or APIs', async () => {
    const test = await fixture()
    const signedIn = await signIn(test)
    for (const path of ['/login', '/change-password'])
      expect((await test.app.request(`${ORIGIN}${path}`)).status).toBe(404)
    for (const path of ['/api/auth/login', '/api/auth/password'])
      expect(
        (
          await test.app.request(`${ORIGIN}${path}`, {
            headers: { cookie: signedIn.sessionCookie! },
          })
        ).status,
      ).toBe(404)
    expect((await test.app.request(`${ORIGIN}/auth/logout`)).status).toBe(405)
  })

  it('keeps the signed-out authentication module graph public in Vite development', async () => {
    const test = await fixture({ viteDevelopmentAssets: true })

    const recoveryModule = await test.app.request(
      `${ORIGIN}/src/auth/sessionRecovery.ts`,
    )

    expect(recoveryModule.status).toBe(200)
    expect(recoveryModule.headers.get('location')).toBeNull()
    const returnPathModule = await test.app.request(
      `${ORIGIN}/shared/returnPath.ts`,
    )
    expect(returnPathModule.status).toBe(200)
    expect(returnPathModule.headers.get('location')).toBeNull()
  })

  it('uses exact base-path callback and post-logout redirect URIs', async () => {
    const test = await fixture({ basePath: '/free' })
    const projectPath =
      '/projects/20000000-0000-4000-8000-000000000001'
    const signedIn = await signIn(test, projectPath, '/free')
    expect(new URL(signedIn.login.headers.get('location')!).pathname).toBe(
      '/free/auth/callback',
    )
    expect(signedIn.callback.headers.get('location')).toBe(
      `/free${projectPath}`,
    )
    const prefixed = await signIn(test, '/free/projects', '/free')
    expect(prefixed.callback.headers.get('location')).toBe('/free/projects')
    const logout = await test.app.request(`${ORIGIN}/free/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: signedIn.sessionCookie! },
    })
    expect(logout.headers.get('location')).toBe(
      `${ORIGIN}/free/auth/signed-out`,
    )
  })
})
