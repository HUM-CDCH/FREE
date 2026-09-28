import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  BatchSchemaSuggestionRecord,
  ResearcherProjectStore,
} from 'db'
import { ExtractionError, type ExtractionModule } from 'extraction'
import { createResearcherApiHandlers } from './batch_schema_suggestions.js'
import { batchSchemaSuggestionErrorResponseSchema } from '../shared/batchSchemaSuggestion.contract.js'

const runtime = vi.hoisted(() => ({
  createResearcherExtractions: vi.fn(),
}))

vi.mock('./_extractions.js', () => ({
  createResearcherExtractions: runtime.createResearcherExtractions,
}))

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
  proposal: definition,
  coverage: [{ nodeId: 'place', present: 1, total: 1 }],
  draft: definition,
  draftVersion: 1,
  failure: null,
  confirmedSchemaRevisionId: null,
  batchExtractionId: null,
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

function moduleForSuggestedBatch() {
  const module: ExtractionModule = {
    runSingle: vi.fn<ExtractionModule['runSingle']>(),
    readExtractionAttempt: vi.fn<ExtractionModule['readExtractionAttempt']>(),
    cancelSingle: vi.fn<ExtractionModule['cancelSingle']>(),
    prepareReview: vi.fn<ExtractionModule['prepareReview']>(),
    resetReview: vi.fn(async (_id, version) => ({ version: version + 1, decisions: [] })),
    readReviewDraft: vi.fn(async () => ({ version: 0, decisions: [] })),
    saveReviewDraft: vi.fn(async (_id, draft) => ({ ...draft, version: draft.version + 1 })),
    finalizeReview: vi.fn<ExtractionModule['finalizeReview']>(),
    readDocumentExtractions:
      vi.fn<ExtractionModule['readDocumentExtractions']>(),
    scheduleBatch: vi.fn<ExtractionModule['scheduleBatch']>(),
    scheduleSuggestedBatch:
      vi.fn<ExtractionModule['scheduleSuggestedBatch']>(async () => ({
        disposition: 'created',
        batch: {} as never,
      })),
    listBatches: vi.fn<ExtractionModule['listBatches']>(),
    readBatch: vi.fn<ExtractionModule['readBatch']>(),
    readBatchResults: vi.fn<ExtractionModule['readBatchResults']>(),
  }
  return module
}
function handlersFor(
  store: Partial<ResearcherProjectStore>,
  module: ExtractionModule = moduleForSuggestedBatch(),
) {
  runtime.createResearcherExtractions.mockReturnValue(module)
  return createResearcherApiHandlers({
    researcherAccountId,
    ...store,
  } as ResearcherProjectStore)
}
const handlerFor = (store: Partial<ResearcherProjectStore>, module?: ExtractionModule) =>
  handlersFor(store, module).POST

