import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  BatchSchemaSuggestionRecord,
  ResearcherProjectStore,
} from 'db'
import { createResearcherApiHandlers } from './batch_schema_suggestions.js'
import { batchSchemaSuggestionErrorResponseSchema } from '../shared/batchSchemaSuggestion.contract.js'

// The worker store is how a process-local pump claimed work; no route may build or use one.
const worker = vi.hoisted(() => ({ created: vi.fn() }))
vi.mock('db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('db')>()
  return {
    ...actual,
    createInternalProjectWorkerStore: (...args: Parameters<typeof actual.createInternalProjectWorkerStore>) => {
      worker.created(...args)
      return new Proxy({}, { get: (_target, method) => () => { throw new Error(`A route called the worker store's ${String(method)}.`) } })
    },
  }
})

const researcherAccountId = '51000000-0000-4000-8009-000000000001'
const projectContextId = '51000000-0000-4000-8000-000000000001'
const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
const representationRevisionId = '51000000-0000-4000-8002-000000000001'
const suggestionId = '51000000-0000-4000-8008-000000000001'
const now = new Date('2026-08-15T10:00:00.000Z')
const definition = {
  recordDescription: 'One place.',
  schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
}

const suggestion: BatchSchemaSuggestionRecord = {
  batchSchemaSuggestionId: suggestionId,
  projectContextId,
  selectionKey: 'a'.repeat(64),
  attempt: 1,
  executionStatus: 'COMPLETED',
  phase: 'READY',
  sourceKind: 'DOCUMENTS',
  columnFieldMapping: null,
  projectSpreadsheetVersionId: null,
  proposal: definition,
  coverage: [{ nodeId: 'place', present: 1, total: 1 }],
  draft: definition,
  failure: null,
  savedSchema: null,
  createdAt: now,
  sources: [
    {
      sourceDocumentId,
      sourceRepresentationRevisionId: representationRevisionId,
      descriptor: {
        artifactReference: 'b'.repeat(64),
        artifactSha256: 'b'.repeat(64),
      },
    },
  ],
}

function handlersFor(store: Partial<ResearcherProjectStore>) {
  return createResearcherApiHandlers({
    researcherAccountId,
    ...store,
  } as ResearcherProjectStore)
}
const handlerFor = (store: Partial<ResearcherProjectStore>) => handlersFor(store).POST

