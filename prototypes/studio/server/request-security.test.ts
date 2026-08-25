import { describe, expect, it } from 'vitest'
import {
  createLoginLimiter,
  normalizeClientAddress,
  type LoginLimiter,
} from './login-limiter.js'
import {
  canonicalStudioOrigin,
  enforceCanonicalOrigin,
} from './origin.js'

describe('canonical Origin enforcement', () => {
  it('accepts only the configured canonical origin on unsafe methods', () => {
    const origin = canonicalStudioOrigin('https://studio.example')
    expect(() =>
      enforceCanonicalOrigin(
        new Request(`${origin}/api/auth/login`, {
          method: 'POST',
          headers: { origin },
        }),
        origin,
      ),
    ).not.toThrow()

    for (const supplied of [undefined, 'https://other.example', `${origin}/`]) {
      const headers = supplied ? { origin: supplied } : undefined
      expect(() =>
        enforceCanonicalOrigin(
          new Request(`${origin}/api/auth/login`, { method: 'POST', headers }),
          origin,
        ),
      ).toThrowError(
        expect.objectContaining({ status: 403, code: 'origin_rejected' }),
      )
    }
  })

  it('does not demand Origin from safe requests and rejects noncanonical config', () => {
    expect(() =>
      enforceCanonicalOrigin(
        new Request('https://studio.example/api/healthz'),
        'https://studio.example',
      ),
    ).not.toThrow()

    for (const configured of [
      'https://studio.example/',
      'https://STUDIO.example',
      'https://studio.example:443',
      'https://studio.example/path',
      'ftp://studio.example',
      'not an origin',
    ])
      expect(() => canonicalStudioOrigin(configured)).toThrow(/canonical/)
  })
})

