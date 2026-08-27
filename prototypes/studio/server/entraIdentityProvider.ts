import {
  ConfidentialClientApplication,
  ResponseMode,
  type IConfidentialClientApplication,
  type INetworkModule,
  type NetworkRequestOptions,
  type NetworkResponse,
} from '@azure/msal-node'
import { createHash } from 'node:crypto'
import { normalizeCanonicalUuid } from '../shared/uuid.js'

const OIDC_SCOPES = ['openid', 'profile']

export type EntraIdentity = {
  tenantId: string
  objectId: string
  displayName: string
  expiresAt: number
  nonce: string
}

export type EntraIdentityProvider = {
  authorizationUrl(input: {
    redirectUri: string
    state: string
    nonce: string
    codeChallenge: string
    testIdentity?: string
  }): Promise<string>
  redeemAuthorizationCode(input: {
    redirectUri: string
    code: string
    codeVerifier: string
  }): Promise<EntraIdentity>
  logoutUrl(postLogoutRedirectUri: string): string
}

export class EntraIdentityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EntraIdentityError'
  }
}

export type MicrosoftEntraIdentityProviderConfig = {
  tenantId: string
  clientId: string
  certificateThumbprint: string
  certificatePrivateKey: string
}
type MicrosoftEntraClient = Pick<
  IConfidentialClientApplication,
  'getAuthCodeUrl' | 'acquireTokenByCode' | 'clearCache'
>

function oidcOnlyScope(scope: string): string {
  return scope
    .split(/\s+/)
    .filter((value) => value !== 'offline_access')
    .join(' ')
}

/** MSAL transport boundary that removes its implicit refresh-token scope. */
export function createOidcOnlyNetworkClient(
  request: typeof fetch = fetch,
): INetworkModule {
  const send = async <T>(
    url: string,
    method: 'GET' | 'POST',
    options?: NetworkRequestOptions,
    timeout?: number,
  ): Promise<NetworkResponse<T>> => {
    let body = options?.body
    if (body) {
      const parameters = new URLSearchParams(body)
      const scope = parameters.get('scope')
      if (scope) parameters.set('scope', oidcOnlyScope(scope))
      body = parameters.toString()
    }
    const controller = timeout === undefined ? null : new AbortController()
    const timer =
      controller === null
        ? undefined
        : setTimeout(() => controller.abort(), timeout)
    try {
      const response = await request(url, {
        method,
        headers: options?.headers,
        body,
        signal: controller?.signal,
      })
      const text = await response.text()
      return {
        headers: Object.fromEntries(response.headers.entries()),
        body: (text === '' ? {} : JSON.parse(text)) as T,
        status: response.status,
      }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    sendGetRequestAsync: (url, options, timeout) =>
      send(url, 'GET', options, timeout),
    sendPostRequestAsync: (url, options) => send(url, 'POST', options),
  }
}

function canonicalUuid(value: unknown, claim: string): string {
  const normalized = normalizeCanonicalUuid(value)
  if (normalized === null)
    throw new EntraIdentityError(
      `The Entra ID token has no valid ${claim} claim.`,
    )
  return normalized
}

function identityFromClaims(
  claims: unknown,
  expectedTenantId: string,
): EntraIdentity {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims))
    throw new EntraIdentityError('The Entra ID token has no valid claims.')
  const record = claims as Record<string, unknown>
  const tenantId = canonicalUuid(record.tid, 'tenant')
  if (tenantId !== expectedTenantId)
    throw new EntraIdentityError('The Entra ID token belongs to another tenant.')
  const objectId = canonicalUuid(record.oid, 'object identifier')
  if (typeof record.name !== 'string' || record.name.trim() === '')
    throw new EntraIdentityError(
      'The Entra ID token has no researcher display name.',
    )
  if (
    !Number.isSafeInteger(record.exp) ||
    Number(record.exp) <= 0 ||
    Number(record.exp) > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
  )
    throw new EntraIdentityError(
      'The Entra ID token has no valid expiration.',
    )
  if (typeof record.nonce !== 'string' || record.nonce === '')
    throw new EntraIdentityError('The Entra ID token has no valid nonce.')
  return {
    tenantId,
    objectId,
    displayName: record.name.trim(),
    expiresAt: Number(record.exp) * 1_000,
    nonce: record.nonce,
  }
}

