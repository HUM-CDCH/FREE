import { describe, expect, it, vi } from 'vitest'
import type { ResearcherProjectStore } from 'db'
import {
  ExtractionError,
  type ExtractionAttemptSnapshot,
  type ExtractionModule,
} from 'extraction'
import { createResearcherApiHandlers } from './extractions.js'
import type * as ExtractionsModule from './_extractions.js'
import { extractionAttemptSchema, extractionReadResponseSchema } from '../shared/extraction.contract.js'

const runtime = vi.hoisted(() => ({
  createResearcherExtractions: vi.fn(),
}))

vi.mock('./_extractions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExtractionsModule>()
  return { ...actual, createResearcherExtractions: runtime.createResearcherExtractions }
})

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const EXTRACTION = '51000000-0000-4000-8006-000000000001'
const DOCUMENT = '51000000-0000-4000-8001-000000000001'
const REPRESENTATION = '51000000-0000-4000-8002-000000000001'
const REVISION = '51000000-0000-4000-8004-000000000001'

const attemptSnapshot: ExtractionAttemptSnapshot = {
  extractionId: EXTRACTION,
  sourceDocumentId: DOCUMENT,
  sourceRepresentationRevisionId: REPRESENTATION,
  sourceRepresentationRevisionNumber: 2,
  preprocessId: 'kei-exp:run-1:g1',
  schemaRevisionId: REVISION,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  schemaRevisionNumber: 4,
  strategy: 'ARTICLE',
  catalogRecipe: null,
  requestedModels: null,
  requestedSettings: { article: null },
  executionStatus: 'QUEUED',
  finalizedReview: null,
  batchExtractionId: null,
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
}

function extractionModule(overrides: Partial<ExtractionModule> = {}) {
  const module: ExtractionModule = {
    runSingle: vi.fn<ExtractionModule['runSingle']>(async () => ({
      disposition: 'created',
      extraction: attemptSnapshot,
    })),
    readExtractionAttempt: vi.fn<ExtractionModule['readExtractionAttempt']>(
      async () => attemptSnapshot,
    ),
    readDocumentExtractions:
      vi.fn<ExtractionModule['readDocumentExtractions']>(),
    scheduleBatch: vi.fn<ExtractionModule['scheduleBatch']>(),
    scheduleSuggestedBatch:
      vi.fn<ExtractionModule['scheduleSuggestedBatch']>(),
    stabiliseSchemaRevision:
      vi.fn<ExtractionModule['stabiliseSchemaRevision']>(),
    listBatches: vi.fn<ExtractionModule['listBatches']>(),
    readBatch: vi.fn<ExtractionModule['readBatch']>(),
    ...overrides,
  }
  return module
}
function handlerFor(module: ExtractionModule) {
  runtime.createResearcherExtractions.mockReturnValue(module)
  return createResearcherApiHandlers({ researcherAccountId: ACCOUNT } as ResearcherProjectStore).POST
}

const request = (body: unknown) =>
  new Request('http://test/api/extractions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const fresh = {
  id: EXTRACTION,
  sourceRepresentationRevisionId: REPRESENTATION,
  schemaRevisionId: REVISION,
  strategy: 'ARTICLE',
  method: { models: null, settings: { article: null } },
}

