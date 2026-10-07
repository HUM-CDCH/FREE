import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { propagation } from '@opentelemetry/api'
import * as handoff from './kei-handoff.js'

const FIXTURES = new URL('../../../apps/parsing_service/tests/fixtures/contracts/', import.meta.url)
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
  assert.deepEqual(handoff.keiConvertOkSchema.parse(fixture('convert.output.ok')), fixture('convert.output.ok'))
  assert.deepEqual(handoff.keiFailureSchema.parse(fixture('convert.output.failed')), fixture('convert.output.failed'))
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
  // Durable Extraction attempts (`kei-durable:`) run on kei-extract; Studio submits no other kei extraction workflow.
  assert.deepEqual(Object.keys(queues.workflow_id_prefixes).sort(), ['convert', 'deleteRuns'])
  assert.equal(queues.workflow_id_prefixes.deleteRuns, handoff.GC_PREFIX)
  const convert = fixture('convert.input')
  assert.equal(convert.enqueue.priority, handoff.CONVERSION_PRIORITY)
  assert.equal(
    convert.enqueue.workflow_id,
    handoff.keiConvertWorkflowId('ingest:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'),
  )
  assert.equal(convert.enqueue.application_name, handoff.KEI_APPLICATION)
})

test('the conversion budget is deadlines.json\'s formula at every listed page count', () => {
  const cases: Array<[number, number]> = fixture('deadlines').convert.cases
  assert.ok(cases.length > 0)
  for (const [pages, ms] of cases) assert.equal(handoff.conversionTimeoutMs(pages), ms, `${pages} pages`)
  assert.equal(handoff.conversionTimeoutMs(null), handoff.conversionTimeoutMs(2000))
  assert.equal(fixture('convert.input').enqueue.workflow_timeout_ms, handoff.conversionTimeoutMs(3))
})

test('30 pages convert on kei-convert-small, 31 and an uncounted PDF on kei-convert-large', () => {
  assert.equal(handoff.conversionLane(1), 'kei-convert-small')
  assert.equal(handoff.conversionLane(30), 'kei-convert-small')
  assert.equal(handoff.conversionLane(31), 'kei-convert-large')
  assert.equal(handoff.conversionLane(null), 'kei-convert-large')
  assert.equal(fixture('convert.input').enqueue.queue_name, handoff.conversionLane(fixture('convert.output.ok').page_count))
})

test('run IDs must fully match one path component', () => {
  for (const id of ['run-0123456789abcdef01234567', '33333333-3333-4333-8333-333333333333', 'x-1'])
    assert.equal(handoff.KEI_RUN_ID.test(id), true, id)
  for (const id of ['../x', 'a/b', '.hidden', 'x\n', '', 'x y'])
    assert.equal(handoff.KEI_RUN_ID.test(id), false, JSON.stringify(id))
  const ok = fixture('convert.output.ok')
  assert.equal(handoff.keiConvertOkSchema.safeParse({ ...ok, run_id: 'run/../x' }).success, false)
})

test('a finished kei workflow settles by its output; cancelled, errored, exhausted, missing and malformed ones settle as typed failures', () => {
  const ok = fixture('convert.output.ok')
  assert.deepEqual(handoff.settleKei({ state: 'SUCCESS', output: ok }, handoff.keiConvertOkSchema), { ok: true, value: ok })
  const failed = handoff.settleKei({ state: 'SUCCESS', output: fixture('convert.output.failed') }, handoff.keiConvertOkSchema)
  assert.deepEqual(failed, {
    ok: false, code: 'source_mismatch', reason: fixture('convert.output.failed').reason, retryable: false,
  })

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
  const request = fixture('convert.input').request
  const attributes = { projectContextId: 'p' }
  await handoff.createKeiHandoff(client).submit({
    workflow: 'convert',
    workflowId: 'kei-convert:x',
    queueName: handoff.KEI_QUEUE.convertLarge,
    priority: handoff.CONVERSION_PRIORITY,
    timeoutMs: handoff.conversionTimeoutMs(40),
    request,
    authenticatedUser: 'owner',
    attributes,
  })
  assert.deepEqual(calls.enqueued, [{
    options: {
      workflowName: 'convert', queueName: 'kei-convert-large', workflowID: 'kei-convert:x', priority: 1,
      workflowTimeoutMS: 816_000, applicationName: 'kei', authenticatedUser: 'owner',
      attributes: { projectContextId: 'p' },
    },
    args: [request],
  }])
  // A copy: the parent's attributes object never becomes DBOS's.
  assert.notEqual(calls.enqueued[0]?.options.attributes, attributes)
})

