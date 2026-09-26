import { Error as DBOSErrors } from '@dbos-inc/dbos-sdk'
import { APICallError } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { INTERRUPTED_FAILURE } from 'db'
import { holdsKey, plantedKey } from '../test/support/plantedKey.js'
import { ApiError, asModelOperationError } from './_http.js'
import { ModelKeyRequiredError } from './_model_keys.js'
import {
  awaitOperation,
  operationFailureOf,
  startOrJoinOperation,
  type ModelOperationClient,
  type OperationStart,
} from './_model_operation.js'

const OWNER = '51000000-0000-4000-8009-00000000000a'
const OPERATION = '51000000-0000-4000-8009-0000000000f1'
const input = { operationId: OPERATION, owner: OWNER, instruction: 'Catalog entries', temperature: null }
const start: OperationStart<typeof input> = {
  workflowName: 'suggestSchema',
  workflowID: `suggestion:${OPERATION}`,
  owner: OWNER,
  attributes: { projectContextId: 'p', extractionSchemaId: null },
  input,
}

type Recorded = { workflowName: string; input?: unknown[]; status?: string; output?: unknown }

function fakeClient(recorded: Recorded | undefined | (() => Promise<Recorded | undefined>) = undefined) {
  const client = {
    enqueue: vi.fn(async () => ({}) as never),
    getWorkflow: vi.fn(async () => (typeof recorded === 'function' ? recorded() : recorded) as never),
    listWorkflows: vi.fn(async () => [] as never[]),
    cancelWorkflow: vi.fn(async () => {}),
    deleteWorkflows: vi.fn(async () => {}),
  }
  return client as unknown as ModelOperationClient & typeof client
}

describe('startOrJoinOperation', () => {
  it('a new operation is enqueued by name on the studio queue with its owner and attributes', async () => {
    const client = fakeClient({ workflowName: 'suggestSchema', input: [input] })

    await startOrJoinOperation(client, start)

    expect(client.enqueue).toHaveBeenCalledExactlyOnceWith({
      queueName: 'studio',
      workflowName: 'suggestSchema',
      workflowID: `suggestion:${OPERATION}`,
      authenticatedUser: OWNER,
      attributes: { projectContextId: 'p', extractionSchemaId: null },
    }, input)
  })

  it('a reused operation ID with the same input joins it; any other input or workflow name is 409 operation_conflict', async () => {
    await expect(startOrJoinOperation(fakeClient({ workflowName: 'suggestSchema', input: [{ ...input }] }), start)).resolves.toBeUndefined()
    await expect(startOrJoinOperation(fakeClient({ workflowName: 'suggestSchema', input: [{ ...input, instruction: 'other' }] }), start))
      .rejects.toMatchObject({ status: 409, code: 'operation_conflict' })
    await expect(startOrJoinOperation(fakeClient({ workflowName: 'proposeSchemaEdit', input: [input] }), start))
      .rejects.toMatchObject({ status: 409, code: 'operation_conflict' })
    await expect(startOrJoinOperation(fakeClient(undefined), start)).rejects.toMatchObject({ status: 409, code: 'operation_conflict' })
  })

  it('an ID DBOS already holds for another workflow is 409 operation_conflict, not an outage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const client = fakeClient({ workflowName: 'proposeSchemaEdit', input: [input] })
    client.enqueue.mockRejectedValueOnce(new DBOSErrors.DBOSConflictingWorkflowError(start.workflowID, 'Workflow already exists with a different name'))
    await expect(startOrJoinOperation(client, start)).rejects.toMatchObject({ status: 409, code: 'operation_conflict' })
    expect(client.getWorkflow).not.toHaveBeenCalled()
  })

  it('a DBOS outage while starting or reading is 503 persistence_unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const starting = fakeClient({ workflowName: 'suggestSchema', input: [input] })
    starting.enqueue.mockRejectedValueOnce(new Error('connection refused'))
    await expect(startOrJoinOperation(starting, start)).rejects.toMatchObject({ status: 503, code: 'persistence_unavailable' })
    const reading = fakeClient(async () => { throw new Error('connection refused') })
    await expect(startOrJoinOperation(reading, start)).rejects.toMatchObject({ status: 503, code: 'persistence_unavailable' })
  })
})

