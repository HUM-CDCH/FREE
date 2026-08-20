import { describe, expect, it } from 'vitest'
import {
  createSessionManager,
  SESSION_ABSOLUTE_MILLISECONDS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MILLISECONDS,
} from './session.js'

const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001'
const SECRET = Buffer.alloc(32, 7)

function cookieValue(serialized: string): string {
  return serialized.slice(`${SESSION_COOKIE_NAME}=`.length).split(';', 1)[0]
}

describe('signed browser sessions', () => {
  it('encodes only signed session authority and emits every required attribute', () => {
    let time = Date.UTC(2026, 7, 20)
    const sessions = createSessionManager(SECRET, () => time)
    const payload = sessions.issue(ACCOUNT_ID, 4)
    const cookie = sessions.serialize(payload)

    expect(payload).toEqual({
      version: 1,
      accountId: ACCOUNT_ID,
      sessionVersion: 4,
      issuedAt: time,
      expiresAt: time + SESSION_IDLE_MILLISECONDS,
    })
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`)
    expect(cookie).toContain('Path=/')
    expect(cookie).toContain('Max-Age=43200')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Strict')
    expect(sessions.verify(cookieValue(cookie))).toEqual(payload)

    time += 1
    expect(sessions.verify(cookieValue(cookie))).toEqual(payload)
  })

  it('rejects tampering, duplicate cookies, malformed values, and idle expiry', () => {
    let time = 10_000
    const sessions = createSessionManager(SECRET, () => time)
    const value = cookieValue(sessions.serialize(sessions.issue(ACCOUNT_ID, 0)))
    const replacement = value.endsWith('A') ? 'B' : 'A'
    const tampered = `${value.slice(0, -1)}${replacement}`

    expect(sessions.verify(tampered)).toBeNull()
    expect(sessions.verify('not.a.valid.session')).toBeNull()
    expect(
      sessions.read(
        new Request('https://studio.example', {
          headers: { cookie: `${SESSION_COOKIE_NAME}=${value}; ${SESSION_COOKIE_NAME}=${value}` },
        }),
      ),
    ).toEqual({ present: true, value: null })

    time += SESSION_IDLE_MILLISECONDS
    expect(sessions.verify(value)).toBeNull()
  })

  it('renews idle expiry without moving issue time or crossing seven days', () => {
    let time = 20_000
    const sessions = createSessionManager(SECRET, () => time)
    const initial = sessions.issue(ACCOUNT_ID, 2)

    time += 6 * 60 * 60 * 1_000
    const renewed = sessions.renew(initial)
    expect(renewed).toEqual({
      ...initial,
      expiresAt: time + SESSION_IDLE_MILLISECONDS,
    })

    let active = renewed!
    for (let hours = 17; hours <= 160; hours += 11) {
      time = initial.issuedAt + hours * 60 * 60 * 1_000
      active = sessions.renew(active)!
    }
    time = initial.issuedAt + SESSION_ABSOLUTE_MILLISECONDS - 60_000
    const final = sessions.renew(active)
    expect(final).toEqual({
      ...initial,
      expiresAt: initial.issuedAt + SESSION_ABSOLUTE_MILLISECONDS,
    })

    time = initial.issuedAt + SESSION_ABSOLUTE_MILLISECONDS
    expect(sessions.renew(final!)).toBeNull()
    expect(sessions.verify(cookieValue(sessions.serialize(final!)))).toBeNull()
  })

  it('clears with the same hardened cookie boundary and rejects short secrets', () => {
    const sessions = createSessionManager(SECRET)
    expect(sessions.clear()).toBe(
      `${SESSION_COOKIE_NAME}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Secure; HttpOnly; SameSite=Strict`,
    )
    expect(() => createSessionManager(Buffer.alloc(31))).toThrow(
      /at least 32 bytes/,
    )
  })
})
