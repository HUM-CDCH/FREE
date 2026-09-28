import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/**
 * The configuration row's lock and its cascade are PostgreSQL behaviour, so only PostgreSQL can prove them. The check
 * creates its own accounts, so it does not need an empty database, and deletes them when it ends.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('PostgreSQL keeps one Model Configuration per Researcher Account and serializes its applies', async (t) => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_model_configuration.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  const [
    { db, pool },
    { createModelConfigurationStore },
    { createInternalProjectWorkerStore, createResearcherProjectStore },
    { lockModelConfiguration },
  ] = await Promise.all([
    import('./prisma/db.js'),
    import('./model-configuration-store.js'),
    import('./project-store.js'),
    import('./row-lock.js'),
  ])
  const accountIds: string[] = []
  after(async () => {
    try {
      for (const id of accountIds)
        await db.orm.public.ResearcherAccount.where({ id }).delete()
    } finally {
      await db.close()
      await pool.end()
    }
  })

  async function createAccount(displayName: string) {
    const account = await db.orm.public.ResearcherAccount.create({
      tenantId: randomUUID(),
      objectId: randomUUID(),
      displayName,
    })
    accountIds.push(account.id)
    return account
  }

  const store = createModelConfigurationStore(db)

  await t.test('an account that never applied reads null', async () => {
    const account = await createAccount('Never applied')
    assert.equal(await store.read(account.id), null)
  })

  await t.test('an apply is read back, and another account still reads null', async () => {
    const a = await createAccount('Applies')
    const b = await createAccount('Bystander')
    let previous: unknown = 'not called'
    const stored = await store.apply(a.id, (committed) => {
      previous = committed
      return { models: ['first'] }
    })
    assert.equal(previous, null)
    assert.deepEqual(stored, { models: ['first'] })
    assert.deepEqual(await store.read(a.id), { models: ['first'] })
    assert.equal(await store.read(b.id), null)

    await store.apply(a.id, (committed) => {
      previous = committed
      return { models: ['second'] }
    })
    assert.deepEqual(previous, { models: ['first'] })
    assert.deepEqual(await store.read(a.id), { models: ['second'] })
  })

  await t.test('a failing next writes nothing, not even the row', async () => {
    const account = await createAccount('Failing next')
    const failure = new Error('invalid configuration')
    await assert.rejects(
      store.apply(account.id, () => {
        throw failure
      }),
      (error) => error === failure,
    )
    assert.equal(
      await db.orm.public.ModelConfiguration.select('researcherAccountId').first({
        researcherAccountId: account.id,
      }),
      null,
    )
    assert.equal(await store.read(account.id), null)
  })

  await t.test('a next that returns no document commits nothing', async () => {
    const account = await createAccount('No document')
    await store.apply(account.id, () => ({ models: ['kept'] }))
    for (const empty of [null, undefined])
      await assert.rejects(store.apply(account.id, () => empty), /must store a document/)
    assert.deepEqual(await store.read(account.id), { models: ['kept'] })

    const fresh = await createAccount('No first document')
    await assert.rejects(store.apply(fresh.id, () => null), /must store a document/)
    assert.equal(
      await db.orm.public.ModelConfiguration.select('researcherAccountId').first({ researcherAccountId: fresh.id }),
      null,
    )
  })

  async function assertConcurrentAppliesSerialize(researcherAccountId: string) {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const first = store.apply(researcherAccountId, async () => {
      entered.resolve()
      await release.promise
      return { n: 1 }
    })
    let seen: unknown = 'not yet'
    let second: Promise<unknown> | undefined
    try {
      // A first apply that fails or stalls before entering its next must fail the check, not hang it.
      const stop = new AbortController()
      try {
        await Promise.race([
          entered.promise,
          first.then(() => {
            throw new Error('The first apply settled without entering its next.')
          }),
          setTimeout(10_000, undefined, { signal: stop.signal }).then(() => {
            throw new Error('The first apply did not enter its next within 10 s.')
          }),
        ])
      } finally {
        stop.abort()
      }
      second = store.apply(researcherAccountId, (previous) => {
        seen = previous
        return { n: 2 }
      })
      await setTimeout(300)
      assert.equal(seen, 'not yet') // waiting on the configuration row's lock
    } finally {
      // A failed assertion must be reported, not leave the first apply's transaction open forever.
      release.resolve()
    }
    await Promise.all([first, second])
    assert.deepEqual(seen, { n: 1 })
    assert.deepEqual(await store.read(researcherAccountId), { n: 2 })
  }

  await t.test('concurrent applies of one account serialize and the second sees the first\'s document', async (t) => {
    const a = await createAccount('Concurrent')
    await t.test('when both race the first insert', async () => {
      assert.equal(
        await db.orm.public.ModelConfiguration.select('researcherAccountId').first({
          researcherAccountId: a.id,
        }),
        null,
      )
      await assertConcurrentAppliesSerialize(a.id)
    })
    await t.test('after a first apply', async () => {
      assert.deepEqual(await store.read(a.id), { n: 2 })
      await assertConcurrentAppliesSerialize(a.id)
    })
  })

  await t.test('applies of two accounts do not wait for each other', async () => {
    const a = await createAccount('Gated')
    const b = await createAccount('Ungated')
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    let aSettled = false
    const blocked = store.apply(a.id, async () => {
      entered.resolve()
      await gate.promise
      return { account: 'a' }
    })
    void blocked.finally(() => {
      aSettled = true
    }).catch(() => {})
    try {
      await entered.promise
      assert.deepEqual(await store.apply(b.id, () => ({ account: 'b' })), { account: 'b' })
      assert.equal(aSettled, false) // A still holds its own row's lock
      assert.deepEqual(await store.read(b.id), { account: 'b' })
    } finally {
      gate.resolve()
      await blocked
    }
    assert.deepEqual(await store.read(a.id), { account: 'a' })
  })

  await t.test('deleting the account deletes its configuration', async () => {
    const account = await createAccount('Deleted')
    await store.apply(account.id, () => ({ models: [] }))
    assert.ok(
      await db.orm.public.ModelConfiguration.select('researcherAccountId').first({
        researcherAccountId: account.id,
      }),
    )
    await db.orm.public.ResearcherAccount.where({ id: account.id }).delete()
    accountIds.splice(accountIds.indexOf(account.id), 1)
    assert.equal(
      await db.orm.public.ModelConfiguration.select('researcherAccountId').first({
        researcherAccountId: account.id,
      }),
      null,
    )
  })

  await t.test('the table stores no key: only researcherAccountId, document and updatedAt', async () => {
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      const { rows } = await client.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'modelConfiguration' ORDER BY 1",
      )
      assert.deepEqual(
        rows.map((row) => row.column_name),
        ['document', 'researcherAccountId', 'updatedAt'],
      )
    } finally {
      await client.end()
    }
  })

  await t.test('projectContextOwner names the owning account and null for an unknown project', async () => {
    const a = await createAccount('Owner')
    const projects = createResearcherProjectStore(a.id, db)
    const project = await projects.createProjectContext('Owner check')
    try {
      const workerStore = createInternalProjectWorkerStore(db)
      assert.equal(await workerStore.projectContextOwner(project.projectContextId), a.id)
      assert.equal(await workerStore.projectContextOwner(randomUUID()), null)
    } finally {
      assert.equal(await projects.deleteProjectContext(project.projectContextId), true)
    }
  })

  await t.test('an admission lock waits for an apply in flight and then reads what it committed', async () => {
    const account = await createAccount('Locked read')
    await store.apply(account.id, () => ({ version: 1 }))
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const applying = store.apply(account.id, async () => { await held; return { version: 2 } })
    await setTimeout(100)
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query('BEGIN')
      const reading = lockModelConfiguration(client, account.id)
      await setTimeout(100)
      release()
      await applying
      assert.deepEqual(await reading, { version: 2 })
      await client.query('COMMIT')
    } finally {
      await client.end()
    }
  })

  await t.test('an apply waits for a transaction holding the admission lock', async () => {
    const account = await createAccount('Locked apply')
    await store.apply(account.id, () => ({ version: 1 }))
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query('BEGIN')
      assert.deepEqual(await lockModelConfiguration(client, account.id), { version: 1 })
      let applied = false
      const applying = store.apply(account.id, () => ({ version: 2 })).then(() => { applied = true })
      await setTimeout(200)
      assert.equal(applied, false)
      await client.query('COMMIT')
      await applying
      assert.equal(applied, true)
    } finally {
      await client.end()
    }
  })

  await t.test('an account that never applied is read as null and gets no row', async () => {
    const account = await createAccount('Never locked')
    const client = new Client({ connectionString: databaseUrl })
    await client.connect()
    try {
      await client.query('BEGIN')
      assert.equal(await lockModelConfiguration(client, account.id), null)
      await client.query('COMMIT')
    } finally {
      await client.end()
    }
    assert.equal(await db.orm.public.ModelConfiguration.select('researcherAccountId').first({ researcherAccountId: account.id }), null)
  })
})
