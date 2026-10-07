import { describe, expect, it } from 'vitest'
import { canonicalStudioOrigin } from 'studio-configuration'
import { normalizeClientAddress } from './request-address.js'
import { enforceCanonicalOrigin } from './origin.js'

describe('canonical Origin enforcement', () => {
  it('accepts only the configured canonical origin on unsafe methods', () => {
    const origin = canonicalStudioOrigin('https://studio.example')
    expect(() =>
      enforceCanonicalOrigin(
        new Request(`${origin}/auth/logout`, {
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
          new Request(`${origin}/auth/logout`, { method: 'POST', headers }),
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

describe('request address normalization', () => {
  it('canonicalizes IPv4-mapped addresses for peer checks', () => {
    expect(normalizeClientAddress(' ::FFFF:192.0.2.10 ')).toBe('192.0.2.10')
  })
})
