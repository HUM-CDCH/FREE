import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import type {
  BatchSchemaSuggestionRecord,
  ResearcherProjectStore,
} from 'db'
import type { ExtractionModule } from 'extraction'
import { createResearcherApiHandlers } from './batch_schema_suggestions.js'

const runtime = vi.hoisted(() => ({
  createResearcherExtractions: vi.fn(),
}))
const operations = vi.hoisted(() => ({ kick: vi.fn() }))

vi.mock('./_extraction_runtime.js', () => ({
  createResearcherExtractions: runtime.createResearcherExtractions,
}))
vi.mock('./_project_operations.js', () => ({
  projectOperations: operations,
}))

const researcherAccountId = '51000000-0000-4000-8009-000000000001'
const projectContextId = '51000000-0000-4000-8000-000000000001'
const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
const representationRevisionId = '51000000-0000-4000-8002-000000000001'
const suggestionId = '51000000-0000-4000-8008-000000000001'
const now = new Date('2026-08-15T10:00:00.000Z')

const suggestion: BatchSchemaSuggestionRecord = {
  batchSchemaSuggestionId: suggestionId,
  projectContextId,
  selectionKey: 'a'.repeat(64),
  executionStatus: 'COMPLETED',
  phase: 'READY',
  sourceKind: 'DOCUMENTS',
  purpose: null,
  columnFieldMapping: null,
  projectSpreadsheetVersionId: null,
  proposal: {
    recordDescription: 'One place.',
    schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
  },
  coverage: [{ nodeId: 'place', present: 1, total: 1 }],
  draft: {
    recordDescription: 'One place.',
    schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
  },
  draftVersion: 1,
  failure: null,
  confirmedSchemaRevisionId: null,
  batchExtractionId: null,
  startedAt: now,
  finishedAt: now,
  leaseOwner: null,
  leaseVersion: 0,
  leaseExpiresAt: null,
  createdAt: now,
  sources: [
    {
      sourceDocumentId,
      sourceRepresentationRevisionId: representationRevisionId,
      descriptor: {
        artifactReference: 'b'.repeat(64),
        artifactSha256: 'b'.repeat(64),
      },
      executionStatus: 'COMPLETED',
      definition: {
        recordDescription: 'One place.',
        schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
      },
      failure: null,
      startedAt: now,
      finishedAt: now,
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
    stabiliseSchemaRevision:
      vi.fn<ExtractionModule['stabiliseSchemaRevision']>(),
    listBatches: vi.fn<ExtractionModule['listBatches']>(),
    readBatch: vi.fn<ExtractionModule['readBatch']>(),
    readBatchResults: vi.fn<ExtractionModule['readBatchResults']>(),
    validateExtraction: vi.fn<ExtractionModule['validateExtraction']>(),
    listEvaluationRuns: vi.fn<ExtractionModule['listEvaluationRuns']>(),
  }
  return module
}
function handlerFor(
  store: Partial<ResearcherProjectStore>,
  module: ExtractionModule,
) {
  runtime.createResearcherExtractions.mockReturnValue(module)
  operations.kick.mockReset()
  return createResearcherApiHandlers({
    researcherAccountId,
    ...store,
  } as ResearcherProjectStore).POST
}

const runRequest = () =>
  new Request(
    `http://test/api/batch-schema-suggestions/${suggestionId}/run?projectContextId=${projectContextId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ strategy: 'ARTICLE' }),
    },
  )

describe('durable operation APIs', () => {
  it('keeps system claim, lease, and reference methods out of request stores', () => {
    expectTypeOf<ResearcherProjectStore>().not.toHaveProperty(
      'claimBatchSchemaSuggestion',
    )
    expectTypeOf<ResearcherProjectStore>().not.toHaveProperty(
      'renewBatchSchemaSuggestionLease',
    )
    expectTypeOf<ResearcherProjectStore>().not.toHaveProperty(
      'isPackageReferenced',
    )
  })

  it('schedules a suggested batch with the selected Catalog strategy', async () => {
    const module = moduleForSuggestedBatch()
    const getBatchSchemaSuggestion = vi.fn(async () => suggestion)
    const handler = handlerFor({ getBatchSchemaSuggestion }, module)
    const request = runRequest()
    const response = await handler(
      new Request(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ strategy: 'CATALOG' }),
      }),
    )

    expect(response.status).toBe(202)
    expect(module.scheduleSuggestedBatch).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'CATALOG' }),
    )
  })

  it('persists a Schema Suggestion before waking its durable worker', async () => {
    const createBatchSchemaSuggestion = vi.fn(async () => ({
      status: 'created' as const,
      suggestion: { ...suggestion, executionStatus: 'QUEUED' as const, phase: 'SOURCES' as const },
    }))
    const handler = handlerFor(
      { createBatchSchemaSuggestion },
      moduleForSuggestedBatch(),
    )
    const response = await handler(
      new Request('http://test/api/batch-schema-suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectContextId, sourceDocumentIds: [sourceDocumentId] }),
      }),
    )

    expect(response.status).toBe(202)
    expect(createBatchSchemaSuggestion).toHaveBeenCalledWith(projectContextId, [sourceDocumentId])
    expect(operations.kick).toHaveBeenCalledOnce()
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
  it('returns not found without retrying or waking for an inaccessible suggestion', async () => {
    const retryBatchSchemaSuggestion = vi.fn(async () => null)
    const handler = handlerFor(
      { retryBatchSchemaSuggestion },
      moduleForSuggestedBatch(),
    )
    const response = await handler(
      new Request(
        `http://test/api/batch-schema-suggestions/${suggestionId}/retry?projectContextId=${projectContextId}`,
        { method: 'POST' },
      ),
    )

    expect(response.status).toBe(404)
    expect(retryBatchSchemaSuggestion).toHaveBeenCalledWith(
      projectContextId,
      suggestionId,
    )
    expect(operations.kick).not.toHaveBeenCalled()
  })

})
