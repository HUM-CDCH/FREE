import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import * as handoff from './kei-handoff.js'

const FIXTURES = new URL('../../../prototypes/parsing_service/tests/fixtures/contracts/', import.meta.url)
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'))

type Client = Parameters<typeof handoff.createKeiHandoff>[0]
type Row = { status: string; output?: unknown; deadlineEpochMS?: number; updatedAt?: number }

/** A kei client double: listWorkflows answers the scripted rows in turn (the last one repeats; none = missing). */
function fakeClient(rows: Row[] = []) {
  const calls = { list: 0, cancelled: [] as string[], enqueued: [] as Array<{ options: unknown; args: unknown[] }> }
  const client = {
    async enqueuePortable(options: unknown, args: unknown[]) {
      calls.enqueued.push({ options, args })
      return {}
    },
    async listWorkflows() {
      const row = rows[Math.min(calls.list, rows.length - 1)]
      calls.list += 1
      return row ? [{ workflowID: 'kei-convert:x', ...row }] : []
    },
    async cancelWorkflow(workflowId: string) {
      calls.cancelled.push(workflowId)
    },
  }
  return { client: client as unknown as Client, calls }
}

test('every contract fixture parses with Studio\'s schema and round-trips', () => {
  const convertRequest = fixture('convert.input').request
  assert.deepEqual(handoff.keiConvertInputSchema.parse(convertRequest), convertRequest)
  const extractRequest = fixture('extract.input').request
  assert.deepEqual(handoff.keiExtractInputSchema.parse(extractRequest), extractRequest)
  assert.deepEqual(handoff.keiConvertOkSchema.parse(fixture('convert.output.ok')), fixture('convert.output.ok'))
  assert.deepEqual(handoff.keiExtractOkSchema.parse(fixture('extract.output.ok')), fixture('extract.output.ok'))
  assert.deepEqual(handoff.keiFailureSchema.parse(fixture('convert.output.failed')), fixture('convert.output.failed'))
  assert.deepEqual(handoff.keiFailureSchema.parse(fixture('extract.output.failed')), fixture('extract.output.failed'))
})

test('ConvertOk has at least one page and a named generation, as kei\'s contract bounds them', () => {
  const ok = fixture('convert.output.ok')
  assert.equal(handoff.keiConvertOkSchema.safeParse({ ...ok, page_count: 0 }).success, false)
  assert.equal(handoff.keiConvertOkSchema.safeParse({ ...ok, generation: '' }).success, false)
  assert.equal(handoff.keiConvertOkSchema.safeParse({ ...ok, extra: true }).success, false)
})

test('Studio\'s lanes, priorities, prefixes and small-document threshold are the fixture\'s', () => {
  const queues = fixture('queues')
  assert.equal(queues.small_document_pages, handoff.SMALL_DOCUMENT_PAGES)
  assert.equal(handoff.SMALL_DOCUMENT_PAGES, 30)
  assert.deepEqual(queues.priorities, handoff.KEI_PRIORITY)
  assert.equal(queues.application_name, handoff.KEI_APPLICATION)
  assert.deepEqual(Object.keys(queues.queues).sort(), Object.values(handoff.KEI_QUEUE).sort())
  assert.equal(queues.workflow_id_prefixes.convert, handoff.keiConvertWorkflowId(''))
  assert.equal(queues.workflow_id_prefixes.extract, handoff.keiExtractWorkflowId(''))
  const convert = fixture('convert.input')
  assert.equal(convert.enqueue.priority, handoff.CONVERSION_PRIORITY)
  assert.equal(
    convert.enqueue.workflow_id,
    handoff.keiConvertWorkflowId('ingest:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'),
  )
  assert.equal(convert.enqueue.application_name, handoff.KEI_APPLICATION)
  const extract = fixture('extract.input')
  assert.equal(extract.enqueue.workflow_id, handoff.keiExtractWorkflowId('33333333-3333-4333-8333-333333333333'))
  assert.equal(extract.enqueue.queue_name, handoff.KEI_QUEUE.extract)
})

