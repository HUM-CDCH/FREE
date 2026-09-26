import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  executionOf,
  INTERRUPTED_FAILURE,
  LIVE_WORKFLOW_STATUSES,
  workflowStatusesOf,
} from './execution-status.js'

test('maps ENQUEUED and DELAYED to QUEUED, PENDING to RUNNING, SUCCESS to a re-read, and every other status or a missing workflow to interrupted', () => {
  const cases: [string | undefined, string][] = [
    ['ENQUEUED', 'QUEUED'],
    ['DELAYED', 'QUEUED'],
    ['PENDING', 'RUNNING'],
    ['SUCCESS', 'REREAD'],
    ['ERROR', 'INTERRUPTED'],
    ['CANCELLED', 'INTERRUPTED'],
    ['MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'INTERRUPTED'],
    [undefined, 'INTERRUPTED'],
    ['RETRIED', 'INTERRUPTED'],
  ]
  for (const [status, expected] of cases) assert.equal(executionOf(status), expected, `status ${status}`)
})

test('work is active exactly while its workflow is live: ENQUEUED, DELAYED or PENDING', () => {
  assert.deepEqual([...LIVE_WORKFLOW_STATUSES].sort(), ['DELAYED', 'ENQUEUED', 'PENDING'])
  for (const status of [...LIVE_WORKFLOW_STATUSES, 'SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED', 'RETRIED', undefined]) {
    const active = executionOf(status) === 'QUEUED' || executionOf(status) === 'RUNNING'
    assert.equal(active, status !== undefined && LIVE_WORKFLOW_STATUSES.has(status), `status ${status}`)
  }
})

test('reads every status with one listWorkflows call per 500 IDs and never asks for inputs or outputs', async () => {
  const calls: { workflowIDs: string[]; loadInput: false; loadOutput: false }[] = []
  const statuses = workflowStatusesOf(async (input) => {
    calls.push(input)
    // DBOS omits a workflow it no longer holds.
    return input.workflowIDs.filter((id) => id !== 'extract:gone').map((workflowID) => ({ workflowID, status: `S-${workflowID}` }))
  })

  const few = await statuses(['extract:a', 'extract:gone', 'extract:b'])
  assert.deepEqual(calls, [{ workflowIDs: ['extract:a', 'extract:gone', 'extract:b'], loadInput: false, loadOutput: false }])
  assert.deepEqual([...few], [['extract:a', 'S-extract:a'], ['extract:b', 'S-extract:b']])
  assert.equal(few.get('extract:gone'), undefined)

  calls.length = 0
  const ids = Array.from({ length: 1_001 }, (_, index) => `extract:${index}`)
  const many = await statuses(ids)
  assert.deepEqual(
    calls.map((call) => [call.workflowIDs.length, call.workflowIDs[0], call.loadInput, call.loadOutput]),
    [
      [500, 'extract:0', false, false],
      [500, 'extract:500', false, false],
      [1, 'extract:1000', false, false],
    ],
  )
  assert.deepEqual(calls.flatMap((call) => call.workflowIDs), ids)
  assert.equal(many.size, 1_001)
  assert.equal(many.get('extract:1000'), 'S-extract:1000')

  calls.length = 0
  assert.equal((await statuses([])).size, 0)
  assert.deepEqual(calls, [])
})

test('a DBOS or store outage rejects instead of reading as a missing workflow', async () => {
  const outage = new Error('connection refused')
  const statuses = workflowStatusesOf(async () => {
    throw outage
  })
  await assert.rejects(statuses(['extract:a']), (error) => error === outage)
})

test('the interrupted failure names no workflow and tells the researcher to start again', () => {
  assert.equal(INTERRUPTED_FAILURE.code, 'interrupted')
  assert.doesNotMatch(INTERRUPTED_FAILURE.message, /extract:|suggest:|ingest:|reprocess:|kei-/)
  assert.match(INTERRUPTED_FAILURE.message, /Start it again\.$/)
  assert.ok(Object.isFrozen(INTERRUPTED_FAILURE))
})
