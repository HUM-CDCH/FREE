import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  createResearcherAccountStore,
  type EntraResearcherIdentity,
  type ResearcherAccountRecord,
} from './researcher-account-store.js'

const ACCOUNT_ID = '52000000-0000-4000-8000-000000000001'
const TENANT_ID = '52000000-0000-4000-8000-000000000002'
const OBJECT_ID = '52000000-0000-4000-8000-000000000003'
const CREATED_AT = new Date('2026-08-20T09:00:00.000Z')
const UPDATED_AT = new Date('2026-08-20T09:01:00.000Z')

const identity = (
  displayName = 'Ada Researcher',
): EntraResearcherIdentity => ({
  tenantId: TENANT_ID,
  objectId: OBJECT_ID,
  displayName,
})

function fakeDatabase(options: {
  concurrentWinner?: ResearcherAccountRecord
  unrelatedUniqueFailure?: boolean
} = {}) {
  const accounts: ResearcherAccountRecord[] = []
  let createAttempted = false
  const ResearcherAccount = {
    async create(input: EntraResearcherIdentity) {
      if (!createAttempted && options.concurrentWinner) {
        createAttempted = true
        accounts.push(options.concurrentWinner)
        throw Object.assign(new Error('unique constraint'), {
          sqlState: '23505',
        })
      }
      if (options.unrelatedUniqueFailure)
        throw Object.assign(new Error('unique constraint'), {
          sqlState: '23505',
        })
      if (
        accounts.some(
          (account) =>
            account.tenantId === input.tenantId &&
            account.objectId === input.objectId,
        )
      )
        throw Object.assign(new Error('unique constraint'), {
          sqlState: '23505',
        })
      const account = {
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
        async first(filter: Partial<ResearcherAccountRecord>) {
          const account = accounts.find((candidate) =>
            Object.entries(filter).every(
              ([field, value]) =>
                candidate[field as keyof ResearcherAccountRecord] === value,
            ),
          )
          if (!account) return null
          return Object.fromEntries(
            fields.map((field) => [field, account[field]]),
          )
        },
      }
    },
    where(filter: Pick<ResearcherAccountRecord, 'id'>) {
      return {
        async update(update: Pick<ResearcherAccountRecord, 'displayName'>) {
          const index = accounts.findIndex(({ id }) => id === filter.id)
          if (index === -1) return null
          accounts[index] = {
            ...accounts[index],
            ...update,
            updatedAt: UPDATED_AT,
          }
          return accounts[index]
        },
      }
    },
  }
  return { accounts, database: { orm: { public: { ResearcherAccount } } } }
}

describe('ResearcherAccountStore', () => {
  it('creates and looks up an account by immutable Entra identity', async () => {
    const fixture = fakeDatabase()
    const store = createResearcherAccountStore(fixture.database as never)

    const created = await store.findOrCreate(identity())

    assert.deepEqual(created, {
      id: ACCOUNT_ID,
      ...identity(),
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
    assert.deepEqual(await store.findById(ACCOUNT_ID), created)
    assert.equal(fixture.accounts.length, 1)
  })

  it('persists only account fields from a full Entra sign-in identity', async () => {
    const fixture = fakeDatabase()
    const store = createResearcherAccountStore(fixture.database as never)
    const signInIdentity = {
      ...identity(),
      nonce: 'authorization-transaction-nonce',
      expiresAt: Date.now() + 60_000,
    }

    const created = await store.findOrCreate(signInIdentity)

    assert.deepEqual(created, {
      id: ACCOUNT_ID,
      ...identity(),
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    })
  })

  it('refreshes the mutable Entra display name without changing identity', async () => {
    const fixture = fakeDatabase()
    const store = createResearcherAccountStore(fixture.database as never)
    const created = await store.findOrCreate(identity())

    const refreshed = await store.findOrCreate(identity('Ada Lovelace'))

    assert.equal(refreshed.id, created.id)
    assert.equal(refreshed.displayName, 'Ada Lovelace')
    assert.equal(refreshed.updatedAt, UPDATED_AT)
    assert.equal(fixture.accounts.length, 1)
  })

  it('returns and refreshes the winner of a concurrent first sign-in', async () => {
    const concurrentWinner: ResearcherAccountRecord = {
      id: ACCOUNT_ID,
      ...identity('Stale Entra name'),
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }
    const fixture = fakeDatabase({ concurrentWinner })
    const store = createResearcherAccountStore(fixture.database as never)

    const account = await store.findOrCreate(identity('Current Entra name'))

    assert.equal(account.id, ACCOUNT_ID)
    assert.equal(account.displayName, 'Current Entra name')
    assert.equal(fixture.accounts.length, 1)
  })

  it('does not hide an unrelated unique-constraint failure', async () => {
    const fixture = fakeDatabase({ unrelatedUniqueFailure: true })
    const store = createResearcherAccountStore(fixture.database as never)

    await assert.rejects(
      store.findOrCreate(identity()),
      /unique constraint/,
    )
  })
})
