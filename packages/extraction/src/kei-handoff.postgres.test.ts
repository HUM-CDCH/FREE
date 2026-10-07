import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { DBOSClient } from '@dbos-inc/dbos-sdk'
import pg from 'pg'
import { validateDisposableTestDatabaseTarget } from 'db/database-url'
import {
  createKeiHandoff, KEI_APPLICATION, KEI_QUEUE, keiConvertOkSchema, keiConvertWorkflowId, keiDeleteRunsOkSchema,
  keiNotReady, settleKei, type KeiHandoff, type KeiPoll, type KeiSubmission,
} from './kei-handoff.js'
import { spawnKeiStandIn, type KeiStandInProcess } from './testing/kei-stand-in-client.js'

const databaseUrl = process.env.EXTRACTION_TEST_DATABASE_URL
if (!databaseUrl) throw new Error('Export EXTRACTION_TEST_DATABASE_URL naming a disposable free_test_* database.')
validateDisposableTestDatabaseTarget(databaseUrl)

const CONTRACTS = new URL('../../../apps/parsing_service/tests/fixtures/contracts/', import.meta.url)
const contract = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, CONTRACTS), 'utf8'))
const KEI_EXP = new URL('../../../apps/studio/test/fixtures/kei-exp/', import.meta.url)
const hex = randomBytes(4).toString('hex')
const schema = `kei_dbos_t_${hex}`
/** A kei schema no application ever launched: kei has not migrated it yet. */
const unmigratedSchema = `kei_dbos_t_${randomBytes(4).toString('hex')}`
const cleanup = { failure: { code: 'conversion_failed', reason: 'The test is done with this work.', retryable: false } } as const

let standIn: KeiStandInProcess
let client: DBOSClient
let handoff: KeiHandoff

before(async () => {
  standIn = await spawnKeiStandIn({ databaseUrl, schema })
  client = await DBOSClient.create({ systemDatabaseUrl: databaseUrl, systemDatabaseSchemaName: schema, applicationName: KEI_APPLICATION })
  handoff = createKeiHandoff(client, { pollWindowMs: 3_000, pollIntervalMs: 100 })
})

after(async () => {
  // The stand-in stops before its schema goes, or the drop waits on its connections. A failed stop or destroy still
  // drops the schemas and closes every connection, and its error is reported after that.
  try {
    await standIn?.stop()
  } finally {
    try {
      await client?.destroy()
    } finally {
      const admin = new pg.Client({ connectionString: databaseUrl })
      await admin.connect()
      try {
        for (const name of [schema, unmigratedSchema]) {
          if (!/^kei_dbos_t_[0-9a-f]{8}$/.test(name)) throw new Error(`Refusing to drop schema ${name}.`)
          await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
        }
      } finally {
        await admin.end()
      }
    }
  }
})

function convertSubmission(workflowId: string, attributes: Record<string, unknown> = {}): KeiSubmission {
  const { enqueue, request } = contract('convert.input')
  return {
    workflow: 'convert', workflowId, queueName: enqueue.queue_name, priority: enqueue.priority,
    timeoutMs: enqueue.workflow_timeout_ms, request, authenticatedUser: 'researcher@example.test', attributes,
  }
}

const ingestChild = () => keiConvertWorkflowId(`ingest:${randomUUID()}:${randomUUID()}`)

async function statusOf(workflowId: string) {
  const [row] = await client.listWorkflows({ workflowIDs: [workflowId], loadInput: false, loadOutput: false })
  assert.ok(row, `${workflowId} exists`)
  return row
}