describe('/api/extractions transport', () => {


  it('maps a fresh request to runSingle and preserves created/replayed status', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)

    const created = await handle(request(fresh))
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    expect(module.runSingle).toHaveBeenCalledWith(
      {
        kind: 'fresh',
        extractionId: EXTRACTION,
        sourceRepresentationRevisionId: REPRESENTATION,
        schemaRevisionId: REVISION,
        strategy: 'ARTICLE',
        method: { models: null, settings: { article: null } },
        startPage: null,
      },
    )
    expect(extractionAttemptSchema.parse(await created.json())).toMatchObject({
      extractionId: EXTRACTION, executionStatus: 'QUEUED', finalizedReview: null,
    })

    vi.mocked(module.runSingle).mockResolvedValueOnce({
      disposition: 'replayed',
      extraction: attemptSnapshot,
    })
    expect((await handle(request(fresh))).status).toBe(200)
  })

  it('answers 503 when admission or a status read cannot reach its store or DBOS', async () => {
    const outage = new Error('connect ECONNREFUSED 127.0.0.1:5432')
    const module = extractionModule({
      runSingle: vi.fn<ExtractionModule['runSingle']>(async () => { throw outage }),
      readExtractionAttempt: vi.fn<ExtractionModule['readExtractionAttempt']>(async () => { throw outage }),
    })
    const handle = handlerFor(module)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const response of [
      await handle(request(fresh)),
      await handle(new Request(`http://test/api/extractions/${EXTRACTION}`)),
    ]) {
      expect(response.status).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      expect(await response.json()).toEqual({
        error: { code: 'persistence_unavailable', message: 'Project Context storage is unavailable.' },
      })
    }
    vi.mocked(console.error).mockRestore()
  })

  it('hands the submitted method to admission unchanged; the handler never reads the account', async () => {
    const module = extractionModule()
    const method = { models: { fields: 'instruct' }, settings: { article: null } }
    expect((await handlerFor(module)(request({ ...fresh, method }))).status).toBe(201)
    expect(module.runSingle).toHaveBeenCalledWith(expect.objectContaining({ method }))
  })

  it.each([
    ['method_changed', 409],
    ['catalog_migration_required', 409],
    ['record_scope_required', 409],
    ['record_scope_mismatch', 409],
    ['invalid_identity_fields', 422],
    ['invalid_schema_revision', 422],
    ['incompatible_extraction_model', 422],
    ['invalid_model_config', 500],
  ] as const)('answers %s with %i', async (code, status) => {
    const module = extractionModule({
      runSingle: vi.fn<ExtractionModule['runSingle']>().mockRejectedValue(new ExtractionError(code, 'Refused for a reason the researcher can read.')),
    })
    const response = await handlerFor(module)(request(fresh))
    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ error: { code } })
  })

  it('refuses an incompatible method field by field, before admission', async () => {
    const module = extractionModule()
    const article = { context: 'full', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
      prompt: 'reference', grounding: 'semantic', grounding_schedule: 'unresolved', grounding_routing: 'origin_lexical' }
    const response = await handlerFor(module)(request({ ...fresh, method: { models: null, settings: { article } } }))
    expect(response.status).toBe(422)
    expect((await response.json()).error.details.issues).toContainEqual({
      path: 'method.settings.article.grounding_routing', message: 'Use generated quotes or source spans, and stop after support.',
    })
    expect(module.runSingle).not.toHaveBeenCalled()
  })

  it('hands a unified Catalog method to admission; a recipe never travels with it', async () => {
    const module = extractionModule()
    const method = { models: null, settings: { unified: { defaults: 1, overlap: 0 } } }
    const catalog = { ...fresh, strategy: 'CATALOG', method }
    expect((await handlerFor(module)(request(catalog))).status).toBe(201)
    expect(module.runSingle).toHaveBeenCalledWith(expect.objectContaining({ method }))
    expect((await handlerFor(module)(request({ ...catalog, catalogRecipe: 'numbered-catalogue-de@1' }))).status).toBe(422)
  })

  it("refuses a request without the method, or with another strategy's settings, before admission", async () => {
    const module = extractionModule()
    const missing: Partial<typeof fresh> = { ...fresh }
    delete missing.method
    expect((await handlerFor(module)(request(missing))).status).toBe(422)
    expect((await handlerFor(module)(request({ ...fresh, method: { models: null, settings: { generic: null } } }))).status).toBe(422)
    expect(module.runSingle).not.toHaveBeenCalled()
  })

  it('passes the Catalog recipe chosen for an Extraction to runSingle', async () => {
    const module = extractionModule()
    await handlerFor(module)(request({
      ...fresh, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1', method: { models: null, settings: { recipe: null } },
    }))
    expect(module.runSingle).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'fresh', strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1',
      method: { models: null, settings: { recipe: null } },
    }))
  })

  it('runs a fresh Extraction on the submitted Extraction Model Choice and echoes the admitted choice', async () => {
    const models = { fields: 'nuextract', reasoning: 'instruct' }
    const module = extractionModule({
      runSingle: vi.fn<ExtractionModule['runSingle']>(async () => ({
        disposition: 'created',
        extraction: { ...attemptSnapshot, requestedModels: models },
      })),
    })
    const method = { models, settings: { article: null } }
    const response = await handlerFor(module)(request({ ...fresh, method }))
    expect(response.status).toBe(201)
    expect(module.runSingle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fresh', method }))
    const body = extractionAttemptSchema.parse(await response.json())
    expect(body.requestedModels).toEqual(models)
  })

  it('refuses a model choice outside the method before the module runs', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    for (const body of [{ ...fresh, models: { fields: 'instruct' } }, { ...fresh, models: {} }, { ...fresh, model: 'instruct' }])
      expect((await handle(request(body))).status).toBe(422)
    expect(module.runSingle).not.toHaveBeenCalled()
  })


  it('refuses a targeted retry body from a stale page before scheduling anything', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const response = await handle(
      request({
        id: EXTRACTION,
        retryOfId: '51000000-0000-4000-8006-000000000099',
        retryDocument: false,
        rediscover: true,
        retryRecordStartBlockIds: ['heading-a'],
      }),
    )

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
    expect(module.runSingle).not.toHaveBeenCalled()
  })


  it('passes the page the researcher was reading to admission, null when the request names none, and refuses a bad one', async () => {
    const module = extractionModule()
    const handler = handlerFor(module)
    expect((await handler(request({ ...fresh, startPage: 6 }))).status).toBeLessThan(300)
    expect(module.runSingle).toHaveBeenLastCalledWith(expect.objectContaining({ startPage: 6 }))
    expect((await handler(request(fresh))).status).toBeLessThan(300)
    expect(module.runSingle).toHaveBeenLastCalledWith(expect.objectContaining({ startPage: null }))
    for (const startPage of [0, 1.5, '6', -1])
      expect((await handler(request({ ...fresh, startPage }))).status).toBe(422)
    expect(module.runSingle).toHaveBeenCalledTimes(2)
  })



  it('refuses a run that still names sample pages', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const refused = await handle(request({ ...fresh, pages: [1] }))
    expect(refused.status).toBe(422)
    await expect(refused.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(module.runSingle).not.toHaveBeenCalled()
  })




  it('maps conflicts and an unavailable pinned source to their own answers', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    vi.mocked(module.runSingle).mockRejectedValueOnce(
      new ExtractionError('extraction_id_conflict', 'That Extraction ID is already bound.'),
    )
    const conflict = await handle(request(fresh))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({ error: { code: 'extraction_id_conflict', message: 'That Extraction ID is already bound.' } })
    vi.mocked(module.runSingle).mockRejectedValueOnce(
      new ExtractionError('source_representation_superseded', 'This document has been reprocessed. No new Extraction was started.'),
    )
    const superseded = await handle(request(fresh))
    expect(superseded.status).toBe(409)
    vi.mocked(module.runSingle).mockRejectedValueOnce(new ExtractionError('invalid_source_representation', 'Unavailable.'))
    const unavailable = await handle(request(fresh))
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({
      error: { code: 'source_artifact_unavailable', message: 'The pinned Source Representation is unavailable.' },
    })
  })

  it('admits a new durable Extraction and returns its saved identity', async () => {
    const module = extractionModule()
    const response = await handlerFor(module)(request(fresh))
    expect(response.status).toBe(201)
    expect(await response.json()).toMatchObject({ extractionId: fresh.id, executionStatus: 'QUEUED' })
    expect(module.runSingle).toHaveBeenCalledOnce()
  })

  it('reads one durable Extraction, and answers a missing or another researcher\'s one as not found', async () => {
    const module = extractionModule()
    runtime.createResearcherExtractions.mockReturnValue(module)
    const handlers = createResearcherApiHandlers({ researcherAccountId: ACCOUNT } as ResearcherProjectStore)
    const read = await handlers.GET(new Request(`http://test/api/extractions/${EXTRACTION}`))
    expect(read.status).toBe(200)
    expect(extractionReadResponseSchema.parse(await read.json())).toEqual({
      extraction: expect.objectContaining({ extractionId: EXTRACTION, executionStatus: 'QUEUED' }),
    })
    vi.mocked(module.readExtractionAttempt).mockResolvedValueOnce(null)
    expect((await handlers.GET(new Request(`http://test/api/extractions/${EXTRACTION}`))).status).toBe(404)
  })

  it('has no review, draft, reset or cancellation route: durable review and Stop live under /durable', async () => {
    const handlers = handlerFor(extractionModule())
    for (const path of ['review', 'review/draft', 'review/reset'])
      expect((await handlers(new Request(`http://test/api/extractions/${EXTRACTION}/${path}`, { method: 'POST', body: '{}' }))).status).toBe(404)
    const all = createResearcherApiHandlers({ researcherAccountId: ACCOUNT } as ResearcherProjectStore)
    expect('DELETE' in all).toBe(false)
  })
})
