import { describe, expect, it, vi } from 'vitest'
import type { ResearcherProjectStore } from 'db'
import {
  ExtractionError,
  type BatchExtractionSnapshot,
  type ExtractionModule,
} from 'extraction'
import { createResearcherApiHandlers } from './batch_extractions.js'
import { batchExtractionResponseSchema } from '../shared/batchExtraction.contract.js'

const runtime = vi.hoisted(() => ({
  createResearcherExtractions: vi.fn(),
}))

vi.mock('./_extractions.js', () => ({
  createResearcherExtractions: runtime.createResearcherExtractions,
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
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
  members: [
    {
      sourceDocumentId: DOCUMENT,
      sourceRepresentationRevisionId:
        '51000000-0000-4000-8002-000000000001',
      executionStatus: 'QUEUED',
      failureMessage: null,
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
          result: { records: [{ title: 'Alpha', year: null }] },
          contested: [{ resultPath: ['records', 0, 'year'], candidates: [1901, 1902] }],
        },
      ],
    })),
    ...overrides,
  }
  return module
}
function handlerFor(module: ExtractionModule) {
  runtime.createResearcherExtractions.mockReturnValue(module)
  return createResearcherApiHandlers({ researcherAccountId: ACCOUNT } as ResearcherProjectStore).POST
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
  method: { models: null, settings: { article: null } },
}

describe('/api/batch-extractions transport', () => {
  it('schedules reusable and explicit-new selections without client batch IDs', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)

    const reusable = await handle(open(selection))
    expect(reusable.status).toBe(202)
    expect(module.scheduleBatch).toHaveBeenCalledWith({
      ...selection,
      repetition: 'reuse-equal-selection',
    })
    expect(await reusable.json()).toMatchObject({
      disposition: 'created',
      batchExtraction: { batchExtractionId: BATCH },
    })

    await handle(open({ ...selection, force: true }))
    expect(module.scheduleBatch).toHaveBeenLastCalledWith({
      ...selection,
      repetition: 'create-new',
    })

    const generic = { models: null, settings: { generic: null } }
    const catalog = await handle(open({ ...selection, strategy: 'CATALOG', method: generic }))
    expect(catalog.status).toBe(202)
    expect(module.scheduleBatch).toHaveBeenLastCalledWith({
      ...selection,
      strategy: 'CATALOG',
      method: generic,
      repetition: 'reuse-equal-selection',
    })
  })

  it('hands the submitted method to admission unchanged; the handler never reads the account', async () => {
    const module = extractionModule()
    const article = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
    const method = { models: { fields: 'instruct' }, settings: { article } }
    expect((await handlerFor(module)(open({ ...selection, method }))).status).toBe(202)
    expect(module.scheduleBatch).toHaveBeenCalledWith(expect.objectContaining({ method }))
  })

  it.each([
    ['method_changed', 409],
    ['invalid_identity_fields', 422],
    ['invalid_model_config', 500],
  ] as const)('answers %s with %i', async (code, status) => {
    const module = extractionModule({
      scheduleBatch: vi.fn<ExtractionModule['scheduleBatch']>().mockRejectedValue(new ExtractionError(code, 'Refused for a reason the researcher can read.')),
    })
    const response = await handlerFor(module)(open(selection))
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
  })

  it("refuses a request without the method, with a recipe's settings, or breaking a method rule, before admission", async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const missing: Partial<typeof selection> = { ...selection }
    delete missing.method
    expect((await handle(open(missing))).status).toBe(422)
    // A batch has no recipe, so recipe settings fit neither strategy.
    for (const strategy of ['ARTICLE', 'CATALOG'])
      expect((await handle(open({ ...selection, strategy, method: { models: null, settings: { recipe: null } } }))).status).toBe(422)
    const article = { context: 'full', context_tokens: 12288, overlap_passages: 1, identity: 'reference', identity_fields: [],
      prompt: 'reference', grounding: 'semantic' }
    const broken = await handle(open({ ...selection, method: { models: null, settings: { article } } }))
    expect(broken.status).toBe(422)
    expect((await broken.json()).error.details.issues).toContainEqual({
      path: 'method.settings.article.overlap_passages', message: 'This choice requires bounded source units.',
    })
    expect(module.scheduleBatch).not.toHaveBeenCalled()
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
      results: [{ sourceDocumentId: DOCUMENT, contested: [{ resultPath: ['records', 0, 'year'], candidates: [1901, 1902] }] }],
    })
  })

  it('answers a batch with its derived member status and no job-era fields', async () => {
    const read = batchExtractionResponseSchema.parse(await (await handlerFor(extractionModule({
      readBatch: vi.fn(async () => ({
        ...batch,
        executionStatus: 'COMPLETED' as const,
        members: [
          {
            ...batch.members[0],
            executionStatus: 'FAILED' as const,
            failureMessage: 'This work stopped before it finished. Start it again.',
          },
        ],
      })),
    }))(
      new Request(`http://test/api/batch-extractions/${BATCH}?projectContextId=${PROJECT}`),
    )).json())
    expect(read.batchExtraction).toEqual({
      batchExtractionId: BATCH,
      projectContextId: PROJECT,
      schemaRevisionId: REVISION,
      extractionSchemaId: batch.extractionSchemaId,
      extractionSchemaName: 'Places',
      schemaRevisionNumber: 4,
      strategy: 'ARTICLE',
      executionStatus: 'COMPLETED',
      createdAt: '2026-08-20T10:00:00.000Z',
      members: [
        {
          sourceDocumentId: DOCUMENT,
          sourceRepresentationRevisionId: batch.members[0].sourceRepresentationRevisionId,
          executionStatus: 'FAILED',
          executionFailureMessage: 'This work stopped before it finished. Start it again.',
          latestExtraction: null,
        },
      ],
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