async function eventually(check: () => Promise<boolean>, what: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting until ${what}.`)
    await delay(50)
  }
}

/** Waits until the stand-in holds the child's decision inside its step: kei has dequeued it and is working. */
const heldFor = (workflowId: string) =>
  eventually(async () => (await standIn.held()).some((work) => work.workflowId === workflowId), `${workflowId} is held`)

/** Polls until the child is no longer live; each poll is one bounded step's window. */
async function settled(workflowId: string): Promise<Exclude<KeiPoll, { state: 'live' }>> {
  for (let window = 0; window < 10; window += 1) {
    const poll = await handoff.poll(workflowId)
    if (poll.state !== 'live') return poll
  }
  assert.fail(`${workflowId} stayed live.`)
}

test('submitting a child twice enqueues one kei workflow on its lane with its priority, deadline, owner and the parent\'s attributes', async () => {
  await standIn.policy({ convert: 'hold' })
  const attributes = { projectContextId: randomUUID(), sourceDocumentId: randomUUID() }
  const submission = convertSubmission(ingestChild(), attributes)
  await handoff.submit(submission)
  await handoff.submit(submission)
  await heldFor(submission.workflowId)
  // Listed as a scope's kei work is found: by kei's prefix and the parent's attributes.
  const rows = await client.listWorkflows({ workflow_id_prefix: keiConvertWorkflowId(''), attributes, loadInput: true })
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row?.workflowID, submission.workflowId)
  assert.equal(row?.workflowName, 'convert')
  assert.equal(row?.status, 'PENDING')
  assert.equal(row?.queueName, 'kei-convert-small')
  assert.equal(row?.priority, 1)
  assert.equal(row?.timeoutMS, 600_000)
  assert.equal(typeof row?.deadlineEpochMS, 'number')
  assert.equal(row?.applicationName, 'kei')
  assert.equal(row?.authenticatedUser, 'researcher@example.test')
  assert.deepEqual(row?.attributes, attributes)
  assert.deepEqual(row?.input, [submission.request])
  await standIn.answer(submission.workflowId, cleanup)
  assert.equal((await settled(submission.workflowId)).state, 'SUCCESS')
})

test('a poll returns live within its window while kei works, then the finished output', async () => {
  await standIn.policy({ convert: 'hold' })
  const submission = convertSubmission(ingestChild())
  await handoff.submit(submission)
  await heldFor(submission.workflowId)
  const started = performance.now()
  assert.deepEqual(await handoff.poll(submission.workflowId), { state: 'live' })
  const waited = performance.now() - started
  assert.ok(waited >= 2_900 && waited < 6_000, `the poll waited ${Math.round(waited)} ms`)

  await standIn.answer(submission.workflowId, { convert: 'auto' })
  const poll = await settled(submission.workflowId)
  assert.equal(poll.state, 'SUCCESS')
  const outcome = settleKei(poll, keiConvertOkSchema)
  assert.ok(outcome.ok, JSON.stringify(outcome))
  assert.equal(outcome.value.source_sha256, contract('convert.input').request.source_sha256)
  assert.equal((await fetch(`${standIn.url}/api/runs/${outcome.value.run_id}/result`)).status, 200)
})

test('cancel stops a live kei workflow and leaves a finished one untouched', async () => {
  await standIn.policy({ convert: 'hold' })
  const live = convertSubmission(ingestChild())
  await handoff.submit(live)
  await heldFor(live.workflowId)
  await handoff.cancel(live.workflowId)
  assert.equal((await statusOf(live.workflowId)).status, 'CANCELLED')
  assert.deepEqual(await handoff.poll(live.workflowId), { state: 'CANCELLED', deadlinePassed: false })
  // A repeated cancel of a cancelled child would move its updated_at (M0R 4); the handoff leaves it alone.
  const cancelledAt = (await statusOf(live.workflowId)).updatedAt
  await delay(20)
  await handoff.cancel(live.workflowId)
  assert.equal((await statusOf(live.workflowId)).updatedAt, cancelledAt)
  await standIn.answer(live.workflowId, cleanup) // the held step returns and frees its lane

  await standIn.policy({ convert: 'auto' })
  const finished = convertSubmission(ingestChild())
  await handoff.submit(finished)
  assert.equal((await settled(finished.workflowId)).state, 'SUCCESS')
  const before = await statusOf(finished.workflowId)
  await delay(20)
  await handoff.cancel(finished.workflowId)
  const after = await statusOf(finished.workflowId)
  assert.equal(after.status, 'SUCCESS')
  assert.equal(after.updatedAt, before.updatedAt)
})

test('a cancelled child\'s lane stays occupied until its step returns', async () => {
  await standIn.policy({ convert: 'hold' })
  const first = convertSubmission(ingestChild())
  const second = convertSubmission(ingestChild())
  assert.equal(first.queueName, KEI_QUEUE.convertSmall)
  await handoff.submit(first)
  await heldFor(first.workflowId)
  await handoff.cancel(first.workflowId)
  assert.equal((await statusOf(first.workflowId)).status, 'CANCELLED')
  await handoff.submit(second)
  // kei-convert-small has one slot per worker, counted from the steps still running, not from PENDING rows.
  for (let read = 0; read < 8; read += 1) {
    await delay(150)
    assert.equal((await statusOf(second.workflowId)).status, 'ENQUEUED', `read ${read}`)
  }
  await standIn.answer(first.workflowId, { convert: 'auto' })
  await heldFor(second.workflowId)
  assert.equal((await statusOf(second.workflowId)).status, 'PENDING')
  assert.equal((await statusOf(first.workflowId)).status, 'CANCELLED')
  await standIn.answer(second.workflowId, cleanup)
  const outcome = settleKei(await settled(second.workflowId), keiConvertOkSchema)
  assert.deepEqual(outcome, { ok: false, ...cleanup.failure })
})

test('submitting before kei has migrated its schema fails with a kei-not-ready error', async () => {
  const unmigrated = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl, systemDatabaseSchemaName: unmigratedSchema, applicationName: KEI_APPLICATION,
  })
  try {
    const error = await createKeiHandoff(unmigrated).submit(convertSubmission(ingestChild())).then(
      () => assert.fail('The submission reached a schema kei never migrated.'),
      (reason: unknown) => reason,
    )
    assert.equal(keiNotReady(error), true, String(error))
  } finally {
    await unmigrated.destroy()
  }
})

test('a convert fixture request converts on the lane named in its fixture and returns its run ID', async () => {
  await standIn.policy({ convert: 'auto' })
  const { enqueue, request } = contract('convert.input')
  const submission = convertSubmission(ingestChild())
  await handoff.submit(submission)
  const outcome = settleKei(await settled(submission.workflowId), keiConvertOkSchema)
  assert.ok(outcome.ok, JSON.stringify(outcome))
  assert.equal((await statusOf(submission.workflowId)).queueName, enqueue.queue_name)
  const manifest = JSON.parse(readFileSync(new URL('result.json', KEI_EXP), 'utf8'))
  const pages = readdirSync(new URL('pages/', KEI_EXP)).length
  assert.deepEqual(outcome.value, {
    ok: true, run_id: outcome.value.run_id, generation: manifest.generation, page_count: pages,
    source_sha256: request.source_sha256, page_source: request.page_source,
  })
  const result = await fetch(`${standIn.url}/api/runs/${outcome.value.run_id}/result`)
  assert.equal(result.status, 200)
  assert.deepEqual(await result.json(), { ...manifest, recipe: { ...manifest.recipe, source_sha256: request.source_sha256 } })
  const page = await fetch(`${standIn.url}/api/runs/${outcome.value.run_id}/pages/1`)
  assert.equal(page.status, 200)
  assert.deepEqual(await page.json(), JSON.parse(readFileSync(new URL('pages/1.json', KEI_EXP), 'utf8')))
})

test('a failure policy answers kei\'s typed failure, and kei\'s read routes list models and refuse what is absent or malformed', async () => {
  const failure = { code: 'source_unreadable', reason: 'the PDF could not be opened', retryable: false } as const
  await standIn.policy({ convert: { failure } })
  const submission = convertSubmission(ingestChild())
  await handoff.submit(submission)
  assert.deepEqual(settleKei(await settled(submission.workflowId), keiConvertOkSchema), { ok: false, ...failure })
  await standIn.policy({ convert: 'auto' })

  const models = await fetch(`${standIn.url}/api/models`)
  assert.equal(models.status, 200)
  assert.deepEqual(await models.json(), []) // kei answers a list of its transcription models
  const extraction = await (await fetch(`${standIn.url}/api/extraction-models`)).json()
  assert.deepEqual(extraction.defaults, { fields: 'instruct', reasoning: 'instruct' })
  const ingestion = await (await fetch(`${standIn.url}/api/ingestion-models`)).json()
  assert.deepEqual(ingestion.defaults, { ocr: 'surya', layout: 'layout_heron_101' })
  for (const path of [
    '/api/runs/run-absent/result', '/api/runs/.hidden/result', '/api/runs/run-absent/pages/1',
    '/api/runs/run-absent/pages/0', '/api/runs', '/api/unknown',
  ])
    assert.equal((await fetch(`${standIn.url}${path}`)).status, 404, path)
  assert.equal((await fetch(`${standIn.url}/control/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workflowId: 'kei-convert:none', ...cleanup }),
  })).status, 404)
})

