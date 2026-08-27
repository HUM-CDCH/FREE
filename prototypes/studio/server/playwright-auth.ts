import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
} from 'db'
import {
  DEVELOPMENT_ENTRA_OBJECT_ID,
  DEVELOPMENT_ENTRA_TENANT_ID,
} from './entraIdentityProvider.js'

export const PLAYWRIGHT_RESEARCHER_ID =
  '70000000-0000-4000-8000-000000000001'
export const PLAYWRIGHT_SECOND_RESEARCHER_ID =
  '70000000-0000-4000-8000-000000000002'
export const PLAYWRIGHT_SECOND_ENTRA_OBJECT_ID =
  '70000000-0000-4000-8000-000000000003'

/**
 * Browser-only specs use the real Entra route shape but avoid PostgreSQL.
 * Every fake Entra identity is JIT-provisioned into this process-local store.
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
