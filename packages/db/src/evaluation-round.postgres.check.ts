import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/**
 * EvaluationRound ownership, append-only rounds and the Project Context cascade
 * are PostgreSQL behaviour, so only PostgreSQL can prove them. The check makes
 * its own account, so it needs no empty database, and deletes it when it ends.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('PostgreSQL stores developer evaluation rounds and cascades them with the project', async () => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_evaluation_round.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  const [{ db, pool }, { createResearcherProjectStore }] = await Promise.all([
    import('./prisma/db.js'),
    import('./project-store.js'),
  ])
  let accountId: string | undefined
  after(async () => {
    try {
      if (accountId) await db.orm.public.ResearcherAccount.where({ id: accountId }).delete()
    } finally {
      await db.close()
      await pool.end()
    }
  })

  const account = await db.orm.public.ResearcherAccount.create({
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Evaluation rounds',
  })
  accountId = account.id
  const store = createResearcherProjectStore(account.id, db)

  const project = await store.createProjectContext('Rounds')
  const projectContextId = project.projectContextId
  const pipelineRunId = randomUUID()

  const pilot = await store.appendEvaluationRound(projectContextId, {
    pipelineRunId,
    label: 'PILOT_1',
    documents: [{ filename: 'a.pdf' }],
    pins: { schemaDigest: 'sha256:demo' },
  })
  assert.equal(pilot?.status, 'PENDING')
  assert.equal(pilot?.pins && (pilot.pins as { schemaDigest: string }).schemaDigest, 'sha256:demo')

  const completed = await store.completeEvaluationRound(
    projectContextId,
    pilot!.evaluationRoundId,
    { status: 'SUCCEEDED', metrics: { micro: { f1: 1 } } },
  )
  assert.equal(completed?.status, 'SUCCEEDED')
  assert.deepEqual(completed?.metrics, { micro: { f1: 1 } })
  assert.ok(completed?.completedAt instanceof Date)

  await store.appendEvaluationRound(projectContextId, {
    pipelineRunId,
    label: 'PILOT_2',
    documents: [],
  })
  await store.appendEvaluationRound(projectContextId, {
    pipelineRunId,
    label: 'BATCH',
    documents: [],
  })
  const rounds = await store.listEvaluationRounds(projectContextId, 10)
  assert.equal(rounds?.length, 3)
  assert.equal(await store.getEvaluationRound(projectContextId, pilot!.evaluationRoundId).then((round) => round?.label), 'PILOT_1')

  // Deleting the Project Context removes its rounds.
  assert.notEqual(await store.deleteProjectContext(projectContextId), null)
  const remaining = await db.orm.public.EvaluationRound.where({ projectContextId })
    .select('id')
    .all()
  assert.equal(remaining.length, 0)
})
