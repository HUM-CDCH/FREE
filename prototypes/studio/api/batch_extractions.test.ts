import { describe, expect, it, vi } from 'vitest'
import type { ResearcherProjectStore } from 'db'
import {
  ExtractionError,
  type BatchExtractionSnapshot,
  type ExtractionModule,
} from 'extraction'
import { createResearcherApiHandlers } from './batch_extractions.js'

const runtime = vi.hoisted(() => ({
  createResearcherExtractions: vi.fn(),
}))

vi.mock('./_extraction_runtime.js', () => ({
  createResearcherExtractions: runtime.createResearcherExtractions,
}))

const modelConfig = vi.hoisted(() => ({ configuredExtractionModels: vi.fn() }))
vi.mock('./_model_config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_model_config.js')>()),
  configuredExtractionModels: modelConfig.configuredExtractionModels,
}))

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const PROJECT = '51000000-0000-4000-8000-000000000001'
const BATCH = '51000000-0000-4000-8007-000000000001'
const REVISION = '51000000-0000-4000-8004-000000000001'
const DOCUMENT = '51000000-0000-4000-8001-000000000001'

const batch: BatchExtractionSnapshot = {
  batchExtractionId: BATCH,
  projectContextId: PROJECT,
  schemaRevisionId: REVISION,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  extractionSchemaName: 'Places',
  schemaRevisionNumber: 4,
  strategy: 'ARTICLE',
  executionStatus: 'QUEUED',
  failureMessage: null,
  startedAt: null,
  finishedAt: null,
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
  members: [
    {
      sourceDocumentId: DOCUMENT,
      sourceRepresentationRevisionId:
        '51000000-0000-4000-8002-000000000001',
      executionStatus: 'QUEUED',
      failureMessage: null,
      startedAt: null,
      finishedAt: null,
      latestExtraction: null,
    },
  ],
}

function extractionModule(overrides: Partial<ExtractionModule> = {}) {
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
    scheduleBatch: vi.fn<ExtractionModule['scheduleBatch']>(async () => ({
      disposition: 'created',
      batch,
    })),
    scheduleSuggestedBatch:
      vi.fn<ExtractionModule['scheduleSuggestedBatch']>(),
    listBatches: vi.fn<ExtractionModule['listBatches']>(async () => [batch]),
    readBatch: vi.fn<ExtractionModule['readBatch']>(async () => batch),
    readBatchResults: vi.fn<ExtractionModule['readBatchResults']>(async () => ({
      batchExtractionId: BATCH,
      executionStatus: 'COMPLETED',
      totalMembers: 1,
      successfulResults: 1,
      pending: 0,
      failed: 0,
      cancelled: 0,
      results: [
        {
          sourceDocumentId: DOCUMENT,
          extractionId: '51000000-0000-4000-8006-000000000001',
          result: { records: [{ title: 'Alpha' }] },
        },
      ],
    })),
    ...overrides,
  }
  return module
}
function handlerFor(module: ExtractionModule, configured: { fields?: string; reasoning?: string } | null = null) {
  runtime.createResearcherExtractions.mockReturnValue(module)
  return createResearcherApiHandlers({
    researcherAccountId: ACCOUNT,
  } as ResearcherProjectStore, { extractionModels: async () => configured }).POST
}

const open = (body: unknown) =>
  new Request('http://test/api/batch-extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const selection = {
  projectContextId: PROJECT,
  schemaRevisionId: REVISION,
  strategy: 'ARTICLE',
  sourceDocumentIds: [DOCUMENT],
}