test('a deleteRuns request reaches the stand-in on kei-gc, is recorded, and deletes only settled history', async () => {
  await standIn.policy({ convert: 'auto' })
  const converted = convertSubmission(ingestChild())
  await handoff.submit(converted)
  const conversion = settleKei(await settled(converted.workflowId), keiConvertOkSchema)
  assert.ok(conversion.ok, JSON.stringify(conversion))
  await standIn.policy({ convert: 'hold' })
  const live = convertSubmission(ingestChild())
  await handoff.submit(live)
  await heldFor(live.workflowId)

  const request = { conversions: [converted.workflowId, live.workflowId], history: [] }
  const before = Date.now()
  await handoff.requestDeleteRuns('kei-gc:t1', request)
  await handoff.requestDeleteRuns('kei-gc:t1', request) // one cleanup per ID: the second enqueue is a no-op
  const outcome = settleKei(await settled('kei-gc:t1'), keiDeleteRunsOkSchema)
  assert.deepEqual(outcome, {
    ok: true,
    value: {
      ok: true, deleted_runs: [conversion.value.run_id], kept_runs: [],
      deleted_history: [converted.workflowId], kept_history: [live.workflowId],
    },
  })
  assert.equal((await statusOf('kei-gc:t1')).queueName, KEI_QUEUE.gc)
  const recorded = await standIn.deleteRunsRequests()
  assert.deepEqual(recorded.map(({ workflowId, request: body }) => ({ workflowId, request: body })),
    [{ workflowId: 'kei-gc:t1', request }])
  assert.ok(recorded[0]!.receivedAtMs >= before, 'recorded when kei received it')
  assert.deepEqual(await client.listWorkflows({ workflowIDs: [converted.workflowId] }), [])
  assert.equal((await statusOf(live.workflowId)).status, 'PENDING') // a live workflow's history stays
  assert.equal((await fetch(`${standIn.url}/api/runs/${conversion.value.run_id}/result`)).status, 404)
  await standIn.answer(live.workflowId, cleanup)
  assert.equal((await settled(live.workflowId)).state, 'SUCCESS')
})