test('the conversion budget is deadlines.json\'s formula at every listed page count', () => {
  const cases: Array<[number, number]> = fixture('deadlines').convert.cases
  assert.ok(cases.length > 0)
  for (const [pages, ms] of cases) assert.equal(handoff.conversionTimeoutMs(pages), ms, `${pages} pages`)
  assert.equal(handoff.conversionTimeoutMs(null), handoff.conversionTimeoutMs(2000))
  assert.equal(fixture('convert.input').enqueue.workflow_timeout_ms, handoff.conversionTimeoutMs(3))
})

test('Article and Catalog have three-hour extraction deadlines', () => {
  const deadlines = fixture('deadlines')
  assert.deepEqual(handoff.EXTRACTION_TIMEOUT_MS, {
    ARTICLE: deadlines.extract.article, CATALOG: deadlines.extract.catalog,
  })
  assert.equal(fixture('extract.input').enqueue.workflow_timeout_ms, handoff.EXTRACTION_TIMEOUT_MS.CATALOG)
})

test('30 pages convert on kei-convert-small, 31 and an uncounted PDF on kei-convert-large', () => {
  assert.equal(handoff.conversionLane(1), 'kei-convert-small')
  assert.equal(handoff.conversionLane(30), 'kei-convert-small')
  assert.equal(handoff.conversionLane(31), 'kei-convert-large')
  assert.equal(handoff.conversionLane(null), 'kei-convert-large')
  assert.equal(fixture('convert.input').enqueue.queue_name, handoff.conversionLane(fixture('convert.output.ok').page_count))
})

test('run and extraction IDs must fully match one path component', () => {
  for (const id of ['run-0123456789abcdef01234567', '33333333-3333-4333-8333-333333333333', 'x-1'])
    assert.equal(handoff.KEI_RUN_ID.test(id), true, id)
  for (const id of ['../x', 'a/b', '.hidden', 'x\n', '', 'x y'])
    assert.equal(handoff.KEI_RUN_ID.test(id), false, JSON.stringify(id))
  const ok = fixture('convert.output.ok')
  assert.equal(handoff.keiConvertOkSchema.safeParse({ ...ok, run_id: 'run/../x' }).success, false)
  const extracted = fixture('extract.output.ok')
  assert.equal(handoff.keiExtractOkSchema.safeParse({ ...extracted, extraction_id: 'x\n' }).success, false)
})

