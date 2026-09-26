// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import type { ModelOperation } from '../shared/modelOperation.contract'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import { createSchemaEditorController, durableSchemaPersistence, localSchemaPersistence } from './currentSchemaRevision'
import { useModelOperationRecovery } from './useModelOperationRecovery'
import type { SchemaProposalReview } from './useSchemaProposalReview'

const { requestModelKeyResend } = vi.hoisted(() => ({ requestModelKeyResend: vi.fn() }))
vi.mock('./auth/authenticatedFetch', async (importOriginal) => ({
  ...await importOriginal<typeof import('./auth/authenticatedFetch')>(),
  requestModelKeyResend,
}))

const R1 = '51000000-0000-4000-8004-000000000001'
const R2 = '51000000-0000-4000-8004-000000000002'
const uuid = (n: number) => `51000000-0000-4000-8009-0000000000${n.toString(16).padStart(2, '0')}`
const TEMPLATE = { _description: 'One restored record.', restored: 'string' }
type Generation = Extract<ModelOperation, { kind: 'generation' }>
type Proposal = Extract<ModelOperation, { kind: 'proposal' }>

function generation(n: number, status: ModelOperation['status'], over: Partial<Generation> = {}): Generation {
  return {
    kind: 'generation', workflowId: `suggestion:${uuid(n)}`, operationId: uuid(n), status, instruction: `Instruction ${n}`,
    createdAt: new Date(1_700_000_000_000 - n).toISOString(), failure: null, baseSchemaRevisionId: R1,
    template: status === 'SUCCEEDED' ? TEMPLATE : null, ...over,
  }
}
function proposal(n: number, status: ModelOperation['status'], over: Partial<Proposal> = {}): Proposal {
  return {
    kind: 'proposal', workflowId: `edit:${uuid(n)}`, operationId: uuid(n), status, instruction: `Instruction ${n}`,
    createdAt: new Date(1_700_000_000_000 - n).toISOString(), failure: null, baseSchemaRevisionId: R1,
    // Fields are keyed by node ID: the base revision's nodes carry the IDs the model saw.
    response: status === 'SUCCEEDED'
      ? { status: 'proposed', fields: { 'id-title': { name: 'heading', type: 'string', removed: false } }, additions: [], issues: [] }
      : null,
    ...over,
  }
}
const KEY_MISSING = { code: 'model_key_required', message: 'Send the key.' }

const nodes: SchemaNode[] = [{ id: 'title', name: 'title', type: 'string' }]
const revision = (revisionNumber: number, name: string): SchemaRevision => ({
  schemaRevisionId: revisionNumber === 1 ? R1 : revisionNumber === 2 ? R2 : `rev-${revisionNumber}`,
  extractionSchemaId: 'schema-1', revisionNumber, origin: 'researcher-edit', createdAt: '2026-08-01T12:00:00.000Z',
  recordDescription: `One ${name} record.`, schemaNodes: [{ id: `id-${name}`, name, type: 'string' }],
})