export function createMicrosoftEntraIdentityProvider(
  config: MicrosoftEntraIdentityProviderConfig,
  client: MicrosoftEntraClient = new ConfidentialClientApplication({
    auth: {
      clientId: config.clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientCertificate: {
        thumbprintSha256: config.certificateThumbprint,
        privateKey: config.certificatePrivateKey,
      },
    },
    system: { networkClient: createOidcOnlyNetworkClient() },
  }),
): EntraIdentityProvider {
  const tenantId = canonicalUuid(config.tenantId, 'configured tenant')
  return {
    async authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      const location = await client.getAuthCodeUrl({
        redirectUri,
        scopes: [...OIDC_SCOPES],
        responseMode: ResponseMode.QUERY,
        state,
        nonce,
        codeChallenge,
        codeChallengeMethod: 'S256',
      })
      const url = new URL(location)
      const scope = url.searchParams.get('scope')
      if (scope) url.searchParams.set('scope', oidcOnlyScope(scope))
      return url.href
    },

    async redeemAuthorizationCode({ redirectUri, code, codeVerifier }) {
      let result
      try {
        result = await client.acquireTokenByCode({
          redirectUri,
          scopes: [...OIDC_SCOPES],
          code,
          codeVerifier,
        })
      } catch (cause) {
        throw new EntraIdentityError(
          'The Entra authorization code could not be redeemed.',
          { cause },
        )
      } finally {
        client.clearCache()
      }
      return identityFromClaims(result.idTokenClaims, tenantId)
    },

    logoutUrl(postLogoutRedirectUri) {
      const url = new URL(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
      )
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirectUri)
      return url.href
    },
  }
}

export const DEVELOPMENT_ENTRA_TENANT_ID =
  '00000000-0000-4000-8000-000000000001'
export const DEVELOPMENT_ENTRA_OBJECT_ID =
  '00000000-0000-4000-8000-000000000002'

export function createFakeEntraIdentityProvider(options: {
  tenantId?: string
  objectId?: string
  displayName?: string
  now?: () => number
  tokenLifetimeMilliseconds?: number
} = {}): EntraIdentityProvider {
  const tenantId = canonicalUuid(
    options.tenantId ?? DEVELOPMENT_ENTRA_TENANT_ID,
    'fake tenant',
  )
  const defaultObjectId = canonicalUuid(
    options.objectId ?? DEVELOPMENT_ENTRA_OBJECT_ID,
    'fake object identifier',
  )
  const displayName = options.displayName?.trim() || 'Development Researcher'
  const now = options.now ?? Date.now
  const tokenLifetimeMilliseconds =
    options.tokenLifetimeMilliseconds ?? 75 * 60 * 1_000
  const redeemedCodes = new Set<string>()

  return {
    async authorizationUrl({
      redirectUri,
      state,
      nonce,
      codeChallenge,
      testIdentity,
    }) {
      const objectId =
        testIdentity === undefined
          ? defaultObjectId
          : canonicalUuid(testIdentity, 'fake test identity')
      const code = Buffer.from(
        JSON.stringify({ nonce, objectId, codeChallenge }),
      ).toString('base64url')
      const url = new URL(redirectUri)
      url.searchParams.set('code', code)
      url.searchParams.set('state', state)
      return url.href
    },

    async redeemAuthorizationCode({ code, codeVerifier }) {
      if (redeemedCodes.has(code))
        throw new EntraIdentityError(
          'The fake authorization code was already redeemed.',
        )
      let decoded: unknown
      try {
        decoded = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
      } catch (cause) {
        throw new EntraIdentityError('The fake authorization code is invalid.', {
          cause,
        })
      }
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
        throw new EntraIdentityError('The fake authorization code is invalid.')
      const record = decoded as Record<string, unknown>
      const objectId = canonicalUuid(
        record.objectId,
        'fake object identifier',
      )
      if (typeof record.nonce !== 'string' || record.nonce === '')
        throw new EntraIdentityError('The fake authorization code has no nonce.')
      const expectedChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url')
      if (record.codeChallenge !== expectedChallenge)
        throw new EntraIdentityError(
          'The fake authorization code has an invalid PKCE verifier.',
        )
      redeemedCodes.add(code)
      return {
        tenantId,
        objectId,
        displayName:
          objectId === defaultObjectId
            ? displayName
            : `Test Researcher ${objectId.slice(0, 8)}`,
        expiresAt: now() + tokenLifetimeMilliseconds,
        nonce: record.nonce,
      }
    },

    logoutUrl(postLogoutRedirectUri) {
      return postLogoutRedirectUri
    },
  }
}
