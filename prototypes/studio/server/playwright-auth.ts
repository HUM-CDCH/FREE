import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
} from 'db'
import { hashPassword } from './password.js'

export const PLAYWRIGHT_RESEARCHER_ID =
  '70000000-0000-4000-8000-000000000001'

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
  let account: ResearcherAccountRecord = {
    id: PLAYWRIGHT_RESEARCHER_ID,
    email: email.trim().toLowerCase(),
    passwordHash: await hashPassword(password),
    mustChangePassword: false,
    disabledAt: null,
    sessionVersion: 0,
    createdAt: now,
    updatedAt: now,
  }

  return {
    async create() {
      throw new Error('The Playwright Researcher Account is fixed.')
    },
    async findByEmail(candidate) {
      return candidate.trim().toLowerCase() === account.email ? account : null
    },
    async findById(id) {
      return id === account.id ? account : null
    },
    async replacePassword(
      id,
      expectedSessionVersion,
      passwordHash,
      mustChangePassword,
    ) {
      if (
        id !== account.id ||
        expectedSessionVersion !== account.sessionVersion
      )
        return null
      account = {
        ...account,
        passwordHash,
        mustChangePassword,
        sessionVersion: account.sessionVersion + 1,
        updatedAt: new Date(),
      }
      return account
    },
    async disable(id, disabledAt = new Date()) {
      if (id !== account.id) return null
      account = {
        ...account,
        disabledAt,
        sessionVersion: account.sessionVersion + 1,
        updatedAt: new Date(),
      }
      return account
    },
  }
}
