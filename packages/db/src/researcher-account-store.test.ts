import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createResearcherAccountStore,
  normalizeResearcherEmail,
  type ResearcherAccountRecord,
} from './researcher-account-store.js'

type AccountInput = Pick<
  ResearcherAccountRecord,
  | 'email'
  | 'passwordHash'
  | 'mustChangePassword'
  | 'disabledAt'
  | 'sessionVersion'
>
type AccountFilter = Partial<Pick<ResearcherAccountRecord, 'id' | 'email' | 'sessionVersion'>>
type AccountUpdate = Partial<
  Pick<
    ResearcherAccountRecord,
    'passwordHash' | 'mustChangePassword' | 'disabledAt' | 'sessionVersion'
  >
>

const ACCOUNT_ID = '52000000-0000-4000-8000-000000000001'
const CREATED_AT = new Date('2026-08-20T09:00:00.000Z')
const UPDATED_AT = new Date('2026-08-20T09:01:00.000Z')

function fakeDatabase(options: { raceOnFirstUpdate?: boolean } = {}) {
  const accounts: ResearcherAccountRecord[] = []
  const projectContexts = [
    {
      id: '51000000-0000-4000-8000-000000000001',
      name: 'Durable research',
    },
  ]
  let updateRaced = false

  const matches = (account: ResearcherAccountRecord, filter: AccountFilter) =>
    Object.entries(filter).every(
      ([field, value]) => account[field as keyof ResearcherAccountRecord] === value,
    )

  const ResearcherAccount = {
    async create(input: AccountInput) {
      if (accounts.some((account) => account.email === input.email))
        throw Object.assign(new Error('unique constraint'), { sqlState: '23505' })
      const account: ResearcherAccountRecord = {
        id: ACCOUNT_ID,
        ...input,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
      }
      accounts.push(account)
      return account
    },
    select(...fields: Array<keyof ResearcherAccountRecord>) {
      return {
        async first(filter: AccountFilter) {
          const account = accounts.find((candidate) => matches(candidate, filter))
          if (!account) return null
          return Object.fromEntries(fields.map((field) => [field, account[field]]))
        },
      }
    },
    where(filter: AccountFilter) {
      return {
        async update(input: AccountUpdate) {
          const index = accounts.findIndex((account) => matches(account, filter))
          if (index === -1) return null
          if (options.raceOnFirstUpdate && !updateRaced) {
            updateRaced = true
            accounts[index] = {
              ...accounts[index],
              sessionVersion: accounts[index].sessionVersion + 1,
              updatedAt: UPDATED_AT,
            }
            return null
          }
          accounts[index] = {
            ...accounts[index],
            ...input,
            updatedAt: UPDATED_AT,
          }
          return accounts[index]
        },
      }
    },
  }

  return {
    accounts,
    projectContexts,
    database: { orm: { public: { ResearcherAccount } } },
  }
}

describe('ResearcherAccountStore', () => {
  it('normalizes email by trimming and locale-independent lowercasing', () => {
    assert.equal(
      normalizeResearcherEmail(' \tResearcher@EXAMPLE.ORG\n'),
      'researcher@example.org',
    )
    assert.equal(normalizeResearcherEmail('I@EXAMPLE.ORG'), 'i@example.org')
  })

  it('creates and finds one canonical account across email case variants', async () => {
    const fixture = fakeDatabase()
    const store = createResearcherAccountStore(fixture.database as never)
    const created = await store.create(
      '  Researcher@Example.ORG ',
      'scrypt$v1$temporary',
    )

    assert.deepEqual(created, {
      id: ACCOUNT_ID,
      email: 'researcher@example.org',
      passwordHash: 'scrypt$v1$temporary',
      mustChangePassword: true,
      disabledAt: null,
      sessionVersion: 0,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    assert.deepEqual(
      await store.findByEmail('RESEARCHER@EXAMPLE.org'),
      created,
    )
    assert.deepEqual(await store.findById(ACCOUNT_ID), created)

    await assert.rejects(
      store.create('researcher@example.ORG', 'scrypt$v1$other'),
      /unique constraint/,
    )
    assert.equal(fixture.accounts.length, 1)
  })

  it('replaces passwords, controls mandatory change, and revokes sessions', async () => {
    const fixture = fakeDatabase()
    const store = createResearcherAccountStore(fixture.database as never)
    const researchBefore = structuredClone(fixture.projectContexts)
    await store.create('researcher@example.org', 'scrypt$v1$temporary')

    const reset = await store.replacePassword(
      ACCOUNT_ID,
      0,
      'scrypt$v1$operator-reset',
      true,
    )
    assert.equal(reset?.passwordHash, 'scrypt$v1$operator-reset')
    assert.equal(reset?.mustChangePassword, true)
    assert.equal(reset?.sessionVersion, 1)

    const changed = await store.replacePassword(
      ACCOUNT_ID,
      1,
      'scrypt$v1$researcher-choice',
      false,
    )
    assert.equal(changed?.passwordHash, 'scrypt$v1$researcher-choice')
    assert.equal(changed?.mustChangePassword, false)
    assert.equal(changed?.sessionVersion, 2)
    assert.equal(changed?.disabledAt, null)
    assert.deepEqual(fixture.projectContexts, researchBefore)
  })

  it('rejects a raced password update instead of overwriting newer authority', async () => {
    const fixture = fakeDatabase({ raceOnFirstUpdate: true })
    const store = createResearcherAccountStore(fixture.database as never)
    await store.create('researcher@example.org', 'scrypt$v1$temporary')

    const changed = await store.replacePassword(
      ACCOUNT_ID,
      0,
      'scrypt$v1$replacement',
      false,
    )

    assert.equal(changed, null)
    assert.equal(fixture.accounts[0].passwordHash, 'scrypt$v1$temporary')
    assert.equal(fixture.accounts[0].sessionVersion, 1)
  })

  it('disables without deleting account or research data and revokes sessions', async () => {
    const fixture = fakeDatabase()
    const store = createResearcherAccountStore(fixture.database as never)
    const researchBefore = structuredClone(fixture.projectContexts)
    await store.create('researcher@example.org', 'scrypt$v1$temporary')
    const disabledAt = new Date('2026-08-20T10:00:00.000Z')

    const disabled = await store.disable(ACCOUNT_ID, disabledAt)

    assert.equal(disabled?.disabledAt, disabledAt)
    assert.equal(disabled?.sessionVersion, 1)
    assert.equal(disabled?.passwordHash, 'scrypt$v1$temporary')
    assert.equal(disabled?.mustChangePassword, true)
    assert.equal(fixture.accounts.length, 1)
    assert.deepEqual(fixture.projectContexts, researchBefore)
  })

  it('returns null when password update or disable targets no account', async () => {
    const store = createResearcherAccountStore(fakeDatabase().database as never)

    assert.equal(
      await store.replacePassword(
        ACCOUNT_ID,
        0,
        'scrypt$v1$replacement',
        true,
      ),
      null,
    )
    assert.equal(await store.disable(ACCOUNT_ID), null)
  })
})
