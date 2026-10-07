import { describe, expect, it } from 'vitest'
import {
  createSessionManager,
  SESSION_CLOCK_SKEW_MILLISECONDS,
  SESSION_COOKIE_NAME,
} from './session.js'
import { encodeSignedValue } from './signedCookie.js'

const ACCOUNT_ID = '10000000-0000-4000-8000-000000000001'
const SECRET = Buffer.alloc(32, 7)

function cookieValue(serialized: string): string {
  return serialized.slice(`${SESSION_COOKIE_NAME}=`.length).split(';', 1)[0]
}

describe('fixed eight-hour browser sessions', () => {
  it.each([1, 24])('issues an eight-hour session from a %i-hour identity token with hardened cookie attributes', (hours) => {
    let time = Date.UTC(2026, 7, 20)
    const identityTokenExpiresAt = time + hours * 60 * 60 * 1_000
    const sessions = createSessionManager(SECRET, () => time)
    const payload = sessions.issue(ACCOUNT_ID, identityTokenExpiresAt)

    expect(payload).toEqual({
      version: 4,
      accountId: ACCOUNT_ID,
      issuedAt: time,
      expiresAt: time + 8 * 60 * 60 * 1_000,
    })
    const cookie = sessions.serialize(payload!)
    expect(cookie).toBe(
      `${SESSION_COOKIE_NAME}=${cookieValue(cookie)}; Max-Age=28800; Path=/; Expires=${new Date(payload!.expiresAt).toUTCString()}; HttpOnly; Secure; SameSite=Lax`,
    )
    expect(sessions.verify(cookieValue(cookie))).toEqual(payload)

    if (hours < 8) {
      time = identityTokenExpiresAt
      expect(sessions.verify(cookieValue(cookie))).toEqual(payload)
    }
    time = payload!.expiresAt - 1
    expect(sessions.verify(cookieValue(cookie))).toEqual(payload)
    time = payload!.expiresAt
    expect(sessions.verify(cookieValue(cookie))).toBeNull()
  })

  it.each([2, 3])('rejects version %i sessions issued under previous lifetime rules', (version) => {
    const time = Date.UTC(2026, 7, 20)
    const sessions = createSessionManager(SECRET, () => time)
    const oldCookie = encodeSignedValue({
      version,
      accountId: ACCOUNT_ID,
      issuedAt: time,
      expiresAt: time + 24 * 60 * 60 * 1_000,
    }, SECRET, 'FREE session cookie')
    expect(sessions.verify(oldCookie)).toBeNull()
  })

  it('rejects tokens without positive post-skew lifetime', () => {
    const time = Date.UTC(2026, 7, 20)
    const sessions = createSessionManager(SECRET, () => time)

    for (const expiry of [time - 1, time, NaN, Infinity, time + 120_000.5]) {
      expect(sessions.issue(ACCOUNT_ID, expiry)).toBeNull()
    }
    expect(
      sessions.issue(
        ACCOUNT_ID,
        time + SESSION_CLOCK_SKEW_MILLISECONDS,
      ),
    ).toBeNull()
    expect(
      sessions.issue(
        ACCOUNT_ID,
        time + SESSION_CLOCK_SKEW_MILLISECONDS - 1,
      ),
    ).toBeNull()
    expect(sessions.issue('not-an-account-id', time + 120_000)).toBeNull()
    expect(
      sessions.issue(
        'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        time + 120_000,
      ),
    ).toBeNull()
  })

  it('rejects tampering, malformed values, and duplicate cookies', () => {
    const time = Date.UTC(2026, 7, 20)
    const sessions = createSessionManager(SECRET, () => time)
    const payload = sessions.issue(ACCOUNT_ID, time + 3_600_000)!
    const value = cookieValue(sessions.serialize(payload))
    const replacement = value.endsWith('A') ? 'B' : 'A'

    expect(
      sessions.verify(`${value.slice(0, -1)}${replacement}`),
    ).toBeNull()
    expect(sessions.verify('not.a.valid.session')).toBeNull()
    expect(
      sessions.read(
        new Request('https://studio.example', {
          headers: {
            cookie: `${SESSION_COOKIE_NAME}=${value}; ${SESSION_COOKIE_NAME}=${value}`,
          },
        }),
      ),
    ).toEqual({ present: true, value: null })
  })

  it('clears on the configured base path and rejects short secrets', () => {
    const sessions = createSessionManager(SECRET, Date.now, '/free')
    expect(sessions.clear()).toBe(
      `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/free; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax`,
    )
    expect(() => createSessionManager(Buffer.alloc(31))).toThrow(
      /at least 32 bytes/,
    )
  })
})
