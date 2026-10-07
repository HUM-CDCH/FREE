import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createDevelopmentOidcIdentityProvider,
  createMicrosoftEntraIdentityProvider,
  createOidcOnlyNetworkClient,
  EntraIdentityError,
} from './entraIdentityProvider.js'
import { createInMemoryEntraIdentityProvider } from '../test/support/inMemoryEntraIdentityProvider.js'

const TENANT_ID = '22222222-2222-4222-8222-222222222222'
const OBJECT_ID = '33333333-3333-4333-8333-333333333333'

function microsoftProvider(claims: Record<string, unknown>) {
  const getAuthCodeUrl = vi.fn(
    async () =>
      'https://login.example/authorize?scope=openid%20profile%20offline_access',
  )
  const acquireTokenByCode = vi.fn(async () => ({
    idTokenClaims: claims,
  }))
  const clearCache = vi.fn()
  return {
    provider: createMicrosoftEntraIdentityProvider(
      {
        tenantId: TENANT_ID,
        clientId: OBJECT_ID,
        certificateThumbprint: 'thumbprint',
        certificatePrivateKey: 'private-key',
      },
      { getAuthCodeUrl, acquireTokenByCode, clearCache } as never,
    ),
    getAuthCodeUrl,
    acquireTokenByCode,
    clearCache,
  }
}