const applyRequest = () =>
  new Request(
    `http://test/api/batch-schema-suggestions/${suggestionId}/apply?projectContextId=${projectContextId}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  )
const savedSchema = {
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  schemaRevisionId: '51000000-0000-4000-8004-000000000001',
}
const retryRequest = (body: unknown) =>
  new Request(
    `http://test/api/batch-schema-suggestions/${suggestionId}/retry?projectContextId=${projectContextId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )

describe('Batch Schema Suggestion APIs', () => {
  it('keeps the worker store\'s attempt methods out of request stores', () => {
    expectTypeOf<ResearcherProjectStore>().not.toHaveProperty('publishBatchSchemaSuggestion')
    expectTypeOf<ResearcherProjectStore>().not.toHaveProperty('failBatchSchemaSuggestionAttempt')
    expectTypeOf<ResearcherProjectStore>().not.toHaveProperty('isPackageReferenced')
  })

  it('apply saves the attempt\'s settled result through the store and answers the suggestion with its saved schema', async () => {
    const applyBatchSchemaSuggestion = vi.fn(async () => ({
      status: 'applied' as const,
      suggestion: { ...suggestion, savedSchema },
    }))
    const response = await handlerFor({ getBatchSchemaSuggestion: vi.fn(async () => suggestion), applyBatchSchemaSuggestion })(applyRequest())

    expect(response.status).toBe(200)
    // The attempt read is the one applied: a retry started since makes the store refuse it.
    expect(applyBatchSchemaSuggestion).toHaveBeenCalledWith(projectContextId, suggestionId, 1, definition)
    expect(await response.json()).toMatchObject({ batchSchemaSuggestion: { savedSchema } })
  })

  it.each([
    ['still suggesting', { ...suggestion, executionStatus: 'RUNNING' as const, phase: null, draft: null }],
    ['found no common fields', { ...suggestion, phase: 'HETEROGENEOUS' as const, draft: null }],
    ['holds a stored result that is no schema definition', { ...suggestion, draft: { recordDescription: 'Nothing.', schemaNodes: 'none' } }],
  ] satisfies [string, BatchSchemaSuggestionRecord][])('apply refuses a suggestion that %s with 409 operation_not_ready, saving nothing', async (_, read) => {
    const applyBatchSchemaSuggestion = vi.fn()
    const response = await handlerFor({ getBatchSchemaSuggestion: vi.fn(async () => read), applyBatchSchemaSuggestion })(applyRequest())

    expect(response.status).toBe(409)
    expect(batchSchemaSuggestionErrorResponseSchema.parse(await response.json()).error.code).toBe('operation_not_ready')
    expect(applyBatchSchemaSuggestion).not.toHaveBeenCalled()
  })

  it('apply answers 409 when another attempt started after the read, and 404 for a suggestion the account cannot reach', async () => {
    const getBatchSchemaSuggestion = vi.fn(async () => suggestion)
    const stale = await handlerFor({ getBatchSchemaSuggestion, applyBatchSchemaSuggestion: vi.fn(async () => ({ status: 'not-ready' as const })) })(applyRequest())
    expect(stale.status).toBe(409)
    expect((await handlerFor({ getBatchSchemaSuggestion: vi.fn(async () => null) })(applyRequest())).status).toBe(404)
    expect((await handlerFor({ getBatchSchemaSuggestion, applyBatchSchemaSuggestion: vi.fn(async () => null) })(applyRequest())).status).toBe(404)
  })

  it('creation answers 202 with the admitted attempt', async () => {
    const createBatchSchemaSuggestion = vi.fn(async () => ({
      status: 'created' as const,
      suggestion: { ...suggestion, executionStatus: 'QUEUED' as const, phase: null, proposal: null, coverage: null, draft: null },
    }))
    const response = await handlerFor({ createBatchSchemaSuggestion })(
      new Request('http://test/api/batch-schema-suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectContextId, sourceDocumentIds: [sourceDocumentId] }),
      }),
    )

    expect(response.status).toBe(202)
    expect(createBatchSchemaSuggestion).toHaveBeenCalledWith(projectContextId, [sourceDocumentId])
    expect(await response.json()).toEqual({
      batchSchemaSuggestion: {
        batchSchemaSuggestionId: suggestionId,
        projectContextId,
        selectionKey: 'a'.repeat(64),
        attempt: 1,
        executionStatus: 'QUEUED',
        phase: null,
        sourceKind: 'DOCUMENTS',
        columnFieldMapping: null,
        projectSpreadsheetVersionId: null,
        proposal: null,
        sourceCoverage: null,
        failure: null,
        savedSchema: null,
        createdAt: now.toISOString(),
        sources: [{ sourceDocumentId, sourceRepresentationRevisionId: representationRevisionId }],
      },
    })
  })

  it('no route wakes a worker: every route answers without a worker store or work left behind in this process', async () => {
    // Create, list, read and retry used to kick an in-process pump that claimed work through the worker store; the
    // attempt's workflow now runs on DBOS, admitted with its rows.
    vi.useFakeTimers()
    try {
      const { GET, POST } = handlersFor({
        createBatchSchemaSuggestion: vi.fn(async () => ({ status: 'created' as const, suggestion })),
        listBatchSchemaSuggestions: vi.fn(async () => [suggestion]),
        getBatchSchemaSuggestion: vi.fn(async () => suggestion),
        retryBatchSchemaSuggestion: vi.fn(async () => ({ status: 'retried' as const, suggestion: { ...suggestion, attempt: 2 } })),
      })
      const answers = [
        await POST(new Request('http://test/api/batch-schema-suggestions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ projectContextId, sourceDocumentIds: [sourceDocumentId] }),
        })),
        await GET(new Request(`http://test/api/batch-schema-suggestions?projectContextId=${projectContextId}`)),
        await GET(new Request(`http://test/api/batch-schema-suggestions/${suggestionId}?projectContextId=${projectContextId}`)),
        await POST(retryRequest({ expectedAttempt: 1 })),
      ]
      expect(answers.map((answer) => answer.status)).toEqual([202, 200, 200, 202])
      expect(worker.created).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the list and read routes answer without starting work', async () => {
    const store = {
      listBatchSchemaSuggestions: vi.fn(async () => [suggestion]),
      getBatchSchemaSuggestion: vi.fn(async () => suggestion),
      createBatchSchemaSuggestion: vi.fn(),
      retryBatchSchemaSuggestion: vi.fn(),
    }
    const { GET } = handlersFor(store)

    const listed = await GET(new Request(`http://test/api/batch-schema-suggestions?projectContextId=${projectContextId}`))
    const read = await GET(new Request(`http://test/api/batch-schema-suggestions/${suggestionId}?projectContextId=${projectContextId}`))

    expect(listed.status).toBe(200)
    expect(read.status).toBe(200)
    expect((await listed.json()).batchSchemaSuggestions).toHaveLength(1)
    expect(store.createBatchSchemaSuggestion).not.toHaveBeenCalled()
    expect(store.retryBatchSchemaSuggestion).not.toHaveBeenCalled()
  })

  it('reads the stored source declaration, and still loads a suggestion stored with schema-path counts', async () => {
    const declared = [{
      sourceDocumentId,
      sourceCoverage: { complete: false, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] },
      combined: false,
    }]
    // Rows published before the declaration hold the retired path-agreement counts in the same column.
    const legacy = { ...suggestion, batchSchemaSuggestionId: '51000000-0000-4000-8008-000000000002' }
    const current = { ...suggestion, coverage: declared }
    const { GET } = handlersFor({ listBatchSchemaSuggestions: vi.fn(async () => [legacy, current]) })

    const listed = await GET(new Request(`http://test/api/batch-schema-suggestions?projectContextId=${projectContextId}`))

    expect(listed.status).toBe(200)
    const body = await listed.json()
    expect(body.batchSchemaSuggestions.map((item: Record<string, unknown>) => item.sourceCoverage)).toEqual([null, declared])
    expect(body.batchSchemaSuggestions[0]).not.toHaveProperty('coverage')
  })

  it('status reads are derived and a DBOS outage is 503', async () => {
    const interrupted = {
      ...suggestion,
      attempt: 2,
      executionStatus: 'FAILED' as const,
      failure: { code: 'interrupted', message: 'This work stopped before it finished. Start it again.' },
    }
    const getBatchSchemaSuggestion = vi
      .fn<ResearcherProjectStore['getBatchSchemaSuggestion']>()
      .mockResolvedValueOnce(interrupted)
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED: DBOS is unavailable'))
    const listBatchSchemaSuggestions = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED: DBOS is unavailable')
    })
    const { GET } = handlersFor({ getBatchSchemaSuggestion, listBatchSchemaSuggestions })
    const read = () => GET(new Request(`http://test/api/batch-schema-suggestions/${suggestionId}?projectContextId=${projectContextId}`))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const derived = await read()
    expect(derived.status).toBe(200)
    expect((await derived.json()).batchSchemaSuggestion).toMatchObject({
      attempt: 2,
      executionStatus: 'FAILED',
      failure: { code: 'interrupted' },
      proposal: definition,
    })
    const outage = await read()
    expect(outage.status).toBe(503)
    expect((await outage.json()).error.code).toBe('persistence_unavailable')
    const listOutage = await GET(new Request(`http://test/api/batch-schema-suggestions?projectContextId=${projectContextId}`))
    expect(listOutage.status).toBe(503)
  })

  it('retry carries expectedAttempt: 202 with the successor, 409 attempt_conflict for an older one, 409 operation_not_ready while one runs', async () => {
    const retryBatchSchemaSuggestion = vi
      .fn<ResearcherProjectStore['retryBatchSchemaSuggestion']>()
      .mockResolvedValueOnce({ status: 'retried', suggestion: { ...suggestion, attempt: 2, executionStatus: 'QUEUED' } })
      .mockResolvedValueOnce({ status: 'replayed', suggestion: { ...suggestion, attempt: 2, executionStatus: 'COMPLETED' } })
      .mockResolvedValueOnce({ status: 'attempt-conflict' })
      .mockResolvedValueOnce({ status: 'not-ready' })
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED: DBOS is unavailable'))
    const handler = handlerFor({ retryBatchSchemaSuggestion })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const retried = await handler(retryRequest({ expectedAttempt: 1 }))
    expect(retried.status).toBe(202)
    expect((await retried.json()).batchSchemaSuggestion).toMatchObject({ attempt: 2, executionStatus: 'QUEUED' })
    expect(retryBatchSchemaSuggestion).toHaveBeenLastCalledWith(projectContextId, suggestionId, 1)

    const replayed = await handler(retryRequest({ expectedAttempt: 1 }))
    expect(replayed.status).toBe(202)
    expect((await replayed.json()).batchSchemaSuggestion).toMatchObject({ attempt: 2, executionStatus: 'COMPLETED' })

    const conflict = await handler(retryRequest({ expectedAttempt: 1 }))
    expect(conflict.status).toBe(409)
    expect((await conflict.json()).error.code).toBe('attempt_conflict')

    const running = await handler(retryRequest({ expectedAttempt: 2 }))
    expect(running.status).toBe(409)
    expect((await running.json()).error.code).toBe('operation_not_ready')

    const unavailable = await handler(retryRequest({ expectedAttempt: 2 }))
    expect(unavailable.status).toBe(503)

    for (const body of [{}, { expectedAttempt: 0 }, { expectedAttempt: 1.5 }, { expectedAttempt: 1, extra: true }]) {
      const invalid = await handler(retryRequest(body))
      expect(invalid.status).toBe(422)
    }
    expect(retryBatchSchemaSuggestion).toHaveBeenCalledTimes(5)
  })

  it('returns not found for an inaccessible suggestion\'s retry', async () => {
    const retryBatchSchemaSuggestion = vi.fn(async () => null)
    const response = await handlerFor({ retryBatchSchemaSuggestion })(retryRequest({ expectedAttempt: 1 }))

    expect(response.status).toBe(404)
    expect(retryBatchSchemaSuggestion).toHaveBeenCalledWith(projectContextId, suggestionId, 1)
  })
})