test('a finished kei workflow settles by its output; cancelled, errored, exhausted, missing and malformed ones settle as typed failures', () => {
  const ok = fixture('convert.output.ok')
  assert.deepEqual(handoff.settleKei({ state: 'SUCCESS', output: ok }, handoff.keiConvertOkSchema), { ok: true, value: ok })
  const failed = handoff.settleKei({ state: 'SUCCESS', output: fixture('convert.output.failed') }, handoff.keiConvertOkSchema)
  assert.deepEqual(failed, {
    ok: false, code: 'source_mismatch', reason: fixture('convert.output.failed').reason, retryable: false,
  })
  const extractFailed = handoff.settleKei({ state: 'SUCCESS', output: fixture('extract.output.failed') }, handoff.keiExtractOkSchema)
  assert.equal(extractFailed.ok, false)
  assert.equal(!extractFailed.ok && extractFailed.code, 'stale_generation')

  const code = (poll: Parameters<typeof handoff.settleKei>[0]) => {
    const outcome = handoff.settleKei(poll, handoff.keiConvertOkSchema)
    assert.equal(outcome.ok, false)
    return outcome.ok ? null : { code: outcome.code, retryable: outcome.retryable }
  }
  assert.deepEqual(code({ state: 'CANCELLED', deadlinePassed: true }), { code: 'deadline_exceeded', retryable: false })
  assert.deepEqual(code({ state: 'CANCELLED', deadlinePassed: false }), { code: 'cancelled', retryable: false })
  assert.deepEqual(code({ state: 'ERROR', deadlinePassed: false }), { code: 'stopped', retryable: false })
  assert.deepEqual(code({ state: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', deadlinePassed: false }), { code: 'stopped', retryable: true })
  assert.deepEqual(code({ state: 'missing' }), { code: 'stopped', retryable: false })
  assert.deepEqual(code({ state: 'SUCCESS', output: { ok: true } }), { code: 'invalid_output', retryable: false })
  assert.deepEqual(code({ state: 'SUCCESS', output: { ...ok, run_id: 'run/../x' } }), { code: 'invalid_output', retryable: false })
})

test('kei-not-ready errors are a missing table or schema, a starting or restarting server, and a refused, reset or terminated connection, anywhere in the cause chain', () => {
  assert.equal(handoff.keiNotReady({ code: '42P01' }), true)
  assert.equal(handoff.keiNotReady({ code: '3F000' }), true)
  assert.equal(handoff.keiNotReady({ code: '57P03' }), true)
  // A query in flight while PostgreSQL restarts: admin_shutdown, or pg's code-less "Connection terminated" errors.
  assert.equal(handoff.keiNotReady({ code: '57P01' }), true)
  assert.equal(handoff.keiNotReady(new Error('Connection terminated unexpectedly')), true)
  assert.equal(handoff.keiNotReady(new Error('Connection terminated')), true)
  assert.equal(handoff.keiNotReady(new Error('x', { cause: new Error('Connection terminated unexpectedly') })), true)
  assert.equal(handoff.keiNotReady(new Error('Connection terminatedly')), false)
  assert.equal(handoff.keiNotReady({ message: 'Connection terminated' }), false)
  assert.equal(handoff.keiNotReady(Object.assign(new Error('Connection terminated'), { code: '23505' })), false)
  assert.equal(handoff.keiNotReady(Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } })), true)
  assert.equal(handoff.keiNotReady(new Error('x', { cause: new Error('y', { cause: { code: 'ECONNRESET' } }) })), true)
  assert.equal(handoff.keiNotReady({ code: '23505' }), false)
  assert.equal(handoff.keiNotReady(new Error('x')), false)
  assert.equal(handoff.keiNotReady(undefined), false)
  const cycle: { code: string; cause?: unknown } = { code: '23505' }
  cycle.cause = cycle
  assert.equal(handoff.keiNotReady(cycle), false)
  assert.equal(handoff.SUBMIT_TO_KEI_RETRY.shouldRetry, handoff.keiNotReady)
  assert.deepEqual(
    { ...handoff.SUBMIT_TO_KEI_RETRY, shouldRetry: undefined },
    { retriesAllowed: true, intervalSeconds: 5, backoffRate: 1, maxAttempts: 120, shouldRetry: undefined },
  )
})

