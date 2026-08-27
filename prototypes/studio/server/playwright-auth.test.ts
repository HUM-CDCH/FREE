import { describe, expect, it } from 'vitest'
import {
  DEVELOPMENT_ENTRA_OBJECT_ID,
  DEVELOPMENT_ENTRA_TENANT_ID,
} from './entraIdentityProvider.js'
import {
  createPlaywrightAccountStore,
  PLAYWRIGHT_RESEARCHER_ID,
  PLAYWRIGHT_SECOND_ENTRA_OBJECT_ID,
  PLAYWRIGHT_SECOND_RESEARCHER_ID,
} from './playwright-auth.js'

describe('browser-only Entra account store', () => {
  it('JIT provisions stable local ids for the two browser identities', async () => {
    const store = createPlaywrightAccountStore()
    const first = await store.findOrCreate({
      tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
      objectId: DEVELOPMENT_ENTRA_OBJECT_ID,
      displayName: 'First Researcher',
    })
    const second = await store.findOrCreate({
      tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
      objectId: PLAYWRIGHT_SECOND_ENTRA_OBJECT_ID,
      displayName: 'Second Researcher',
    })

    expect(first.id).toBe(PLAYWRIGHT_RESEARCHER_ID)
    expect(second.id).toBe(PLAYWRIGHT_SECOND_RESEARCHER_ID)
    expect(await store.findById(first.id)).toEqual(first)
    expect(await store.findById(second.id)).toEqual(second)
  })

  it('refreshes displayName without changing the immutable Entra identity', async () => {
    const store = createPlaywrightAccountStore()
    const identity = {
      tenantId: DEVELOPMENT_ENTRA_TENANT_ID,
      objectId: DEVELOPMENT_ENTRA_OBJECT_ID,
      displayName: 'Before',
    }
    const before = await store.findOrCreate(identity)
    const after = await store.findOrCreate({ ...identity, displayName: 'After' })
    expect(after).toMatchObject({
      id: before.id,
      tenantId: identity.tenantId,
      objectId: identity.objectId,
      displayName: 'After',
    })
  })
})