describe('POST /api/batch-schema-suggestions/:id/stop', () => {
  const stopRequest = () => new Request(
    `http://test/api/batch-schema-suggestions/${suggestionId}/stop?projectContextId=${projectContextId}`, { method: 'POST' })
  function stopHandler(states: BatchSchemaSuggestionRecord['executionStatus'][]) {
    const reads = states.map((executionStatus) => ({ ...suggestion, attempt: 2, executionStatus,
      failure: executionStatus === 'FAILED' ? { code: 'interrupted', message: 'Interrupted.' } : null }))
    const getBatchSchemaSuggestion = vi.fn(async () => reads.shift() ?? null)
    const client = { cancelWorkflow: vi.fn<(workflowId: string) => Promise<void>>(async () => {}) }
    const { POST } = createResearcherApiHandlers({ researcherAccountId, getBatchSchemaSuggestion } as unknown as ResearcherProjectStore,
      () => client)
    return { POST, client, getBatchSchemaSuggestion }
  }

  it('cancels the running attempt\'s workflow and answers the suggestion as it now reads', async () => {
    const { POST, client } = stopHandler(['RUNNING', 'FAILED'])
    const response = await POST(stopRequest())
    expect(response.status).toBe(200)
    expect(client.cancelWorkflow).toHaveBeenCalledExactlyOnceWith(`suggest:${suggestionId}:2`)
    expect(await response.json()).toMatchObject({ batchSchemaSuggestion: { executionStatus: 'FAILED' } })
  })

  it('leaves a finished suggestion as it is, and refuses one the account does not own', async () => {
    const finished = stopHandler(['COMPLETED'])
    expect((await finished.POST(stopRequest())).status).toBe(200)
    expect(finished.client.cancelWorkflow).not.toHaveBeenCalled()

    const missing = stopHandler([])
    expect((await missing.POST(stopRequest())).status).toBe(404)
    expect(missing.client.cancelWorkflow).not.toHaveBeenCalled()
  })
})