/** A fetch answering each listing from `listings` in turn (the last one repeats) and every DELETE with 204. */
function stubFetch(listings: ModelOperation[][]) {
  const requests: string[] = []
  let served = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push(`${method} ${url}`)
    if (method === 'DELETE') return new Response(null, { status: 204 })
    const listing = listings[Math.min(served, listings.length - 1)] ?? []
    served += 1
    return new Response(JSON.stringify({ operations: listing }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  return { requests, listings: () => requests.filter((request) => request.startsWith('GET /api/model-operations')).length }
}

function durableSchema(initial: SchemaRevision | null = revision(1, 'site')) {
  const appends: number[] = []
  const persistence = durableSchemaPersistence({
    projectContextId: '51000000-0000-4000-8000-000000000001',
    initial,
    debounceMs: 0,
    append: async (_schemaId, expected, sent) => {
      appends.push(expected)
      return revision(expected + 1, sent.schemaNodes[0]!.name)
    },
    initialize: async (sent) => revision(1, sent.schemaNodes[0]!.name),
    listRevisions: async () => [],
    getRevision: async () => revision(1, 'historical'),
  })
  const schema = createSchemaEditorController(persistence, {
    initialDraft: initial ? { recordDescription: initial.recordDescription, schemaNodes: initial.schemaNodes } : null,
    initialExtractableRevisionId: initial?.schemaRevisionId ?? null,
  })
  return { schema, appends }
}

function reviewFake(): SchemaProposalReview & { start: ReturnType<typeof vi.fn> } {
  return {
    pending: null, acceptedChangeIds: new Set(), replay: null, canApply: false,
    start: vi.fn(), toggle: vi.fn(), apply: vi.fn(), discard: vi.fn(), reset: vi.fn(),
  } as unknown as SchemaProposalReview & { start: ReturnType<typeof vi.fn> }
}

function renderRecovery(schema: ReturnType<typeof durableSchema>['schema'], options: { busy?: boolean } = {}) {
  const proposalReview = reviewFake()
  const messages: string[] = []
  const onReopened = vi.fn()
  const hook = renderHook(() => useModelOperationRecovery({
    schema, proposalReview, busy: options.busy ?? false, appendMessage: (message) => messages.push(message), onReopened,
  }))
  return { hook, proposalReview, messages, onReopened }
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('useModelOperationRecovery', () => {
  it('polls every 2 s only while a watched operation runs, and stops on unmount', async () => {
    const running = generation(1, 'RUNNING')
    const stub = stubFetch([[running], [running], [generation(1, 'SUCCEEDED', { baseSchemaRevisionId: R2 })]])
    const { schema } = durableSchema()
    const { hook } = renderRecovery(schema)

    await tick(0)
    expect(stub.listings()).toBe(1)
    expect(hook.result.current.running).toEqual([running])
    await tick(2_000)
    expect(stub.listings()).toBe(2)
    await tick(2_000)
    expect(stub.listings()).toBe(3)
    expect(hook.result.current.running).toEqual([])
    await tick(10_000)
    expect(stub.listings()).toBe(3)
    expect(stub.requests[0]).toBe(`GET /api/model-operations?projectContextId=${encodeURIComponent('51000000-0000-4000-8000-000000000001')}&extractionSchemaId=schema-1`)

    const again = stubFetch([[running]])
    const second = renderRecovery(durableSchema().schema)
    await tick(1_000)
    expect(again.listings()).toBe(1)
    second.hook.unmount()
    await tick(10_000)
    expect(again.listings()).toBe(1)
  })

  it('a watched generation that finishes is saved onto its base; one whose base moved meanwhile is dropped', async () => {
    stubFetch([[generation(1, 'RUNNING')], [generation(1, 'SUCCEEDED')]])
    const saved = durableSchema()
    renderRecovery(saved.schema)
    await tick(0)
    await tick(2_000)
    expect(saved.appends).toEqual([1])
    expect(saved.schema.snapshot().draft?.recordDescription).toBe('One restored record.')
    expect(saved.schema.snapshot().extractableSchemaRevisionId).toBe(R2)

    stubFetch([[generation(1, 'RUNNING')], [generation(1, 'SUCCEEDED')]])
    const moved = durableSchema()
    renderRecovery(moved.schema)
    await tick(0)
    moved.schema.commit((current) => [...current, { id: 'year', name: 'year', type: 'number' }], 'edit')
    await tick(0)
    expect(moved.schema.snapshot().extractableSchemaRevisionId).toBe(R2)
    await tick(2_000)
    expect(moved.appends).toEqual([1])
    expect(moved.schema.snapshot().draft?.recordDescription).toBe('One site record.')
  })

  it('a restored proposal reopens the review bar through proposalReview.start with its workflow ID', async () => {
    const reopened = proposal(1, 'SUCCEEDED')
    stubFetch([[reopened]])
    const { schema } = durableSchema(revision(1, 'title'))
    const { proposalReview, messages, onReopened } = renderRecovery(schema)

    await tick(100)

    expect(proposalReview.start).toHaveBeenCalledOnce()
    const [derived, original, draftVersion, base, workflowId] = proposalReview.start.mock.calls[0]!
    expect(derived.changes.map((change: { kind: string }) => change.kind)).toEqual(['modified'])
    expect(original).toEqual(schema.snapshot().draft?.schemaNodes)
    expect(draftVersion).toBe(schema.snapshot().draftVersion)
    expect(base).toBe(R1)
    expect(workflowId).toBe(reopened.workflowId)
    expect(onReopened).toHaveBeenCalledExactlyOnceWith(derived)
    expect(messages).toEqual(['Reopened the proposal for “Instruction 1”.'])
  })

  it('a restored model_key_required failure resends the keys once', async () => {
    const failed = generation(2, 'FAILED', { failure: KEY_MISSING })
    stubFetch([[generation(1, 'RUNNING'), failed], [generation(1, 'RUNNING'), failed], [generation(1, 'FAILED', { failure: KEY_MISSING }), failed]])
    renderRecovery(durableSchema().schema)

    await tick(0)
    expect(requestModelKeyResend).toHaveBeenCalledTimes(1)
    await tick(2_000)
    expect(requestModelKeyResend).toHaveBeenCalledTimes(1)
    await tick(2_000)
    expect(requestModelKeyResend).toHaveBeenCalledTimes(2)
    await tick(10_000)
    expect(requestModelKeyResend).toHaveBeenCalledTimes(2)
  })

  it('operations this tab starts after load are left to the live path', async () => {
    const watched = generation(2, 'RUNNING')
    const later = generation(1, 'RUNNING')
    stubFetch([[watched], [later, watched], [generation(1, 'SUCCEEDED'), generation(2, 'SUCCEEDED')]])
    const { schema, appends } = durableSchema()
    const { hook } = renderRecovery(schema)

    await tick(0)
    await tick(2_000)
    expect(hook.result.current.running).toEqual([watched])
    await tick(2_000)
    expect(appends).toEqual([1])
    expect(hook.result.current.running).toEqual([])
    const stub = stubFetch([[later]])
    await tick(10_000)
    expect(stub.listings()).toBe(0)
  })

  it('local drafts list nothing', async () => {
    const stub = stubFetch([[generation(1, 'RUNNING')]])
    const schema = createSchemaEditorController(localSchemaPersistence({ onEdit: () => {} }), { initialDraft: { recordDescription: 'One record.', schemaNodes: nodes } })
    renderRecovery(schema)
    await tick(5_000)
    expect(stub.requests).toEqual([])
  })

  it('stop cancels the operation on the server', async () => {
    const stub = stubFetch([[generation(1, 'RUNNING')]])
    const { hook } = renderRecovery(durableSchema().schema)
    await tick(0)
    act(() => hook.result.current.stop(`suggestion:${uuid(1)}`))
    await tick(0)
    expect(stub.requests).toContain(`DELETE /api/model-operations/${encodeURIComponent(`suggestion:${uuid(1)}`)}`)
  })
})
