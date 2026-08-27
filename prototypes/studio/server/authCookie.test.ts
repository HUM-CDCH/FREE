import { describe, expect, it } from 'vitest'
import { clearAuthCookie, serializeAuthCookie } from './authCookie.js'

describe('authentication cookie policy', () => {
  it('serializes the exact shared browser policy through Hono', () => {
    const expires = new Date('2026-08-20T00:10:00.000Z')

    expect(
      serializeAuthCookie('free_example', 'payload', {
        path: '/free/auth',
        expires,
        maxAge: 600,
      }),
    ).toBe(
      'free_example=payload; Max-Age=600; Path=/free/auth; Expires=Thu, 20 Aug 2026 00:10:00 GMT; HttpOnly; Secure; SameSite=Lax',
    )
  })

  it('clears a cookie without weakening or widening its boundary', () => {
    expect(clearAuthCookie('free_example', '/free/auth')).toBe(
      'free_example=; Max-Age=0; Path=/free/auth; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    )
  })
})
