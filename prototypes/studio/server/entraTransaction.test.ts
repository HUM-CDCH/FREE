import { describe, expect, it } from 'vitest'
import {
  createEntraTransactionManager,
  ENTRA_TRANSACTION_COOKIE_NAME,
  ENTRA_TRANSACTION_MILLISECONDS,
} from './entraTransaction.js'

const SECRET = Buffer.alloc(32, 9)

function cookieHeader(setCookie: string): string {
  return setCookie.split(';', 1)[0]
}

describe('Entra authorization transactions', () => {
  it('binds state, nonce, PKCE, return path, lifetime, and base path', () => {
    const issuedAt = Date.UTC(2026, 7, 20)
    const manager = createEntraTransactionManager(
      SECRET,
      '/free',
      () => issuedAt,
    )
    const created = manager.create('/projects/one?tab=review#field')

    expect(created.transaction).toMatchObject({
      version: 1,
      returnTo: '/projects/one?tab=review#field',
      issuedAt,
      expiresAt: issuedAt + ENTRA_TRANSACTION_MILLISECONDS,
    })
    expect(created.transaction.state).toHaveLength(43)
    expect(created.transaction.nonce).toHaveLength(43)
    expect(created.transaction.codeVerifier).toHaveLength(43)
    expect(created.codeChallenge).toHaveLength(43)
    expect(created.setCookie).toContain(
      `${ENTRA_TRANSACTION_COOKIE_NAME}=`,
    )
    expect(created.setCookie).toContain('Path=/free/auth')
    expect(created.setCookie).toContain('Max-Age=600')
    expect(created.setCookie).toContain('Secure')
    expect(created.setCookie).toContain('HttpOnly')
    expect(created.setCookie).toContain('SameSite=Lax')

    expect(
      manager.verify(
        new Request('https://localhost/free/auth/callback', {
          headers: { cookie: cookieHeader(created.setCookie) },
        }),
        created.transaction.state,
      ),
    ).toEqual(created.transaction)
  })

  it('rejects state mismatch, tampering, duplicates, expiry, and replay without a cookie', () => {
    let time = Date.UTC(2026, 7, 20)
    const manager = createEntraTransactionManager(SECRET, '/', () => time)
    const created = manager.create('/projects')
    const cookie = cookieHeader(created.setCookie)
    const value = cookie.slice(`${ENTRA_TRANSACTION_COOKIE_NAME}=`.length)
    const replacement = value.endsWith('A') ? 'B' : 'A'
    const request = (header?: string) =>
      new Request('https://localhost/auth/callback', {
        headers: header ? { cookie: header } : undefined,
      })

    expect(manager.verify(request(cookie), 'wrong-state')).toBeNull()
    expect(
      manager.verify(
        request(
          `${ENTRA_TRANSACTION_COOKIE_NAME}=${value.slice(0, -1)}${replacement}`,
        ),
        created.transaction.state,
      ),
    ).toBeNull()
    expect(
      manager.verify(request(`${cookie}; ${cookie}`), created.transaction.state),
    ).toBeNull()
    expect(manager.verify(request(), created.transaction.state)).toBeNull()

    time += ENTRA_TRANSACTION_MILLISECONDS
    expect(manager.verify(request(cookie), created.transaction.state)).toBeNull()
  })

  it('clears with the exact transaction cookie boundary', () => {
    expect(createEntraTransactionManager(SECRET, '/free').clear()).toBe(
      `${ENTRA_TRANSACTION_COOKIE_NAME}=; Path=/free/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=Lax`,
    )
  })
})