describe('awaitOperation', () => {
  const finished = (status: string, output?: unknown) => {
    const client = fakeClient()
    client.listWorkflows.mockResolvedValue([{ workflowID: start.workflowID, status, output }] as never)
    return client
  }

  it("returns a finished workflow's typed output; a cancel is 409 operation_cancelled, an error or a missing workflow 500 interrupted, a timeout 504 operation_pending", async () => {
    await expect(awaitOperation(finished('SUCCESS', { ok: true, template: { a: 1 } }), start.workflowID, undefined, 1_000))
      .resolves.toEqual({ ok: true, template: { a: 1 } })
    await expect(awaitOperation(finished('CANCELLED'), start.workflowID, undefined, 1_000))
      .resolves.toMatchObject({ ok: false, status: 409, code: 'operation_cancelled' })
    await expect(awaitOperation(finished('ERROR'), start.workflowID, undefined, 1_000))
      .resolves.toEqual({ ok: false, status: 500, ...INTERRUPTED_FAILURE })
    await expect(awaitOperation(fakeClient(), start.workflowID, undefined, 1_000))
      .resolves.toEqual({ ok: false, status: 500, ...INTERRUPTED_FAILURE })
    await expect(awaitOperation(finished('PENDING'), start.workflowID, undefined, 30))
      .resolves.toMatchObject({ ok: false, status: 504, code: 'operation_pending' })
  })

  it("a client abort ends the wait with the abort's reason; a DBOS outage is 503", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const controller = new AbortController()
    const reason = new Error('client gone')
    const pending = finished('PENDING')
    const waiting = awaitOperation(pending, start.workflowID, controller.signal, 60_000).catch((error: unknown) => error)
    controller.abort(reason)
    expect(await waiting).toBe(reason)
    const failing = fakeClient()
    failing.listWorkflows.mockRejectedValue(new Error('connection refused'))
    await expect(awaitOperation(failing, start.workflowID, undefined, 1_000)).rejects.toMatchObject({ status: 503, code: 'persistence_unavailable' })
  })
})

describe('operationFailureOf', () => {
  it("keeps an ApiError's status, code and message and turns anything else into 500 unexpected_failure without its message", () => {
    expect(operationFailureOf(new ApiError(502, 'invalid_model_output', 'No root description.')))
      .toEqual({ status: 502, code: 'invalid_model_output', message: 'No root description.' })
    expect(operationFailureOf(new ModelKeyRequiredError())).toMatchObject({ status: 409, code: 'model_key_required' })
    const unexpected = operationFailureOf(new Error('ECONNRESET at 10.0.0.1'))
    expect(unexpected).toEqual({ status: 500, code: 'unexpected_failure', message: expect.any(String) })
    expect(unexpected.message).not.toContain('ECONNRESET')
  })

  it("keeps only FREE's copy, whatever the provider error holds", () => {
    const key = plantedKey()
    const provider = new APICallError({
      message: `Incorrect API key: Bearer ${key}`,
      url: 'https://provider.invalid/v1/chat/completions',
      requestBodyValues: { authorization: key },
      statusCode: 401,
      responseHeaders: { 'x-echo': key },
      responseBody: `{"error":"${key}"}`,
      cause: new Error(key),
    })
    const throwing = { get message(): string { throw new Error(key) } }
    for (const error of [provider, asModelOperationError(provider), new TypeError(`Bearer ${key} is not a legal header value`), key, throwing]) {
      const failure = operationFailureOf(error)
      expect(Object.keys(failure).sort()).toEqual(['code', 'message', 'status'])
      expect(holdsKey(failure, key)).toBe(false)
    }
    expect(holdsKey(provider, key)).toBe(true)
  })
})