/** What the start view submits for an account that keeps every service default. */
const SERVICE_DEFAULTS = { models: null, settings: { article: null } }
const runRequest = (body: unknown = { strategy: 'ARTICLE', method: SERVICE_DEFAULTS }) =>
  new Request(
    `http://test/api/batch-schema-suggestions/${suggestionId}/run?projectContextId=${projectContextId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
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

  it('schedules a suggested batch with the selected Catalog strategy', async () => {
    const module = moduleForSuggestedBatch()
    const getBatchSchemaSuggestion = vi.fn(async () => suggestion)
    const handler = handlerFor({ getBatchSchemaSuggestion }, module)
    const method = { models: null, settings: { generic: null } }
    const response = await handler(runRequest({ strategy: 'CATALOG', method }))

    expect(response.status).toBe(202)
    expect(module.scheduleSuggestedBatch).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'CATALOG', method }),
    )
  })

  it('hands the submitted method to scheduleSuggestedBatch unchanged; the handler never reads the account', async () => {
    const module = moduleForSuggestedBatch()
    const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    const method = { models: { fields: 'nuextract' }, settings: { article } }
    const handler = handlerFor({ getBatchSchemaSuggestion: vi.fn(async () => suggestion) }, module)

    expect((await handler(runRequest({ strategy: 'ARTICLE', method }))).status).toBe(202)
    expect(module.scheduleSuggestedBatch).toHaveBeenCalledWith(expect.objectContaining({ method }))
  })

  it.each([
    ['method_changed', 409],
    ['invalid_identity_fields', 422],
    ['invalid_model_config', 500],
  ] as const)('answers a refused Run %s with %i', async (code, status) => {
    const module = moduleForSuggestedBatch()
    vi.mocked(module.scheduleSuggestedBatch).mockRejectedValueOnce(new ExtractionError(code, 'Refused for a reason the researcher can read.'))
    const response = await handlerFor({ getBatchSchemaSuggestion: vi.fn(async () => suggestion) }, module)(runRequest())

    expect(response.status).toBe(status)
    // The browser reads the refusal through the exported contract, so it can offer a refresh rather than a failure.
    expect(batchSchemaSuggestionErrorResponseSchema.parse(await response.json()).error.code).toBe(code)
  })

  it("refuses a Run without the method, or with a recipe's settings, before admission", async () => {
    const module = moduleForSuggestedBatch()
    const handler = handlerFor({ getBatchSchemaSuggestion: vi.fn(async () => suggestion) }, module)

    expect((await handler(runRequest({ strategy: 'ARTICLE' }))).status).toBe(422)
    // A batch has no recipe, so recipe settings fit neither strategy.
    for (const strategy of ['ARTICLE', 'CATALOG'])
      expect((await handler(runRequest({ strategy, method: { models: null, settings: { recipe: null } } }))).status).toBe(422)
    expect(module.scheduleSuggestedBatch).not.toHaveBeenCalled()
  })

  it('refuses a rule-breaking Run field by field, in a body the exported error contract reads', async () => {
    const module = moduleForSuggestedBatch()
    const article = { context: 'full', context_tokens: 12288, overlap_passages: 1, identity: 'reference', identity_fields: [],
      prompt: 'reference', grounding: 'semantic' }
    const response = await handlerFor({ getBatchSchemaSuggestion: vi.fn(async () => suggestion) }, module)(
      runRequest({ strategy: 'ARTICLE', method: { models: null, settings: { article } } }))

    expect(response.status).toBe(422)
    const { error } = batchSchemaSuggestionErrorResponseSchema.parse(await response.json())
    expect(error.code).toBe('invalid_request')
    expect(error.details?.issues).toContainEqual({
      path: 'method.settings.article.overlap_passages', message: 'This choice requires bounded source units.',
    })
    expect(module.scheduleSuggestedBatch).not.toHaveBeenCalled()
  })

  it('creation answers 202 with the admitted attempt', async () => {
    const createBatchSchemaSuggestion = vi.fn(async () => ({
      status: 'created' as const,
      suggestion: { ...suggestion, executionStatus: 'QUEUED' as const, phase: null, proposal: null, coverage: null, draft: null, draftVersion: 0 },
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
        proposal: null,
        coverage: null,
        draft: null,
        draftVersion: 0,
        failure: null,
        confirmedSchemaRevisionId: null,
        batchExtractionId: null,
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
    const module = moduleForSuggestedBatch()
    const store = {
      listBatchSchemaSuggestions: vi.fn(async () => [suggestion]),
      getBatchSchemaSuggestion: vi.fn(async () => suggestion),
      createBatchSchemaSuggestion: vi.fn(),
      retryBatchSchemaSuggestion: vi.fn(),
    }
    const { GET } = handlersFor(store, module)

    const listed = await GET(new Request(`http://test/api/batch-schema-suggestions?projectContextId=${projectContextId}`))
    const read = await GET(new Request(`http://test/api/batch-schema-suggestions/${suggestionId}?projectContextId=${projectContextId}`))

    expect(listed.status).toBe(200)
    expect(read.status).toBe(200)
    expect((await listed.json()).batchSchemaSuggestions).toHaveLength(1)
    expect(store.createBatchSchemaSuggestion).not.toHaveBeenCalled()
    expect(store.retryBatchSchemaSuggestion).not.toHaveBeenCalled()
    expect(module.scheduleSuggestedBatch).not.toHaveBeenCalled()
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
      draft: definition,
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

  it('hands a ready suggestion atomically to ExtractionModule before rereading it', async () => {
    const order: string[] = []
    const module = moduleForSuggestedBatch()
    vi.mocked(module.scheduleSuggestedBatch).mockImplementationOnce(async (input) => {
      order.push('schedule')
      expect(input).toEqual({
        projectContextId,
        batchSchemaSuggestionId: suggestionId,
        strategy: 'ARTICLE',
        method: SERVICE_DEFAULTS,
      })
      return { disposition: 'created', batch: {} as never }
    })
    const getBatchSchemaSuggestion = vi.fn(async () => {
      order.push('read')
      return {
        ...suggestion,
        confirmedSchemaRevisionId: '51000000-0000-4000-8004-000000000001',
        batchExtractionId: '51000000-0000-4000-8007-000000000001',
      }
    })
    const handler = handlerFor({ getBatchSchemaSuggestion }, module)

    const response = await handler(runRequest())
    expect(response.status).toBe(202)
    expect(order).toEqual(['schedule', 'read'])
    expect(await response.json()).toMatchObject({
      batchSchemaSuggestion: {
        confirmedSchemaRevisionId: '51000000-0000-4000-8004-000000000001',
        batchExtractionId: '51000000-0000-4000-8007-000000000001',
      },
    })
  })

  it('returns not found for an inaccessible suggestion\'s retry', async () => {
    const retryBatchSchemaSuggestion = vi.fn(async () => null)
    const response = await handlerFor({ retryBatchSchemaSuggestion })(retryRequest({ expectedAttempt: 1 }))

    expect(response.status).toBe(404)
    expect(retryBatchSchemaSuggestion).toHaveBeenCalledWith(projectContextId, suggestionId, 1)
  })
})