describe('bounded login limiter', () => {
  function complete(
    limiter: LoginLimiter,
    email: string,
    address: string,
    outcome: 'success' | 'failure' | 'abandon',
  ) {
    const reservation = limiter.reserve(email, address)
    expect(reservation.accepted).toBe(true)
    if (reservation.accepted) reservation.complete(outcome)
  }

  it('blocks either a normalized-email bucket or a client-address bucket', () => {
    let time = 100_000
    const limiter = createLoginLimiter({
      emailMaxFailures: 2,
      addressMaxFailures: 2,
      windowMilliseconds: 10_000,
      maxEntries: 8,
      now: () => time,
    })

    complete(limiter, 'researcher@example.org', '192.0.2.10', 'failure')
    complete(limiter, 'researcher@example.org', '192.0.2.10', 'failure')
    const emailBlocked = limiter.reserve(
      'researcher@example.org',
      '192.0.2.11',
    )
    const addressBlocked = limiter.reserve(
      'someone@example.org',
      '192.0.2.10',
    )
    expect(emailBlocked).toEqual({
      accepted: false,
      retryAfterSeconds: 10,
    })
    expect(addressBlocked).toEqual({
      accepted: false,
      retryAfterSeconds: 10,
    })

    time += 10_000
    complete(limiter, 'researcher@example.org', '192.0.2.10', 'abandon')
    expect(limiter.size).toBe(0)
  })

  it('prunes and evicts fixed-width identifier buckets', () => {
    let time = 0
    const limiter = createLoginLimiter({
      emailMaxFailures: 100,
      addressMaxFailures: 100,
      windowMilliseconds: 1_000,
      maxEntries: 4,
      now: () => time,
    })

    for (let index = 0; index < 20; index += 1)
      complete(
        limiter,
        `${'x'.repeat(100_000)}-${index}`,
        `192.0.2.${index}`,
        'failure',
      )
    expect(limiter.size).toBeLessThanOrEqual(4)

    time = 1_000
    expect(limiter.size).toBe(0)
  })

  it('normalizes addresses without letting a success clear client failures', () => {
    const limiter = createLoginLimiter({
      emailMaxFailures: 2,
      addressMaxFailures: 2,
      maxEntries: 8,
    })
    expect(normalizeClientAddress(' ::FFFF:192.0.2.10 ')).toBe('192.0.2.10')
    complete(
      limiter,
      'first-target@example.org',
      '::ffff:192.0.2.10',
      'failure',
    )
    complete(
      limiter,
      'valid-account@example.org',
      '192.0.2.10',
      'success',
    )
    complete(
      limiter,
      'second-target@example.org',
      '192.0.2.10',
      'failure',
    )

    expect(
      limiter.reserve('third-target@example.org', '192.0.2.10'),
    ).toMatchObject({ accepted: false })
    complete(
      limiter,
      'valid-account@example.org',
      '192.0.2.11',
      'abandon',
    )
  })

  it('reserves capacity before asynchronous password verification', () => {
    const limiter = createLoginLimiter({
      emailMaxFailures: 2,
      addressMaxFailures: 2,
      maxEntries: 8,
    })
    const first = limiter.reserve('researcher@example.org', '192.0.2.10')
    const second = limiter.reserve('researcher@example.org', '192.0.2.10')
    expect(first.accepted).toBe(true)
    expect(second.accepted).toBe(true)
    expect(
      limiter.reserve('researcher@example.org', '192.0.2.10'),
    ).toMatchObject({ accepted: false })
    if (first.accepted) first.complete('abandon')
    complete(
      limiter,
      'researcher@example.org',
      '192.0.2.10',
      'abandon',
    )
    if (second.accepted) second.complete('abandon')
    expect(limiter.size).toBe(0)
  })

  it('uses a higher address threshold for researchers behind one gateway', () => {
    const limiter = createLoginLimiter({
      emailMaxFailures: 2,
      addressMaxFailures: 5,
      maxEntries: 16,
    })

    complete(limiter, 'first@example.org', '192.0.2.10', 'failure')
    complete(limiter, 'first@example.org', '192.0.2.10', 'failure')
    expect(
      limiter.reserve('first@example.org', '192.0.2.11'),
    ).toMatchObject({ accepted: false })

    complete(limiter, 'second@example.org', '192.0.2.10', 'failure')
    complete(limiter, 'third@example.org', '192.0.2.10', 'failure')
    const sharedGateway = limiter.reserve('valid@example.org', '192.0.2.10')
    expect(sharedGateway.accepted).toBe(true)
    if (sharedGateway.accepted) sharedGateway.complete('abandon')
  })

  it('admits an unrelated login when every retained bucket is blocked', () => {
    const limiter = createLoginLimiter({
      emailMaxFailures: 1,
      addressMaxFailures: 1,
      maxEntries: 4,
    })
    complete(limiter, 'first@example.org', '192.0.2.10', 'failure')
    complete(limiter, 'second@example.org', '192.0.2.11', 'failure')

    const unrelated = limiter.reserve('valid@example.org', '192.0.2.12')
    expect(unrelated.accepted).toBe(true)
    if (unrelated.accepted) unrelated.complete('abandon')
  })

  it('does not evict an active blocked email bucket at capacity', () => {
    const limiter = createLoginLimiter({
      emailMaxFailures: 1,
      addressMaxFailures: 10,
      maxEntries: 3,
    })
    complete(limiter, 'target@example.org', '192.0.2.10', 'failure')

    const other = limiter.reserve('other@example.org', '192.0.2.11')
    expect(other.accepted).toBe(true)
    if (other.accepted) other.complete('abandon')
    expect(
      limiter.reserve('target@example.org', '192.0.2.12'),
    ).toMatchObject({ accepted: false })
  })

  it('does not evict an active blocked address bucket at capacity', () => {
    const limiter = createLoginLimiter({
      emailMaxFailures: 10,
      addressMaxFailures: 1,
      maxEntries: 3,
    })
    complete(limiter, 'first@example.org', '192.0.2.10', 'failure')

    const other = limiter.reserve('other@example.org', '192.0.2.11')
    expect(other.accepted).toBe(true)
    if (other.accepted) other.complete('abandon')
    expect(
      limiter.reserve('third@example.org', '192.0.2.10'),
    ).toMatchObject({ accepted: false })
  })
})
