import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { after, test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk'
import { Pool, type PoolClient } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'
import type { AdmittedWorkflow, TransactionalEnqueue } from './pool-client-transaction.js'

/**
 * A row-backed admission's atomicity is PostgreSQL behaviour, so only PostgreSQL can prove it. The check launches DBOS
 * once, with no workflows, only to migrate a throwaway system schema, so an enqueued workflow stays ENQUEUED. It creates
 * its own accounts, so it does not need an empty database, and deletes them and drops the schema when it ends.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('one pooled-client transaction commits or rolls back domain rows and DBOS enqueues together', { timeout: 120_000 }, async (t) => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_pool_client_transaction.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  const [{ db, pool }, { isUniqueViolation, withPoolClientTransaction }] = await Promise.all([
    import('./prisma/db.js'),
    import('./pool-client-transaction.js'),
  ])

  const hex = randomBytes(4).toString('hex')
  const schema = `dbos_check_${hex}`
  const accountIds: string[] = []
  let client: DBOSClient | undefined
  after(async () => {
    try {
      await client?.destroy()
      await DBOS.shutdown()
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      for (const id of accountIds) await db.orm.public.ResearcherAccount.where({ id }).delete()
    } finally {
      await db.close()
      await pool.end()
    }
  })

  DBOS.setConfig({
    name: 'free-db-check',
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: schema,
    applicationVersion: 'check@1',
    executorID: `db-check-${hex}`,
    enableOTLP: false,
    logLevel: 'error',
  })
  await DBOS.launch()
  const admission = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    systemDatabaseSchemaName: schema,
    applicationName: 'studio',
  })
  client = admission
  const enqueue: TransactionalEnqueue = async (pgClient, workflow, input) => {
    await admission.enqueueInTransaction(pgClient, { ...workflow, attributes: { ...workflow.attributes } }, input)
  }

  /** A new account's fields under `id`, remembered for deletion whether or not its transaction commits. */
  function account(id: string, displayName = 'Admission check') {
    accountIds.push(id)
    return { id, tenantId: randomUUID(), objectId: randomUUID(), displayName }
  }
  function admitted(workflowID: string, owner: string): AdmittedWorkflow {
    return {
      workflowName: 'runExtraction',
      workflowID,
      queueName: 'studio',
      authenticatedUser: owner,
      attributes: { projectContextId: owner, kind: 'check' },
    }
  }
  const newWorkflowId = () => `suggest:${randomUUID()}:1`

  await t.test('a rollback after domain writes and an enqueue leaves neither the row nor the workflow', async () => {
    const id = randomUUID()
    const workflowID = newWorkflowId()
    const sentinel = new Error('roll back the admission')
    await assert.rejects(
      withPoolClientTransaction(async (transaction, pgClient) => {
        await transaction.orm.public.ResearcherAccount.create(account(id))
        await enqueue(pgClient, admitted(workflowID, id), { id })
        throw sentinel
      }),
      (error) => error === sentinel,
    )
    assert.equal(await db.orm.public.ResearcherAccount.first({ id }), null)
    assert.equal(await admission.getWorkflow(workflowID), undefined)
  })

  await t.test('a commit makes the row and the ENQUEUED workflow visible together, owned by studio', async () => {
    const id = randomUUID()
    const workflowID = newWorkflowId()
    const committed = await withPoolClientTransaction(async (transaction, pgClient) => {
      const created = await transaction.orm.public.ResearcherAccount.create(account(id))
      await enqueue(pgClient, admitted(workflowID, id), { id })
      // Another connection sees neither half before the commit.
      assert.equal(await db.orm.public.ResearcherAccount.first({ id }), null)
      assert.equal(await admission.getWorkflow(workflowID), undefined)
      return created.id
    })
    assert.equal(committed, id)
    assert.equal((await db.orm.public.ResearcherAccount.first({ id }))?.id, id)
    const workflow = await admission.getWorkflow(workflowID)
    assert.ok(workflow)
    assert.equal(workflow.status, 'ENQUEUED')
    assert.equal(workflow.applicationName, 'studio')
    assert.equal(workflow.workflowName, 'runExtraction')
    assert.equal(workflow.queueName, 'studio')
    assert.equal(workflow.authenticatedUser, id)
    assert.deepEqual(workflow.attributes, { projectContextId: id, kind: 'check' })
  })

  await t.test('a unique violation inside the transaction rolls back its enqueue, and a new transaction can replay it', async () => {
    const id = randomUUID()
    await withPoolClientTransaction(async (transaction) => {
      await transaction.orm.public.ResearcherAccount.create(account(id, 'First'))
    })
    const workflowID = newWorkflowId()
    const rejection = await withPoolClientTransaction(async (transaction, pgClient) => {
      await enqueue(pgClient, admitted(workflowID, id), { id })
      await transaction.orm.public.ResearcherAccount.create(account(id, 'Second'))
    }).then(
      () => assert.fail('The second insert of one primary key committed.'),
      (error: unknown) => error,
    )
    assert.equal(isUniqueViolation(rejection), true)
    assert.equal(isUniqueViolation(rejection, 'researcherAccount_pkey'), true)
    assert.equal(isUniqueViolation(rejection, 'researcherAccount_tenantId_objectId_key'), false)
    assert.equal(await admission.getWorkflow(workflowID), undefined)
    const replayed = await withPoolClientTransaction((transaction) =>
      transaction.orm.public.ResearcherAccount.first({ id }),
    )
    assert.equal(replayed?.displayName, 'First')
  })

  await t.test('the pool keeps serving after twenty admissions, rollbacks and SQL errors, and no committed admission ended its client', async () => {
    // Count the clients that end among those the pool hands out: pg-pool emits `acquire` on every checkout, including
    // pool.query's own, which passes connect() a callback.
    const watched = new WeakSet<PoolClient>()
    let ended = 0
    const watch = (pgClient: PoolClient) => {
      if (watched.has(pgClient)) return
      watched.add(pgClient)
      pgClient.on('end', () => {
        ended += 1
      })
    }
    pool.on('acquire', watch)
    try {
      const committed: string[] = []
      for (let n = 0; n < 20; n += 1) {
        const id = randomUUID()
        const workflowID = newWorkflowId()
        await withPoolClientTransaction(async (transaction, pgClient) => {
          await transaction.orm.public.ResearcherAccount.create(account(id, `Admission ${n}`))
          await enqueue(pgClient, admitted(workflowID, id), { id })
        })
        committed.push(workflowID)
      }
      await setTimeout(100) // an ended client emits 'end' asynchronously
      assert.equal(ended, 0)
      assert.ok(pool.totalCount <= 10, `the pool holds ${pool.totalCount} clients`)
      assert.ok(pool.idleCount >= 1, 'a committed admission returns its client to the pool')
      const statuses = await admission.listWorkflows({ workflowIDs: committed, loadInput: false, loadOutput: false })
      assert.deepEqual(
        statuses.map((status) => status.status),
        committed.map(() => 'ENQUEUED'),
      )

      const failed: string[] = []
      for (let n = 0; n < 5; n += 1) {
        const id = randomUUID()
        const workflowID = newWorkflowId()
        failed.push(workflowID)
        const sentinel = new Error(`roll back ${n}`)
        await assert.rejects(
          withPoolClientTransaction(async (transaction, pgClient) => {
            await transaction.orm.public.ResearcherAccount.create(account(id))
            await enqueue(pgClient, admitted(workflowID, id), { id })
            throw sentinel
          }),
          (error) => error === sentinel,
        )
      }
      for (let n = 0; n < 5; n += 1) {
        const id = randomUUID()
        const workflowID = newWorkflowId()
        failed.push(workflowID)
        await assert.rejects(
          withPoolClientTransaction(async (transaction, pgClient) => {
            await transaction.orm.public.ResearcherAccount.create(account(id))
            await enqueue(pgClient, admitted(workflowID, id), { id })
            await pgClient.query('SELECT 1 / 0')
          }),
          (error: { code?: unknown }) => error.code === '22012' && !isUniqueViolation(error),
        )
      }
      assert.deepEqual((await pool.query('SELECT 1 AS one')).rows, [{ one: 1 }])
      assert.deepEqual(
        await admission.listWorkflows({ workflowIDs: failed, loadInput: false, loadOutput: false }),
        [],
      )
      // A failed admission destroys its client rather than returning a connection in an unknown state.
      for (let waited = 0; ended < 10 && waited < 5_000; waited += 50) await setTimeout(50)
      assert.equal(ended, 10)
      assert.ok(pool.totalCount <= 10, `the pool holds ${pool.totalCount} clients`)
    } finally {
      pool.removeListener('acquire', watch)
    }
  })

  await t.test('a transaction whose BEGIN fails destroys its client instead of leaking it', async () => {
    // A one-client pool whose checkout loses its server connection before the helper can BEGIN on it.
    const source = new Pool({ connectionString: databaseUrl, max: 1 })
    source.on('error', () => {})
    try {
      const checkout = source.connect.bind(source) as () => Promise<PoolClient>
      const severed = Object.create(source, {
        connect: {
          value: async () => {
            const pgClient = await checkout()
            const { rows } = await pgClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
            const disconnected = once(pgClient, 'error')
            await pool.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid])
            await disconnected
            return pgClient
          },
        },
      }) as Pool
      let ran = false
      await assert.rejects(
        withPoolClientTransaction(async () => {
          ran = true
        }, severed),
      )
      assert.equal(ran, false)
      assert.equal(source.totalCount, 0)
      // A leaked client would hold the pool's only slot, and this query would wait for it forever.
      assert.deepEqual((await source.query('SELECT 1 AS one')).rows, [{ one: 1 }])
    } finally {
      await source.end()
    }
  })

  await t.test('two concurrent admissions of one primary key: one commits, the other fails with a unique violation and leaves no workflow', async () => {
    const id = randomUUID()
    const workflowIds = [newWorkflowId(), newWorkflowId()]
    // Both transactions are open before either inserts, so the second insert waits on the first's row.
    let entered = 0
    const bothEntered = Promise.withResolvers<void>()
    const results = await Promise.allSettled(
      workflowIds.map((workflowID) =>
        withPoolClientTransaction(async (transaction, pgClient) => {
          entered += 1
          if (entered === 2) bothEntered.resolve()
          await bothEntered.promise
          await transaction.orm.public.ResearcherAccount.create(account(id))
          await enqueue(pgClient, admitted(workflowID, id), { id })
          return workflowID
        }),
      ),
    )
    const winners = results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    const losers = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    assert.equal(winners.length, 1)
    assert.equal(losers.length, 1)
    assert.equal(isUniqueViolation(losers[0], 'researcherAccount_pkey'), true)
    const [winner] = winners
    const loser = workflowIds.find((workflowID) => workflowID !== winner)!
    assert.equal((await admission.getWorkflow(winner!))?.status, 'ENQUEUED')
    assert.equal(await admission.getWorkflow(loser), undefined)
    assert.equal((await db.orm.public.ResearcherAccount.first({ id }))?.id, id)
  })
})
