import type { WorkflowStatus } from '@dbos-inc/dbos-sdk'
import { INTERRUPTED_FAILURE } from 'db'
import { describe, expect, it, vi } from 'vitest'
import type { ResearcherProjectStore } from '../../../packages/db/src/project-store.js'
import { modelOperationListingSchema } from '../shared/modelOperation.contract'
import type { ModelOperationClient } from './_model_operation.js'
import { createModelOperationHandlers, modelOperationOf } from './model_operations.js'

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const OTHER_ACCOUNT = '51000000-0000-4000-8009-000000000002'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const SCHEMA = '51000000-0000-4000-8003-000000000001'
const SOURCE_REVISION = '51000000-0000-4000-8002-000000000001'
const R1 = '51000000-0000-4000-8004-000000000001'
const R2 = '51000000-0000-4000-8004-000000000002'
const PROPOSED = { status: 'proposed', fields: {}, additions: [], issues: [] }
const TEMPLATE = { _description: 'One entry.', title: 'string' }
const uuid = (n: number) => `51000000-0000-4000-8009-0000000000${n.toString(16).padStart(2, '0')}`

type Overrides = Partial<{
  input: Record<string, unknown> | null
  output: unknown
  createdAt: number
  authenticatedUser: string
  attributes: Record<string, unknown>
}>

/** One recorded workflow as DBOS lists it: a generation on no schema, or a proposal on R1 of SCHEMA. */
function row(kind: 'suggestion' | 'edit', n: number, status: string, overrides: Overrides = {}): WorkflowStatus {
  const operationId = uuid(n)
  const input = kind === 'suggestion'
    ? { operationId, owner: ACCOUNT, projectContextId: PROJECT, sourceRepresentationRevisionId: SOURCE_REVISION,
        extractionSchemaId: null, baseSchemaRevisionId: null, instruction: `Instruction ${n}`, temperature: null }
    : { operationId, owner: ACCOUNT, projectContextId: PROJECT, extractionSchemaId: SCHEMA, baseSchemaRevisionId: R1,
        sourceRepresentationRevisionId: null, instruction: `Instruction ${n}`, temperature: null }
  return {
    workflowID: `${kind}:${operationId}`,
    status,
    workflowName: kind === 'suggestion' ? 'suggestSchema' : 'proposeSchemaEdit',
    workflowClassName: '',
    authenticatedUser: overrides.authenticatedUser ?? ACCOUNT,
    ...(overrides.input === null ? {} : { input: [{ ...input, ...overrides.input }] }),
    output: overrides.output,
    createdAt: overrides.createdAt ?? 1_700_000_000_000 + n,
    priority: 0,
    attributes: overrides.attributes ?? { projectContextId: PROJECT, extractionSchemaId: kind === 'suggestion' ? null : SCHEMA },
  }
}

function fakeClient(rows: WorkflowStatus[]) {
  const client = {
    enqueue: vi.fn(async () => ({}) as never),
    getWorkflow: vi.fn(async (id: string) => rows.find((candidate) => candidate.workflowID === id)),
    listWorkflows: vi.fn(async () => rows),
    cancelWorkflow: vi.fn<(workflowId: string) => Promise<void>>(async () => {}),
    deleteWorkflows: vi.fn<(workflowIds: string[]) => Promise<void>>(async () => {}),
  }
  return client as unknown as ModelOperationClient & typeof client
}

type Store = Pick<ResearcherProjectStore, 'researcherAccountId' | 'modelOperationScopeExists'>
function store(exists: () => Promise<boolean> = async () => true): Store {
  return { researcherAccountId: ACCOUNT, modelOperationScopeExists: vi.fn(exists) }
}

function handlers(rows: WorkflowStatus[], owned: Store = store()) {
  const client = fakeClient(rows)
  return { client, ...createModelOperationHandlers(owned, () => client) }
}
const get = (query: string) => new Request(`http://local.test/api/model-operations${query}`)
const del = (tail: string) => new Request(`http://local.test/api/model-operations/${tail}`, { method: 'DELETE' })
const LISTING = {
  workflow_id_prefix: ['suggestion:', 'edit:'], authenticatedUser: ACCOUNT, loadInput: true, loadOutput: true, sortDesc: true, limit: 20,
}

const EXCERPTED = { complete: false as const, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] }