test('submit hands a traced step\'s trace context to kei, whose DBOS parents the child\'s spans to it', async (t) => {
  const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01'
  propagation.setGlobalPropagator({
    inject: (_context, carrier, setter) => setter.set(carrier, 'traceparent', traceparent),
    extract: (context) => context,
    fields: () => ['traceparent'],
  })
  t.after(() => propagation.disable())
  const { client, calls } = fakeClient()
  await handoff.createKeiHandoff(client).submit({
    workflow: 'convert', workflowId: 'kei-convert:x', queueName: handoff.KEI_QUEUE.convertSmall, priority: 1,
    timeoutMs: 1, request: fixture('convert.input').request, authenticatedUser: 'owner', attributes: { projectContextId: 'p' },
  })
  assert.deepEqual((calls.enqueued[0]?.options as { attributes: unknown }).attributes,
    { projectContextId: 'p', 'dbos.otelContext': { traceparent } })
})

test('the deleteRuns fixture parses with Studio\'s schema and round-trips', () => {
  const request = fixture('deleteRuns.input').request
  assert.deepEqual(handoff.keiDeleteRunsInputSchema.parse(request), request)
  assert.deepEqual(handoff.keiDeleteRunsOkSchema.parse(fixture('deleteRuns.output')), fixture('deleteRuns.output'))
  const enqueue = fixture('deleteRuns.input').enqueue
  assert.equal(enqueue.workflow_name, handoff.DELETE_RUNS)
  assert.equal(enqueue.queue_name, handoff.KEI_QUEUE.gc)
  assert.equal(fixture('queues').workflow_id_prefixes.deleteRuns, handoff.GC_PREFIX)
})

test('a history entry that names a conversion is refused, and so is a conversion without its prefix', () => {
  assert.equal(handoff.keiDeleteRunsInputSchema.safeParse({ conversions: [], history: ['kei-convert:x'] }).success, false)
  assert.equal(handoff.keiDeleteRunsInputSchema.safeParse({ conversions: ['x'], history: [] }).success, false)
  assert.equal(handoff.keiDeleteRunsInputSchema.safeParse({ conversions: ['kei-convert:'], history: [] }).success, false)
  assert.equal(handoff.keiDeleteRunsInputSchema.safeParse({ runs: [], conversions: [], history: [] }).success, false)
  const ok = fixture('deleteRuns.output')
  assert.equal(handoff.keiDeleteRunsOkSchema.safeParse({ ...ok, extra: true }).success, false)
})

test('requestDeleteRuns enqueues deleteRuns portably on kei-gc as kei under the given ID', async () => {
  const { client, calls } = fakeClient()
  const { enqueue, request } = fixture('deleteRuns.input')
  await handoff.createKeiHandoff(client).requestDeleteRuns(enqueue.workflow_id, request)
  assert.deepEqual(calls.enqueued, [{
    options: {
      workflowName: enqueue.workflow_name, queueName: enqueue.queue_name, workflowID: enqueue.workflow_id,
      applicationName: enqueue.application_name,
    },
    args: [request],
  }])
  assert.deepEqual(calls.enqueued[0]?.options, {
    workflowName: 'deleteRuns', queueName: 'kei-gc', workflowID: 'kei-gc:2026-09-26T12:00:00.000Z', applicationName: 'kei',
  })
  // A request outside the contract never reaches kei.
  await assert.rejects(
    handoff.createKeiHandoff(client).requestDeleteRuns('kei-gc:x', { conversions: [], history: ['kei-convert:x'] }),
  )
  assert.equal(calls.enqueued.length, 1)
})

test('keiRunOf reads kei-exp:<run>:<generation> and nothing else', () => {
  assert.deepEqual(handoff.keiRunOf('kei-exp:run-1:g1'), { runId: 'run-1', generation: 'g1' })
  assert.deepEqual(handoff.keiRunOf('kei-exp:a.b_c-d:20260926'), { runId: 'a.b_c-d', generation: '20260926' })
  for (const id of ['kei-exp:run/x:g', 'kei-exp:run:', 'other:run:g', 'kei-exp::g', 'kei-exp:.run:g', 'kei-exp:run:g\n', 'kei-exp:run:g h', 'kei-exp:run'])
    assert.equal(handoff.keiRunOf(id), null, JSON.stringify(id))
})

test('keiGcWorkflowId names the schedule\'s instant', () => {
  assert.equal(handoff.keiGcWorkflowId(new Date('2026-09-26T12:00:00Z')), 'kei-gc:2026-09-26T12:00:00.000Z')
  assert.equal(handoff.keiGcWorkflowId(new Date('2026-09-26T12:00:00Z')), fixture('deleteRuns.input').enqueue.workflow_id)
})
