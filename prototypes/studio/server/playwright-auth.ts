import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
} from 'db'
import {
  DEVELOPMENT_ENTRA_OBJECT_ID,
  DEVELOPMENT_ENTRA_TENANT_ID,
  type EntraIdentity,
} from './entraIdentityProvider.js'
import { normalizeCanonicalUuid } from 'studio-configuration'

export const PLAYWRIGHT_RESEARCHER_ID =
  '70000000-0000-4000-8000-000000000001'
export const PLAYWRIGHT_SECOND_RESEARCHER_ID =
  '70000000-0000-4000-8000-000000000002'
export const PLAYWRIGHT_SECOND_ENTRA_OBJECT_ID =
  '70000000-0000-4000-8000-000000000003'

const PLAYWRIGHT_IDENTITY_LIFETIME_MILLISECONDS = 75 * 60 * 1_000

export type PlaywrightAuthentication = (
  request: Request,
) => EntraIdentity | null

/** Explicit identity selection available only in loopback Playwright mode. */
export function createPlaywrightAuthentication(
  now: () => number = Date.now,
): PlaywrightAuthentication {
  return (request) => {
    const selections = new URL(request.url).searchParams.getAll('testIdentity')
    if (selections.length === 0) return null
    const objectId =
      selections.length === 1
        ? normalizeCanonicalUuid(selections[0])
        : null
    if (objectId === null)
      throw new Error(
        'Playwright authentication requires one canonical testIdentity.',
      )
    return {
      tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
      objectId,
      displayName:
        objectId === DEVELOPMENT_ENTRA_OBJECT_ID
          ? 'Development Researcher'
          : `Test Researcher ${objectId.slice(0, 8)}`,
      expiresAt: now() + PLAYWRIGHT_IDENTITY_LIFETIME_MILLISECONDS,
      nonce: 'Playwright authentication bypasses the OIDC transaction.',
    }
  }
}

/**
 * Browser-only specs avoid PostgreSQL while keeping account identity stable.
 * Every selected identity is JIT-provisioned into this process-local store.
 */
export function createPlaywrightAccountStore(): ResearcherAccountStore {
  const accounts = new Map<string, ResearcherAccountRecord>()
  const identityKey = (tenantId: string, objectId: string) =>
    `${tenantId}:${objectId}`

  return {
    async findOrCreate(identity) {
      const key = identityKey(identity.tenantId, identity.objectId)
      const existing = accounts.get(key)
      if (existing) {
        const refreshed = {
          ...existing,
          displayName: identity.displayName,
          updatedAt: new Date(),
        }
        accounts.set(key, refreshed)
        return refreshed
      }

      const createdAt = new Date('2026-08-24T00:00:00.000Z')
      const id =
        identity.tenantId === DEVELOPMENT_ENTRA_TENANT_ID &&
        identity.objectId === DEVELOPMENT_ENTRA_OBJECT_ID
          ? PLAYWRIGHT_RESEARCHER_ID
          : identity.tenantId === DEVELOPMENT_ENTRA_TENANT_ID &&
              identity.objectId === PLAYWRIGHT_SECOND_ENTRA_OBJECT_ID
            ? PLAYWRIGHT_SECOND_RESEARCHER_ID
            : identity.objectId
      const account: ResearcherAccountRecord = {
        id,
        ...identity,
        createdAt,
        updatedAt: createdAt,
      }
      accounts.set(key, account)
      return account
    },

    async findById(id) {
      return (
        [...accounts.values()].find((account) => account.id === id) ?? null
      )
    },
  }
}
