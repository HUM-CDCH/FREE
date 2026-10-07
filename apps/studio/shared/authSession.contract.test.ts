import { describe, expect, it } from 'vitest'
import type { ResearcherAccountRecord } from 'db'
import { sessionView, type AuthenticationState } from '../server/auth'
import { authSessionSchema } from './authSession.contract'

const EXPIRES_AT = Date.parse('2026-08-26T20:00:00.000Z')

function account(): ResearcherAccountRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    objectId: '33333333-3333-4333-8333-333333333333',
    displayName: 'Researcher Example',
    createdAt: new Date('2026-08-23T00:00:00.000Z'),
    updatedAt: new Date('2026-08-23T00:00:00.000Z'),
  }
}

const authenticatedState = (): AuthenticationState => ({
  authenticated: true,
  account: account(),
  expiresAt: EXPIRES_AT,
})

describe('session view client/server contract', () => {
  it('accepts the anonymous session view the server produces', () => {
    const view = sessionView({ authenticated: false, clearCookie: true })
    expect(authSessionSchema.parse(view)).toEqual({ authenticated: false })
  })

  it('exposes only local id, mutable display name, and fixed expiry', () => {
    const view = sessionView(authenticatedState())
    expect(authSessionSchema.parse(view)).toEqual({
      authenticated: true,
      account: {
        id: '11111111-1111-4111-8111-111111111111',
        displayName: 'Researcher Example',
      },
      expiresAt: '2026-08-26T20:00:00.000Z',
    })
    expect(JSON.stringify(view)).not.toContain('tenantId')
    expect(JSON.stringify(view)).not.toContain('objectId')
  })

  it('rejects an account carrying a field the client does not know', () => {
    const view = sessionView(authenticatedState())
    const drifted = {
      ...view,
      account: { ...(view as { account: object }).account, role: 'admin' },
    }
    expect(authSessionSchema.safeParse(drifted).success).toBe(false)
  })
})
