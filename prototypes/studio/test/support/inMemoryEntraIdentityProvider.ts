import { createHash } from 'node:crypto'
import { normalizeCanonicalUuid } from 'studio-configuration'
import {
  DEVELOPMENT_ENTRA_OBJECT_ID,
  DEVELOPMENT_ENTRA_TENANT_ID,
  EntraIdentityError,
  type EntraIdentityProvider,
} from '../../server/entraIdentityProvider.js'

export type TestEntraIdentity = {
  tenantId?: string
  objectId?: string
  displayName?: string
}

export type InMemoryEntraIdentityProviderOptions = TestEntraIdentity & {
  now?: () => number
  tokenLifetimeMilliseconds?: number
}

type ResolvedTestEntraIdentity = {
  tenantId: string
  objectId: string
  displayName: string
}

export type InMemoryEntraIdentityProvider = EntraIdentityProvider & {
  selectIdentity(identity: TestEntraIdentity): void
}

export function createInMemoryEntraIdentityProvider(
  options: InMemoryEntraIdentityProviderOptions = {},
): InMemoryEntraIdentityProvider {
  const now = options.now ?? Date.now
  const tokenLifetimeMilliseconds =
    options.tokenLifetimeMilliseconds ?? 75 * 60 * 1_000
  const redeemedCodes = new Set<string>()
  const issuedIdentities = new Map<string, ResolvedTestEntraIdentity>()
  let selectedIdentity = identity(options)

  return {
    selectIdentity(selected) {
      selectedIdentity = identity(selected)
    },

    async authorizationUrl({ redirectUri, state, nonce, codeChallenge }) {
      const code = Buffer.from(
        JSON.stringify({ nonce, codeChallenge }),
      ).toString('base64url')
      issuedIdentities.set(code, selectedIdentity)
      const url = new URL(redirectUri)
      url.searchParams.set('code', code)
      url.searchParams.set('state', state)
      return url.href
    },

    async redeemAuthorizationCode({ code, codeVerifier }) {
      if (redeemedCodes.has(code))
        throw new EntraIdentityError(
          'The in-memory authorization code was already redeemed.',
        )
      let decoded: unknown
      try {
        decoded = JSON.parse(Buffer.from(code, 'base64url').toString('utf8'))
      } catch (cause) {
        throw new EntraIdentityError(
          'The in-memory authorization code is invalid.',
          { cause },
        )
      }
      if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
        throw new EntraIdentityError(
          'The in-memory authorization code is invalid.',
        )
      const record = decoded as Record<string, unknown>
      if (typeof record.nonce !== 'string' || record.nonce === '')
        throw new EntraIdentityError(
          'The in-memory authorization code has no nonce.',
        )
      const expectedChallenge = createHash('sha256')
        .update(codeVerifier)
        .digest('base64url')
      if (record.codeChallenge !== expectedChallenge)
        throw new EntraIdentityError(
          'The in-memory authorization code has an invalid PKCE verifier.',
        )
      const issuedIdentity = issuedIdentities.get(code)
      if (issuedIdentity === undefined)
        throw new EntraIdentityError(
          'The in-memory authorization code is invalid.',
        )
      issuedIdentities.delete(code)
      redeemedCodes.add(code)
      return {
        ...issuedIdentity,
        expiresAt: now() + tokenLifetimeMilliseconds,
        nonce: record.nonce,
      }
    },

    logoutUrl(postLogoutRedirectUri) {
      return postLogoutRedirectUri
    },
  }
}

function identity(input: TestEntraIdentity): ResolvedTestEntraIdentity {
  const tenantId = normalizeCanonicalUuid(
    input.tenantId ?? DEVELOPMENT_ENTRA_TENANT_ID,
  )
  if (tenantId === null)
    throw new Error('The test Entra tenant must be a canonical UUID.')
  const objectId = normalizeCanonicalUuid(
    input.objectId ?? DEVELOPMENT_ENTRA_OBJECT_ID,
  )
  if (objectId === null)
    throw new Error('The test Entra object identifier must be a canonical UUID.')
  return {
    tenantId,
    objectId,
    displayName: input.displayName?.trim() || 'Development Researcher',
  }
}