describe('GET /api/model-operations', () => {
  it("lists the owner's generations and edits for a scope, newest first, in one listWorkflows call", async () => {
    const rows = [row('edit', 2, 'PENDING'), row('suggestion', 1, 'SUCCESS', { output: { ok: true, template: TEMPLATE, raw: '{}', pages: null, baseSchemaRevisionId: null } })]
    const { GET, client } = handlers(rows)

    const response = await GET(get(`?projectContextId=${PROJECT}`))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = modelOperationListingSchema.parse(await response.json())
    expect(body.operations.map((operation) => operation.workflowId)).toEqual([`edit:${uuid(2)}`, `suggestion:${uuid(1)}`])
    expect(client.listWorkflows).toHaveBeenCalledExactlyOnceWith({ ...LISTING, attributes: { projectContextId: PROJECT, extractionSchemaId: null } })

    const scoped = handlers(rows)
    expect((await scoped.GET(get(`?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))).status).toBe(200)
    expect(scoped.client.listWorkflows).toHaveBeenCalledExactlyOnceWith({ ...LISTING, attributes: { projectContextId: PROJECT, extractionSchemaId: SCHEMA } })
    expect(scoped.client.getWorkflow).not.toHaveBeenCalled()
  })

  it('maps live, finished and stopped workflows', async () => {
    const rows = [
      row('suggestion', 1, 'ENQUEUED'),
      row('edit', 2, 'PENDING'),
      row('suggestion', 3, 'SUCCESS', { output: { ok: true, template: TEMPLATE, raw: '{}', pages: 2, sourceCoverage: EXCERPTED, baseSchemaRevisionId: R1 }, input: { baseSchemaRevisionId: R1, extractionSchemaId: SCHEMA } }),
      row('edit', 4, 'SUCCESS', { output: { ok: true, baseSchemaRevisionId: R1, response: PROPOSED } }),
      row('suggestion', 5, 'SUCCESS', { output: { ok: false, status: 502, code: 'model_operation_failed', message: 'The model call failed.' } }),
      row('edit', 6, 'CANCELLED'),
      row('suggestion', 7, 'ERROR'),
      row('edit', 8, 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'),
      // A row without its input, or one that is not a model operation, is not listed.
      row('edit', 9, 'SUCCESS', { input: null }),
      { ...row('suggestion', 10, 'SUCCESS'), workflowID: `batch:${uuid(10)}` },
    ]
    const { GET } = handlers(rows)

    const body = modelOperationListingSchema.parse(await (await GET(get(`?projectContextId=${PROJECT}`))).json())

    const common = (n: number, kind: 'suggestion' | 'edit') => ({
      workflowId: `${kind}:${uuid(n)}`, operationId: uuid(n), instruction: `Instruction ${n}`, createdAt: new Date(1_700_000_000_000 + n).toISOString(),
    })
    // Newest first: the rows were admitted in order 1..8.
    expect(body.operations.slice().reverse()).toEqual([
      { kind: 'generation', ...common(1, 'suggestion'), status: 'QUEUED', failure: null, baseSchemaRevisionId: null, template: null, sourceCoverage: null },
      { kind: 'proposal', ...common(2, 'edit'), status: 'RUNNING', failure: null, baseSchemaRevisionId: R1, response: null },
      { kind: 'generation', ...common(3, 'suggestion'), status: 'SUCCEEDED', failure: null, baseSchemaRevisionId: R1, template: TEMPLATE, sourceCoverage: EXCERPTED },
      { kind: 'proposal', ...common(4, 'edit'), status: 'SUCCEEDED', failure: null, baseSchemaRevisionId: R1, response: PROPOSED },
      { kind: 'generation', ...common(5, 'suggestion'), status: 'FAILED', failure: { code: 'model_operation_failed', message: 'The model call failed.' }, baseSchemaRevisionId: null, template: null, sourceCoverage: null },
      { kind: 'proposal', ...common(6, 'edit'), status: 'FAILED', failure: { ...INTERRUPTED_FAILURE }, baseSchemaRevisionId: R1, response: null },
      { kind: 'generation', ...common(7, 'suggestion'), status: 'FAILED', failure: { ...INTERRUPTED_FAILURE }, baseSchemaRevisionId: null, template: null, sourceCoverage: null },
      { kind: 'proposal', ...common(8, 'edit'), status: 'FAILED', failure: { ...INTERRUPTED_FAILURE }, baseSchemaRevisionId: R1, response: null },
    ])
    // A generation recorded before the source declaration existed lists as not recorded.
    expect(modelOperationOf(row('suggestion', 11, 'SUCCESS', { output: { ok: true, template: TEMPLATE, raw: '{}', pages: 2, baseSchemaRevisionId: null } })))
      .toMatchObject({ status: 'SUCCEEDED', template: TEMPLATE, sourceCoverage: null })
    expect(modelOperationOf(rows[8]!)).toBeNull()
    expect(modelOperationOf(rows[9]!)).toBeNull()
  })

  it('orders two operations admitted in the same millisecond newest-first by workflow ID', async () => {
    const at = 1_700_000_000_500
    const rows = [row('edit', 1, 'PENDING', { createdAt: at }), row('edit', 2, 'PENDING', { createdAt: at }), row('suggestion', 3, 'PENDING', { createdAt: at - 1 })]
    const { GET } = handlers(rows)

    const body = modelOperationListingSchema.parse(await (await GET(get(`?projectContextId=${PROJECT}`))).json())

    expect(body.operations.map((operation) => operation.workflowId)).toEqual([`edit:${uuid(2)}`, `edit:${uuid(1)}`, `suggestion:${uuid(3)}`])
  })

  it('an unowned or deleted scope is 404 and lists nothing', async () => {
    const owned = store(async () => false)
    const { GET, client } = handlers([row('edit', 1, 'PENDING')], owned)

    const response = await GET(get(`?projectContextId=${PROJECT}&extractionSchemaId=${SCHEMA}`))

    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: { code: 'not_found', message: 'Model operation was not found.' } })
    expect(owned.modelOperationScopeExists).toHaveBeenCalledExactlyOnceWith(PROJECT, SCHEMA)
    expect(client.listWorkflows).not.toHaveBeenCalled()
  })

  it('a malformed scope is 422', async () => {
    const owned = store()
    const { GET, client } = handlers([], owned)
    for (const query of ['', '?projectContextId=nope', '?projectContextId=51000000-0000-4000-8000-00000000000A', `?projectContextId=${PROJECT}&extractionSchemaId=x`]) {
      const response = await GET(get(query))
      expect(response.status, query).toBe(422)
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    }
    expect(owned.modelOperationScopeExists).not.toHaveBeenCalled()
    expect(client.listWorkflows).not.toHaveBeenCalled()
    expect((await GET(new Request(`http://local.test/api/model-operations/edit:${uuid(1)}`))).status).toBe(404)
  })

  it('a DBOS outage is 503', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { GET, client } = handlers([])
    client.listWorkflows.mockRejectedValueOnce(new Error('connection refused'))
    const response = await GET(get(`?projectContextId=${PROJECT}`))
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: { code: 'persistence_unavailable', message: 'Model operations are unavailable.' } })

    const storeDown = handlers([], store(async () => { throw new Error('connection refused') }))
    expect((await storeDown.GET(get(`?projectContextId=${PROJECT}`))).status).toBe(503)
    expect(storeDown.client.listWorkflows).not.toHaveBeenCalled()
    vi.restoreAllMocks()
  })
})

describe('DELETE /api/model-operations/<workflow ID>', () => {
  it('cancels a live operation', async () => {
    for (const status of ['ENQUEUED', 'PENDING']) {
      const { DELETE, client } = handlers([row('edit', 1, status)])
      const response = await DELETE(del(encodeURIComponent(`edit:${uuid(1)}`)))
      expect(response.status, status).toBe(204)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(client.cancelWorkflow).toHaveBeenCalledExactlyOnceWith(`edit:${uuid(1)}`)
      expect(client.deleteWorkflows).not.toHaveBeenCalled()
    }
  })

  it("deletes a finished proposal and every older finished proposal on its base, never a newer one or another base's", async () => {
    const proposal = (n: number, base: string) => row('edit', n, 'SUCCESS', { output: { ok: true, baseSchemaRevisionId: base, response: PROPOSED }, input: { baseSchemaRevisionId: base } })
    const rows = [proposal(1, R1), proposal(2, R1), proposal(3, R1), proposal(4, R2)]
    const owned = store()
    const { DELETE, client } = handlers(rows, owned)

    const response = await DELETE(del(encodeURIComponent(`edit:${uuid(2)}`)))

    expect(response.status).toBe(204)
    expect(owned.modelOperationScopeExists).toHaveBeenCalledExactlyOnceWith(PROJECT, SCHEMA)
    expect(client.listWorkflows).toHaveBeenCalledExactlyOnceWith({
      workflow_id_prefix: 'edit:', attributes: { projectContextId: PROJECT, extractionSchemaId: SCHEMA },
      authenticatedUser: ACCOUNT, status: 'SUCCESS', loadInput: true, loadOutput: false,
    })
    expect(client.deleteWorkflows).toHaveBeenCalledOnce()
    expect([...client.deleteWorkflows.mock.calls[0]![0]].sort()).toEqual([`edit:${uuid(1)}`, `edit:${uuid(2)}`])
    expect(client.cancelWorkflow).not.toHaveBeenCalled()
  })

  it('discards two proposals admitted in the same millisecond in the order the listing shows', async () => {
    const at = 1_700_000_000_500
    const proposal = (n: number) => row('edit', n, 'SUCCESS', { output: { ok: true, baseSchemaRevisionId: R1, response: PROPOSED }, createdAt: at })
    const newestFirst = handlers([proposal(1), proposal(2)])
    expect((await newestFirst.DELETE(del(encodeURIComponent(`edit:${uuid(2)}`)))).status).toBe(204)
    expect([...newestFirst.client.deleteWorkflows.mock.calls[0]![0]].sort()).toEqual([`edit:${uuid(1)}`, `edit:${uuid(2)}`])

    const oldestFirst = handlers([proposal(1), proposal(2)])
    expect((await oldestFirst.DELETE(del(encodeURIComponent(`edit:${uuid(1)}`)))).status).toBe(204)
    expect(oldestFirst.client.deleteWorkflows).toHaveBeenCalledExactlyOnceWith([`edit:${uuid(1)}`])
  })

  it('deletes nothing for any other settled operation', async () => {
    const settled = [
      row('suggestion', 1, 'SUCCESS', { output: { ok: true, template: TEMPLATE, raw: '{}', pages: null, baseSchemaRevisionId: null } }),
      row('edit', 2, 'SUCCESS', { output: { ok: false, status: 502, code: 'model_operation_failed', message: 'Failed.' } }),
      row('edit', 3, 'CANCELLED'),
    ]
    for (const recorded of settled) {
      const { DELETE, client } = handlers([recorded])
      expect((await DELETE(del(encodeURIComponent(recorded.workflowID)))).status, recorded.workflowID).toBe(204)
      expect(client.cancelWorkflow).not.toHaveBeenCalled()
      expect(client.deleteWorkflows).not.toHaveBeenCalled()
      expect(client.listWorkflows).not.toHaveBeenCalled()
    }
  })

  it('a workflow of another account, of a deleted scope, or a malformed or percent-broken ID is 404 and changes nothing', async () => {
    const foreign = handlers([row('edit', 1, 'PENDING', { authenticatedUser: OTHER_ACCOUNT })])
    const gone = handlers([row('edit', 1, 'PENDING')], store(async () => false))
    const unknown = handlers([])
    const malformed = handlers([row('edit', 1, 'PENDING')])
    const cases: [string, ReturnType<typeof handlers>, string][] = [
      ['another account', foreign, encodeURIComponent(`edit:${uuid(1)}`)],
      ['a deleted scope', gone, encodeURIComponent(`edit:${uuid(1)}`)],
      ['an unknown workflow', unknown, encodeURIComponent(`suggestion:${uuid(1)}`)],
      ['a chat ID', malformed, encodeURIComponent(`chat:${uuid(1)}`)],
      ['a bare UUID', malformed, uuid(1)],
      ['a broken escape', malformed, '%E0%A4%A'],
      ['no ID', malformed, ''],
    ]
    for (const [what, { DELETE, client }, tail] of cases) {
      const response = await DELETE(del(tail))
      expect(response.status, what).toBe(404)
      await expect(response.json()).resolves.toEqual({ error: { code: 'not_found', message: 'Model operation was not found.' } })
      expect(client.cancelWorkflow, what).not.toHaveBeenCalled()
      expect(client.deleteWorkflows, what).not.toHaveBeenCalled()
    }
    expect(malformed.client.getWorkflow).not.toHaveBeenCalled()
    expect(gone.client.getWorkflow).toHaveBeenCalledOnce()
  })

  it('a DBOS outage is 503', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { DELETE, client } = handlers([row('edit', 1, 'PENDING')])
    client.cancelWorkflow.mockRejectedValueOnce(new Error('connection refused'))
    const response = await DELETE(del(encodeURIComponent(`edit:${uuid(1)}`)))
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    vi.restoreAllMocks()
  })
})
