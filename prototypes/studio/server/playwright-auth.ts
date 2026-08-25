import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
} from 'db'
import { hashPassword } from './password.js'

export const PLAYWRIGHT_RESEARCHER_ID =
  '70000000-0000-4000-8000-000000000001'
export const PLAYWRIGHT_SECOND_RESEARCHER_ID =
  '70000000-0000-4000-8000-000000000002'
export const PLAYWRIGHT_SECOND_RESEARCHER_EMAIL =
  'browser-second@example.test'

/**
 * A process-local Researcher Account for browser-only Playwright specs.
 * The Vite composition root loads it only when the Playwright server opts in;
 * database-backed browser profiles continue to use the real account store.
 */
export async function createPlaywrightAccountStore(
  email: string,
  password: string,
): Promise<ResearcherAccountStore> {
  const now = new Date('2026-08-24T00:00:00.000Z')
  const passwordHash = await hashPassword(password)
  const accounts = new Map<string, ResearcherAccountRecord>(
    [
      [PLAYWRIGHT_RESEARCHER_ID, email],
      [PLAYWRIGHT_SECOND_RESEARCHER_ID, PLAYWRIGHT_SECOND_RESEARCHER_EMAIL],
    ].map(([id, accountEmail]) => [
      id,
      {
        id,
        email: accountEmail.trim().toLowerCase(),
        passwordHash,
        mustChangePassword: false,
        disabledAt: null,
        sessionVersion: 0,
        createdAt: now,
        updatedAt: now,
      },
    ]),
  )

  return {
    async create() {
      throw new Error('The Playwright Researcher Account is fixed.')
    },
    async findByEmail(candidate) {
      const normalizedEmail = candidate.trim().toLowerCase()
      return (
        [...accounts.values()].find(
          (account) => account.email === normalizedEmail,
        ) ?? null
      )
    },
    async findById(id) {
      return accounts.get(id) ?? null
    },
    async replacePassword(
      id,
      expectedSessionVersion,
      passwordHash,
      mustChangePassword,
    ) {
      const account = accounts.get(id)
      if (
        !account ||
        expectedSessionVersion !== account.sessionVersion
      )
        return null
      const updated = {
        ...account,
        passwordHash,
        mustChangePassword,
        sessionVersion: account.sessionVersion + 1,
        updatedAt: new Date(),
      }
      accounts.set(id, updated)
      return updated
    },
    async disable(id, disabledAt = new Date()) {
      const account = accounts.get(id)
      if (!account) return null
      const updated = {
        ...account,
        disabledAt,
        sessionVersion: account.sessionVersion + 1,
        updatedAt: new Date(),
      }
      accounts.set(id, updated)
      return updated
    },
  }
}
