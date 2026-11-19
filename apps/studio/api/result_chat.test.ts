import { describe, expect, it, vi } from 'vitest'
import { DurableNotFound } from 'extraction/durable'
import type { ModelOperationClient } from './_model_operation.js'
import { createPostResultChat } from './result_chat.js'

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const EXTRACTION = '51000000-0000-4000-8006-000000000001'
const OPERATION = '51000000-0000-4000-8009-0000000000f4'
const PROPOSAL = { extractionId: EXTRACTION, snapshotVersion: 4, corrections: [], reply: 'Which record?', dropped: [] }
const head = { projectId: PROJECT, snapshotVersion: 4, feedbackVersion: 9 }

function operations(output: unknown = { ok: true, proposal: PROPOSAL }) {
  const enqueued: { options: Record<string, unknown>; input: unknown }[] = []
  const client = {
    enqueue: vi.fn(async (options: Record<string, unknown>, input: unknown) => { enqueued.push({ options, input }); return {} as never }),
    getWorkflow: vi.fn(async () => {
      const last = enqueued.at(-1)
      return last ? { workflowName: last.options.workflowName, input: [last.input] } : undefined
    }),
    listWorkflows: vi.fn(async () => [{ workflowID: `correct:${OPERATION}`, status: 'SUCCESS', output }]),
    cancelWorkflow: vi.fn(async () => {}),
    deleteWorkflows: vi.fn(async () => {}),
  }
  return { enqueued, client: client as unknown as ModelOperationClient & typeof client }
}

function form(fields: Record<string, string>): Request {
  const body = new FormData()
  for (const [name, value] of Object.entries(fields)) body.append(name, value)
  return new Request('http://local.test/api/result_chat', { method: 'POST', body })
}
const base = { extraction_id: EXTRACTION, operation_id: OPERATION, message: ' The year of record 3 should be 1854 ' }

describe('POST /api/result_chat', () => {
  it('starts correct:<operation_id> on the latest snapshot and decision version, and answers with the proposal', async () => {
    const { enqueued, client } = operations()
    const readHead = vi.fn(async () => head)
    const response = await createPostResultChat(ACCOUNT, readHead, () => client)(form({ ...base, history: JSON.stringify([{ role: 'user', text: 'Run it' }]) }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(PROPOSAL)
    expect(readHead).toHaveBeenCalledExactlyOnceWith(EXTRACTION)
    expect(enqueued).toEqual([{
      options: {
        queueName: 'studio', workflowName: 'proposeResultCorrections', workflowID: `correct:${OPERATION}`, authenticatedUser: ACCOUNT,
        attributes: { projectContextId: PROJECT, extractionId: EXTRACTION },
      },
      input: {
        operationId: OPERATION, owner: ACCOUNT, extractionId: EXTRACTION, snapshotVersion: 4, feedbackVersion: 9,
        message: 'The year of record 3 should be 1854', history: [{ role: 'user', text: 'Run it' }], temperature: null,
      },
    }])
  })

  it('pins a snapshot named, and refuses one that is not saved', async () => {
    const named = operations()
    expect((await createPostResultChat(ACCOUNT, async () => head, () => named.client)(form({ ...base, snapshot_version: '2' }))).status).toBe(200)
    expect(named.enqueued[0]!.input).toMatchObject({ snapshotVersion: 2 })
    for (const version of ['0', '5', 'x']) {
      const refused = operations()
      expect((await createPostResultChat(ACCOUNT, async () => head, () => refused.client)(form({ ...base, snapshot_version: version }))).status).toBe(422)
      expect(refused.enqueued).toEqual([])
    }
  })

  it('refuses an Extraction with no saved values yet, and one the researcher does not own', async () => {
    const empty = operations()
    const none = await createPostResultChat(ACCOUNT, async () => ({ ...head, snapshotVersion: 0 }), () => empty.client)(form(base))
    expect(none.status).toBe(409)
    expect(empty.enqueued).toEqual([])
    const missing = await createPostResultChat(ACCOUNT, async () => { throw new DurableNotFound('gone') }, () => empty.client)(form(base))
    expect(missing.status).toBe(404)
  })

  it('answers the operation\'s failure with its status', async () => {
    const failed = operations({ ok: false, status: 409, code: 'invalid_model_config', message: 'No Assistant model is configured to change results.' })
    const response = await createPostResultChat(ACCOUNT, async () => head, () => failed.client)(form(base))
    expect(response.status).toBe(409)
  })
})
