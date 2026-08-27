import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  createFakeEntraIdentityProvider,
  createMicrosoftEntraIdentityProvider,
  createOidcOnlyNetworkClient,
  EntraIdentityError,
} from './entraIdentityProvider.js'

const TENANT_ID = 'a3927f91-cda1-4696-af89-8c9f1ceffa91'
const OBJECT_ID = 'cd97c8af-656f-412a-977c-ef5fc06dd1a2'

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

describe('fake Entra identity provider', () => {
  it('round-trips the real route shape with only its configured identity', async () => {
    const now = Date.UTC(2026, 7, 20)
    const provider = createFakeEntraIdentityProvider({
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

  it('rejects a malformed fake code', async () => {
    await expect(
      createFakeEntraIdentityProvider().redeemAuthorizationCode({
        redirectUri: 'https://localhost/auth/callback',
        code: 'not-json',
        codeVerifier: 'verifier',
      }),
    ).rejects.toBeInstanceOf(EntraIdentityError)
  })

  it('rejects a fake callback with the wrong PKCE verifier', async () => {
    const provider = createFakeEntraIdentityProvider()
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
