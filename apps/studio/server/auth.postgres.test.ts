import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createResearcherAccountStore, db, pool, type ResearcherProjectStore } from 'db'
import { createStudioApp, type StudioApp } from './app.js'
import { createInMemoryEntraIdentityProvider } from '../test/support/inMemoryEntraIdentityProvider.js'
import { disposableDatabaseUrl } from '../test/support/postgres.js'

disposableDatabaseUrl()
const ORIGIN = 'https://studio.example'
const SECRET = new TextEncoder().encode('0123456789abcdef0123456789abcdef')
const HOUR = 60 * 60 * 1_000
const accounts: string[] = []
afterAll(async () => {
  try { for (const id of accounts) await db.orm.public.ResearcherAccount.where({ id }).delete() }
  finally { await db.close(); await pool.end() }
})

/** One Studio app in this test process: its own authentication backend and key custody on the shared database. */
async function studio(clock: { time: number }, identity: { tenantId: string; objectId: string }): Promise<StudioApp> {
  return createStudioApp({
    studioOrigin: ORIGIN,
    basePath: '/',
    sessionSecret: SECRET,
    now: () => clock.time,
    identityProvider: createInMemoryEntraIdentityProvider({ ...identity, displayName: 'Revocation', now: () => clock.time }),
    apiDispatcher: async (_request, store) => Response.json({ account: (store as unknown as { id: string }).id }),
    researcherProjectStore: (id) => ({ id }) as unknown as ResearcherProjectStore,
    modelKeys: { bootId: randomUUID(), keys: { forgetAccount: vi.fn() } },
  })
}

async function signIn(app: StudioApp): Promise<string> {
  const login = await app.request(`${ORIGIN}/auth/login?fragmentCaptured=1`)
  const transaction = login.headers.getSetCookie().find((cookie) => cookie.startsWith('free_entra_transaction='))!
  const callback = await app.request(login.headers.get('location')!, { headers: { cookie: transaction.split(';', 1)[0] } })
  expect(callback.status).toBe(302)
  const session = callback.headers.getSetCookie().find((cookie) => cookie.startsWith('free_session='))!
  return session.split(';', 1)[0]
}

const signOut = (app: StudioApp, cookie: string) =>
  app.request(`${ORIGIN}/auth/logout`, { method: 'POST', headers: { origin: ORIGIN, cookie } })

async function denied(app: StudioApp, cookie: string): Promise<boolean> {
  const read = await app.request(`${ORIGIN}/api/example`, { headers: { cookie } })
  const write = await app.request(`${ORIGIN}/api/example`, {
    method: 'POST',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: '{}',
  })
  const handoff = await app.request(`${ORIGIN}/api/model-keys`, {
    method: 'PUT',
    headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ account: randomUUID(), keys: {} }),
  })
  const session = await app.request(`${ORIGIN}/api/auth/session`, { headers: { cookie } })
  const answers = [read, write, handoff, session]
  // A refused copy never clears a cookie: the browser may hold a newer session.
  expect(answers.flatMap((answer) => answer.headers.getSetCookie())).toEqual([])
  const view = await session.json() as { authenticated: boolean }
  if ([read, write, handoff].every((answer) => answer.status === 401) && !view.authenticated) return true
  expect([read.status, write.status, handoff.status, view.authenticated]).toEqual([200, 200, 200, true])
  return false
}

const revocations = async (digests: string[]) =>
  (await db.orm.public.RevokedSession.where((row) => row.digest.in(digests)).select('digest').all())
    .map((row) => row.digest).sort()

describe('sign-out saved in PostgreSQL', () => {
  it('refuses a copied cookie after sign-out, in this process and in a restarted one, and only that session', async () => {
    const clock = { time: Date.now() }
    const identity = { tenantId: randomUUID(), objectId: randomUUID() }
    const before = await studio(clock, identity)
    const copied = await signIn(before)
    const other = await signIn(before)
    const account = (await db.orm.public.ResearcherAccount.select('id').first({ tenantId: identity.tenantId }))!.id
    accounts.push(account)
    expect(copied).not.toBe(other)
    expect(await denied(before, copied)).toBe(false)

    const logout = await signOut(before, copied)
    expect(logout.status).toBe(302)
    expect(await denied(before, copied)).toBe(true)
    expect(await denied(before, other)).toBe(false)

    // Stands in for a restart: a second app, still in this process, with the same secret and a new authentication
    // backend, so nothing the first one holds in memory.
    const after = await studio(clock, identity)
    expect(await denied(after, copied)).toBe(true)
    expect(await denied(after, other)).toBe(false)
    expect(await denied(after, await signIn(after))).toBe(false)

    // Both sessions end at their expiry, signed out or not.
    clock.time += 8 * HOUR
    expect((await after.request(`${ORIGIN}/api/example`, { headers: { cookie: other } })).status).toBe(401)
  })

  it('a sign-out deletes only sign-outs expired on every clock, and deleting an account waits on none', async () => {
    const clock = { time: Date.now() }
    const identity = { tenantId: randomUUID(), objectId: randomUUID() }
    const app = await studio(clock, identity)
    const store = createResearcherAccountStore(db)
    const [expired, withinSkew, live] = [randomUUID(), randomUUID(), randomUUID()]
    await store.revokeSession(expired, new Date(clock.time - 2 * 60_000), new Date(0))
    await store.revokeSession(withinSkew, new Date(clock.time - 30_000), new Date(0))
    await store.revokeSession(live, new Date(clock.time + HOUR), new Date(0))
    // A repeated sign-out keeps the saved row.
    await store.revokeSession(live, new Date(clock.time + HOUR), new Date(0))
    expect(await store.isSessionRevoked(live)).toBe(true)

    const cookie = await signIn(app)
    const account = (await db.orm.public.ResearcherAccount.select('id').first({ tenantId: identity.tenantId }))!.id
    expect((await signOut(app, cookie)).status).toBe(302)
    expect(await revocations([expired, withinSkew, live])).toEqual([withinSkew, live].sort())

    await db.orm.public.ResearcherAccount.where({ id: account }).delete()
    expect(await db.orm.public.ResearcherAccount.select('id').first({ id: account })).toBeNull()
    expect(await denied(app, cookie)).toBe(true)
  })
})
