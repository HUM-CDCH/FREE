import { describe, expect, it } from 'vitest'
import type { ResearcherAccountRecord } from 'db'
import { sessionView, type AuthenticationState } from '../server/auth'
import { authSessionSchema } from './authSession.contract'

function account(mustChangePassword: boolean): ResearcherAccountRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    email: 'researcher@example.org',
    passwordHash: 'argon2id$not-a-real-hash',
    mustChangePassword,
    disabledAt: null,
    sessionVersion: 3,
    createdAt: new Date('2026-08-23T00:00:00.000Z'),
    updatedAt: new Date('2026-08-23T00:00:00.000Z'),
  }
}

const authenticatedState = (
  mustChangePassword: boolean,
): AuthenticationState => ({
  authenticated: true,
  account: account(mustChangePassword),
  renewalCookie: 'free_studio_session=renewed; Path=/; HttpOnly',
})

describe('session view client/server contract', () => {
  it('accepts the anonymous session view the server produces', () => {
    const view = sessionView({ authenticated: false, clearCookie: true })

    expect(authSessionSchema.parse(view)).toEqual({ authenticated: false })
  })

  it.each([true, false])(
    'accepts the authenticated session view with mustChangePassword %s',
    (mustChangePassword) => {
      const view = sessionView(authenticatedState(mustChangePassword))

      expect(authSessionSchema.parse(view)).toEqual({
        authenticated: true,
        account: {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'researcher@example.org',
          mustChangePassword,
        },
      })
    },
  )

  it('rejects an account carrying a field the client does not know', () => {
    const view = sessionView(authenticatedState(false))
    const drifted = {
      ...view,
      account: { ...(view as { account: object }).account, role: 'admin' },
    }

    expect(authSessionSchema.safeParse(drifted).success).toBe(false)
  })
})