describe('/api/batch-extractions transport', () => {
  it('schedules reusable and explicit-new selections without client batch IDs', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)

    const reusable = await handle(open(selection))
    expect(reusable.status).toBe(202)
    expect(module.scheduleBatch).toHaveBeenCalledWith({
      ...selection,
      models: null,
      repetition: 'reuse-equal-selection',
    })
    expect(await reusable.json()).toMatchObject({
      disposition: 'created',
      batchExtraction: { batchExtractionId: BATCH },
    })

    await handle(open({ ...selection, force: true }))
    expect(module.scheduleBatch).toHaveBeenLastCalledWith({
      ...selection,
      models: null,
      repetition: 'create-new',
    })

    const catalog = await handle(open({ ...selection, strategy: 'CATALOG' }))
    expect(catalog.status).toBe(202)
    expect(module.scheduleBatch).toHaveBeenLastCalledWith({
      ...selection,
      strategy: 'CATALOG',
      models: null,
      repetition: 'reuse-equal-selection',
    })
  })

  it('schedules every member on the configured Extraction Model Choice', async () => {
    const module = extractionModule()
    const response = await handlerFor(module, { fields: 'instruct' })(open(selection))
    expect(response.status).toBe(202)
    expect(module.scheduleBatch).toHaveBeenCalledWith(expect.objectContaining({ models: { fields: 'instruct' } }))
  })

  it("reads the account's configured Extraction Model Choice by default", async () => {
    const module = extractionModule()
    runtime.createResearcherExtractions.mockReturnValue(module)
    modelConfig.configuredExtractionModels.mockResolvedValueOnce({ reasoning: 'instruct' })
    const post = createResearcherApiHandlers({ researcherAccountId: ACCOUNT } as ResearcherProjectStore).POST

    expect((await post(open(selection))).status).toBe(202)
    expect(modelConfig.configuredExtractionModels).toHaveBeenCalledWith(ACCOUNT)
    expect(module.scheduleBatch).toHaveBeenCalledWith(expect.objectContaining({ models: { reasoning: 'instruct' } }))
  })

  it('lists, reads, and exports through caller-shaped module methods', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)

    const listed = await handle(
      new Request(
        `http://test/api/batch-extractions?projectContextId=${PROJECT}&limit=20`,
      ),
    )
    expect(listed.status).toBe(200)
    expect(module.listBatches).toHaveBeenCalledWith({
      projectContextId: PROJECT,
      limit: 20,
    })

    const read = await handle(
      new Request(
        `http://test/api/batch-extractions/${BATCH}?projectContextId=${PROJECT}`,
      ),
    )
    expect(read.status).toBe(200)
    expect(module.readBatch).toHaveBeenCalledWith({
      projectContextId: PROJECT,
      batchExtractionId: BATCH,
    })
    expect(await read.json()).toEqual({
      batchExtraction: expect.objectContaining({ batchExtractionId: BATCH }),
    })

    const results = await handle(
      new Request(
        `http://test/api/batch-extractions/${BATCH}/results?projectContextId=${PROJECT}`,
      ),
    )
    expect(results.status).toBe(200)
    expect(module.readBatchResults).toHaveBeenCalledWith({
      projectContextId: PROJECT,
      batchExtractionId: BATCH,
    })
    expect(await results.json()).toMatchObject({
      batchExtractionId: BATCH,
      successfulResults: 1,
      results: [{ sourceDocumentId: DOCUMENT }],
    })
  })

  it('maps invalid pins and missing batches to bounded transport errors', async () => {
    const module = extractionModule({
      scheduleBatch: vi.fn(async () => {
        throw new ExtractionError('invalid_extraction_pins', 'Invalid pins.')
      }),
      readBatch: vi.fn(async () => {
        throw new ExtractionError('not_found', 'Missing.')
      }),
    })
    const handle = handlerFor(module)

    const invalid = await handle(open(selection))
    expect(invalid.status).toBe(422)
    expect(await invalid.json()).toMatchObject({
      error: { code: 'invalid_batch_selection' },
    })

    const missing = await handle(
      new Request(
        `http://test/api/batch-extractions/${BATCH}?projectContextId=${PROJECT}`,
      ),
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ error: { code: 'not_found' } })
  })
})