test('a poll reads the child until it is terminal or its window ends, and a cancel touches only a live child', async () => {
  const output = fixture('convert.output.ok')
  const finishing = fakeClient([{ status: 'PENDING' }, { status: 'PENDING' }, { status: 'SUCCESS', output }])
  assert.deepEqual(
    await handoff.createKeiHandoff(finishing.client, { pollIntervalMs: 1 }).poll('kei-convert:x'),
    { state: 'SUCCESS', output },
  )
  assert.equal(finishing.calls.list, 3)

  const working = fakeClient([{ status: 'PENDING' }])
  assert.deepEqual(
    await handoff.createKeiHandoff(working.client, { pollWindowMs: 0, pollIntervalMs: 1 }).poll('kei-convert:x'),
    { state: 'live' },
  )
  assert.equal(working.calls.list, 1)

  const clock = { now: 0 }
  const waiting = fakeClient([{ status: 'ENQUEUED' }])
  const windowed = handoff.createKeiHandoff(waiting.client, { pollWindowMs: 50, pollIntervalMs: 1, now: () => (clock.now += 10) })
  assert.deepEqual(await windowed.poll('kei-convert:x'), { state: 'live' })
  assert.ok(waiting.calls.list > 1 && waiting.calls.list < 10, `${waiting.calls.list} reads`)

  assert.deepEqual(await handoff.createKeiHandoff(fakeClient().client).poll('kei-convert:x'), { state: 'missing' })
  const deadline = fakeClient([{ status: 'CANCELLED', deadlineEpochMS: 1_000, updatedAt: 1_000 }])
  assert.deepEqual(await handoff.createKeiHandoff(deadline.client).poll('kei-convert:x'), { state: 'CANCELLED', deadlinePassed: true })
  const early = fakeClient([{ status: 'CANCELLED', deadlineEpochMS: 1_000, updatedAt: 999 }])
  assert.deepEqual(await handoff.createKeiHandoff(early.client).poll('kei-convert:x'), { state: 'CANCELLED', deadlinePassed: false })
  const neverDequeued = fakeClient([{ status: 'CANCELLED', updatedAt: 5_000 }])
  assert.deepEqual(
    await handoff.createKeiHandoff(neverDequeued.client).poll('kei-convert:x'),
    { state: 'CANCELLED', deadlinePassed: false },
  )
  const exhausted = fakeClient([{ status: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED' }])
  assert.deepEqual(
    await handoff.createKeiHandoff(exhausted.client).poll('kei-convert:x'),
    { state: 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', deadlinePassed: false },
  )

  const aborted = fakeClient([{ status: 'PENDING' }])
  await assert.rejects(
    handoff.createKeiHandoff(aborted.client).poll('kei-convert:x', AbortSignal.abort()),
    { name: 'AbortError' },
  )
  assert.equal(aborted.calls.list, 0)
  const stopping = new AbortController()
  const stopped = handoff.createKeiHandoff(fakeClient([{ status: 'PENDING' }]).client, { pollIntervalMs: 60_000 })
    .poll('kei-convert:x', stopping.signal)
  setTimeout(() => stopping.abort(), 10)
  await assert.rejects(stopped, { name: 'AbortError' })

  for (const status of ['SUCCESS', 'ERROR', 'CANCELLED']) {
    const finished = fakeClient([{ status }])
    await handoff.createKeiHandoff(finished.client).cancel('kei-convert:x')
    assert.deepEqual(finished.calls.cancelled, [], status)
  }
  const missing = fakeClient()
  await handoff.createKeiHandoff(missing.client).cancel('kei-convert:x')
  assert.deepEqual(missing.calls.cancelled, [])
  const enqueued = fakeClient([{ status: 'ENQUEUED' }])
  await handoff.createKeiHandoff(enqueued.client).cancel('kei-convert:x')
  assert.deepEqual(enqueued.calls.cancelled, ['kei-convert:x'])
})

test('submit enqueues the child portably by name, as kei\'s application, with its lane, priority, deadline, owner and the parent\'s attributes', async () => {
  const { client, calls } = fakeClient()
  const request = fixture('extract.input').request
  const attributes = { projectContextId: 'p' }
  await handoff.createKeiHandoff(client).submit({
    workflow: 'extract',
    workflowId: 'kei-extract:x',
    queueName: handoff.KEI_QUEUE.extract,
    priority: handoff.KEI_PRIORITY.batch,
    timeoutMs: handoff.EXTRACTION_TIMEOUT_MS.CATALOG,
    request,
    authenticatedUser: 'owner',
    attributes,
  })
  assert.deepEqual(calls.enqueued, [{
    options: {
      workflowName: 'extract', queueName: 'kei-extract', workflowID: 'kei-extract:x', priority: 10,
      workflowTimeoutMS: 10_800_000, applicationName: 'kei', authenticatedUser: 'owner',
      attributes: { projectContextId: 'p' },
    },
    args: [request],
  }])
  // A copy: the parent's attributes object never becomes DBOS's.
  assert.notEqual(calls.enqueued[0]?.options.attributes, attributes)
})