describe('Microsoft Entra identity provider', () => {
  it('starts authorization code + PKCE with OIDC-only scopes', async () => {
    const fixture = microsoftProvider({})

    await expect(
      fixture.provider.authorizationUrl({
        redirectUri: 'https://studio.example/free/auth/callback',
        state: 'state',
        nonce: 'nonce',
        codeChallenge: 'challenge',
      }),
    ).resolves.toBe(
      'https://login.example/authorize?scope=openid+profile',
    )

    expect(fixture.getAuthCodeUrl).toHaveBeenCalledWith({
      redirectUri: 'https://studio.example/free/auth/callback',
      scopes: ['openid', 'profile'],
      responseMode: 'query',
      state: 'state',
      nonce: 'nonce',
      codeChallenge: 'challenge',
      codeChallengeMethod: 'S256',
    })
  })

  it('returns only the claims FREE needs and supplies the PKCE verifier', async () => {
    const fixture = microsoftProvider({
      tid: TENANT_ID.toUpperCase(),
      oid: OBJECT_ID.toUpperCase(),
      name: '  Ada Researcher  ',
      exp: 1_800_000_000,
      nonce: 'expected-nonce',
    })

    await expect(
      fixture.provider.redeemAuthorizationCode({
        redirectUri: 'https://studio.example/free/auth/callback',
        code: 'authorization-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({
      tenantId: TENANT_ID,
      objectId: OBJECT_ID,
      displayName: 'Ada Researcher',
      expiresAt: 1_800_000_000_000,
      nonce: 'expected-nonce',
    })
    expect(fixture.acquireTokenByCode).toHaveBeenCalledWith({
      redirectUri: 'https://studio.example/free/auth/callback',
      scopes: ['openid', 'profile'],
      code: 'authorization-code',
      codeVerifier: 'verifier',
    })
    expect(fixture.clearCache).toHaveBeenCalledOnce()
  })

  it('removes offline_access from the token request on the wire', async () => {
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args
      return Response.json({})
    })
    const network = createOidcOnlyNetworkClient(request as typeof fetch)

    await network.sendPostRequestAsync('https://login.example/token', {
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        scope: 'openid profile offline_access',
      }).toString(),
    })

    const body = new URLSearchParams(
      request.mock.calls[0]![1]!.body as string,
    )
    expect(body.get('scope')).toBe('openid profile')
  })

  it.each([
    [{ oid: OBJECT_ID, name: 'Ada', exp: 1_800_000_000, nonce: 'n' }, 'tenant'],
    [{ tid: '00000000-0000-4000-8000-000000000001', oid: OBJECT_ID, name: 'Ada', exp: 1_800_000_000, nonce: 'n' }, 'another tenant'],
    [{ tid: TENANT_ID, name: 'Ada', exp: 1_800_000_000, nonce: 'n' }, 'object identifier'],
    [{ tid: TENANT_ID, oid: OBJECT_ID, name: ' ', exp: 1_800_000_000, nonce: 'n' }, 'display name'],
    [{ tid: TENANT_ID, oid: OBJECT_ID, name: 'Ada', nonce: 'n' }, 'expiration'],
    [{ tid: TENANT_ID, oid: OBJECT_ID, name: 'Ada', exp: 1_800_000_000 }, 'nonce'],
  ])('rejects invalid identity claims %#', async (claims, message) => {
    const fixture = microsoftProvider(claims)
    await expect(
      fixture.provider.redeemAuthorizationCode({
        redirectUri: 'https://studio.example/auth/callback',
        code: 'code',
        codeVerifier: 'verifier',
      }),
    ).rejects.toThrow(message)
  })

  it('builds a tenant-scoped logout URL', () => {
    const { provider } = microsoftProvider({})
    expect(
      provider.logoutUrl('https://studio.example/free/auth/signed-out'),
    ).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=https%3A%2F%2Fstudio.example%2Ffree%2Fauth%2Fsigned-out`,
    )
  })
})

describe('development OIDC identity provider', () => {
  const CLIENT_ID = '00000000-0000-4000-8000-000000000003'

  function developmentProvider(request: typeof fetch) {
    return createDevelopmentOidcIdentityProvider(
      {
        tenantId: TENANT_ID,
        clientId: CLIENT_ID,
        serverIssuer: 'http://mock-oidc:8080/dev',
        browserIssuer: 'http://localhost:8444/dev/',
      },
      request,
    )
  }

  function idToken(claims: Record<string, unknown>): string {
    const encode = (value: unknown) =>
      Buffer.from(JSON.stringify(value)).toString('base64url')
    return `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.signature`
  }

  it('builds the browser-facing authorization URL without network access', async () => {
    const request = vi.fn<typeof fetch>()
    const provider = developmentProvider(request)

    const url = new URL(
      await provider.authorizationUrl({
        redirectUri: 'https://localhost:8443/free/auth/callback',
        state: 'state',
        nonce: 'nonce',
        codeChallenge: 'challenge',
      }),
    )

    expect(url.origin + url.pathname).toBe(
      'http://localhost:8444/dev/authorize',
    )
    expect(url.searchParams.get('scope')).toBe('openid profile')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://localhost:8443/free/auth/callback',
    )
    expect(url.searchParams.get('state')).toBe('state')
    expect(url.searchParams.get('nonce')).toBe('nonce')
    expect(url.searchParams.get('code_challenge')).toBe('challenge')
    expect(request).not.toHaveBeenCalled()
  })

  it('redeems the code at the server-facing token endpoint with a client assertion', async () => {
    const request = vi.fn(async (...args: Parameters<typeof fetch>) => {
      void args
      return Response.json({
        token_type: 'Bearer',
        scope: 'openid profile',
        expires_in: 3600,
        access_token: 'access-token',
        id_token: idToken({
          iss: 'http://mock-oidc:8080/dev',
          aud: CLIENT_ID,
          sub: OBJECT_ID,
          tid: TENANT_ID,
          oid: OBJECT_ID,
          name: 'Development Researcher',
          iat: 1_800_000_000,
          exp: 1_800_003_600,
          nonce: 'expected-nonce',
        }),
      })
    })
    const provider = developmentProvider(request as typeof fetch)

    await expect(
      provider.redeemAuthorizationCode({
        redirectUri: 'https://localhost:8443/free/auth/callback',
        code: 'authorization-code',
        codeVerifier: 'verifier',
      }),
    ).resolves.toEqual({
      tenantId: TENANT_ID,
      objectId: OBJECT_ID,
      displayName: 'Development Researcher',
      expiresAt: 1_800_003_600_000,
      nonce: 'expected-nonce',
    })

    expect(request).toHaveBeenCalledOnce()
    const tokenUrl = new URL(request.mock.calls[0]![0] as string)
    expect(tokenUrl.origin + tokenUrl.pathname).toBe(
      'http://mock-oidc:8080/dev/token',
    )
    const body = new URLSearchParams(request.mock.calls[0]![1]!.body as string)
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('code')).toBe('authorization-code')
    expect(body.get('code_verifier')).toBe('verifier')
    expect(body.get('scope')).toBe('openid profile')
    expect(body.get('client_assertion')).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
  })

  it('signs out through the browser-facing end-session endpoint', () => {
    const provider = developmentProvider(vi.fn<typeof fetch>())
    expect(
      provider.logoutUrl('https://localhost:8443/free/auth/signed-out'),
    ).toBe(
      'http://localhost:8444/dev/endsession?post_logout_redirect_uri=https%3A%2F%2Flocalhost%3A8443%2Ffree%2Fauth%2Fsigned-out',
    )
  })
})

describe('test-only in-memory Entra identity provider', () => {
  it('round-trips the real route shape with only its configured identity', async () => {
    const now = Date.UTC(2026, 7, 20)
    const provider = createInMemoryEntraIdentityProvider({
      objectId: OBJECT_ID,
      now: () => now,
    })
    const codeVerifier = 'verifier'
    const authorization = await provider.authorizationUrl({
      redirectUri: 'https://localhost:8443/free/auth/callback',
      state: 'state',
      nonce: 'nonce',
      codeChallenge: createHash('sha256')
        .update(codeVerifier)
        .digest('base64url'),
    })
    const url = new URL(authorization)
    expect(url.searchParams.get('state')).toBe('state')

    const redemption = {
      redirectUri: url.origin + url.pathname,
      code: url.searchParams.get('code')!,
      codeVerifier,
    }
    await expect(provider.redeemAuthorizationCode(redemption)).resolves.toMatchObject({
      objectId: OBJECT_ID,
      nonce: 'nonce',
      expiresAt: now + 75 * 60 * 1_000,
    })
    await expect(provider.redeemAuthorizationCode(redemption)).rejects.toThrow(
      'already redeemed',
    )
  })

  it('rejects a malformed in-memory authorization code', async () => {
    await expect(
      createInMemoryEntraIdentityProvider().redeemAuthorizationCode({
        redirectUri: 'https://localhost/auth/callback',
        code: 'not-json',
        codeVerifier: 'verifier',
      }),
    ).rejects.toBeInstanceOf(EntraIdentityError)
  })

  it('rejects an in-memory callback with the wrong PKCE verifier', async () => {
    const provider = createInMemoryEntraIdentityProvider()
    const authorization = new URL(
      await provider.authorizationUrl({
        redirectUri: 'https://localhost/auth/callback',
        state: 'state',
        nonce: 'nonce',
        codeChallenge: createHash('sha256')
          .update('right-verifier')
          .digest('base64url'),
      }),
    )

    await expect(
      provider.redeemAuthorizationCode({
        redirectUri: 'https://localhost/auth/callback',
        code: authorization.searchParams.get('code')!,
        codeVerifier: 'wrong-verifier',
      }),
    ).rejects.toThrow('PKCE')
  })
})
