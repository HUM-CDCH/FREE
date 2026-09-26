import { describe, expect, it, vi } from 'vitest'
import type { ResearcherProjectStore } from 'db'
import {
  ExtractionError,
  type ExtractionModule,
  type ExtractionSnapshot,
} from 'extraction'
import { createResearcherApiHandlers } from './extractions.js'
import type * as ExtractionRuntimeModule from './_extraction_runtime.js'
import { extractionAttemptSchema, extractionReadResponseSchema, type ExtractionModelChoice } from '../shared/extraction.contract.js'

const runtime = vi.hoisted(() => ({
  createResearcherExtractions: vi.fn(),
}))

vi.mock('./_extraction_runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ExtractionRuntimeModule>()
  return {
    ...actual,
    createResearcherExtractions: runtime.createResearcherExtractions,
  }
})

const modelConfig = vi.hoisted(() => ({ configuredExtractionModels: vi.fn() }))
vi.mock('./_model_config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./_model_config.js')>()),
  configuredExtractionModels: modelConfig.configuredExtractionModels,
}))

const ACCOUNT = '51000000-0000-4000-8009-000000000001'
const EXTRACTION = '51000000-0000-4000-8006-000000000001'
const DOCUMENT = '51000000-0000-4000-8001-000000000001'
const REPRESENTATION = '51000000-0000-4000-8002-000000000001'
const REVISION = '51000000-0000-4000-8004-000000000001'

const snapshot: ExtractionSnapshot = {
  extractionId: EXTRACTION,
  sourceDocumentId: DOCUMENT,
  sourceRepresentationRevisionId: REPRESENTATION,
  sourceRepresentationRevisionNumber: 2,
  schemaRevisionId: REVISION,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  schemaRevisionNumber: 4,
  strategy: 'ARTICLE',
  outcome: 'SUCCEEDED',
  complete: true,
  modelAttribution: { provider: 'openai', modelId: 'fixture' },
  diagnostics: {
    phase: 'persisting',
    durationMs: 12,
    modelCalls: 1,
    finishReason: 'stop',
    inputTokens: 10,
    outputTokens: 4,
    ungroundedPaths: [],
    groundingIssues: [],
    groundingBatches: [
      {
        resultPath: ['records', 0],
        candidateCount: 1,
        fallback: true,
        outcome: 'succeeded',
        finishReason: 'stop',
        inputTokens: 3,
        outputTokens: 1,
        durationMs: 4,
      },
    ],
    unverifiedFields: [],
    catalog: null,
  },
  result: { records: [{ title: 'Alpha' }] },
  evidence: [
    { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-alpha' },
  ],
  failure: null,
  reviewable: true,
  batchExtractionId: null,
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
  reviewedAt: null,
  reviewDecisions: [],
}
const attemptSnapshot = { ...snapshot, executionStatus: 'COMPLETED' as const }

function extractionModule(overrides: Partial<ExtractionModule> = {}) {
  const module: ExtractionModule = {
    runSingle: vi.fn<ExtractionModule['runSingle']>(async () => ({
      disposition: 'created',
      extraction: attemptSnapshot,
    })),
    readExtractionAttempt: vi.fn<ExtractionModule['readExtractionAttempt']>(
      async () => attemptSnapshot,
    ),
    cancelSingle: vi.fn<ExtractionModule['cancelSingle']>(
      async () => 'cancellation-requested',
    ),
    prepareReview: vi.fn<ExtractionModule['prepareReview']>(async () => ({
      extraction: snapshot,
      reviewDecisions: [
        {
          resultPath: ['records', 0, 'title'],
          evidenceAnchorId: 'anchor-alpha',
          reviewedOccurrenceIds: ['occurrence-alpha'],
          action: 'APPROVED',
          reviewedValue: null,
        },
      ],
    })),
    resetReview: vi.fn(async (_id, version) => ({ version: version + 1, decisions: [] })),
    readReviewDraft: vi.fn(async () => ({ version: 0, decisions: [] })),
    saveReviewDraft: vi.fn(async (_id, draft) => ({ ...draft, version: draft.version + 1 })),
    finalizeReview: vi.fn<ExtractionModule['finalizeReview']>(async () => ({
      disposition: 'reviewed',
      extraction: {
        ...snapshot,
        reviewedAt: new Date('2026-08-20T10:01:00.000Z'),
        reviewDecisions: [
          {
            resultPath: ['records', 0, 'title'],
            evidenceAnchorId: 'anchor-alpha',
            reviewedOccurrenceIds: ['occurrence-alpha'],
            action: 'APPROVED',
            reviewedValue: null,
            createdAt: new Date('2026-08-20T10:01:00.000Z'),
          },
        ],
      },
    })),
    readDocumentExtractions:
      vi.fn<ExtractionModule['readDocumentExtractions']>(),
    scheduleBatch: vi.fn<ExtractionModule['scheduleBatch']>(),
    scheduleSuggestedBatch:
      vi.fn<ExtractionModule['scheduleSuggestedBatch']>(),
    listBatches: vi.fn<ExtractionModule['listBatches']>(),
    readBatch: vi.fn<ExtractionModule['readBatch']>(),
    readBatchResults: vi.fn<ExtractionModule['readBatchResults']>(),
    ...overrides,
  }
  return module
}
function handlerFor(module: ExtractionModule, configured: ExtractionModelChoice | null = null) {
  runtime.createResearcherExtractions.mockReturnValue(module)
  return createResearcherApiHandlers({
    researcherAccountId: ACCOUNT,
  } as ResearcherProjectStore, { extractionModels: async () => configured }).POST
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
}

describe('/api/extractions transport', () => {
  it('routes versioned resets and rejects malformed versions', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const post = (body: unknown) => handle(new Request(`http://test/api/extractions/${EXTRACTION}/review/reset`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const response = await post({ expectedDraftVersion: 2 })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ version: 3, decisions: [] })
    expect(module.resetReview).toHaveBeenCalledWith(EXTRACTION, 2)
    for (const body of [{}, { expectedDraftVersion: -1 }, { expectedDraftVersion: 1.5 }])
      expect((await post(body)).status).toBe(422)
    expect(module.resetReview).toHaveBeenCalledTimes(1)
  })
  it('routes versioned draft writes and rejects malformed drafts before the module', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const post = (body: unknown) => handle(new Request(`http://test/api/extractions/${EXTRACTION}/review/draft`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))
    const response = await post({ version: 2, decisions: [] })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(module.saveReviewDraft).toHaveBeenCalledWith(EXTRACTION, { version: 2, decisions: [] })
    expect(await response.json()).toEqual({ version: 3, decisions: [] })
    expect((await post({ version: -1, decisions: [] })).status).toBe(422)
    expect(module.saveReviewDraft).toHaveBeenCalledTimes(1)
  })

  it('maps a fresh request to runSingle and preserves created/replayed status', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)

    const created = await handle(request(fresh))
    expect(created.status).toBe(201)
    expect(created.headers.get('cache-control')).toBe('no-store')
    await expect(created.clone().json()).resolves.toMatchObject({
      diagnostics: {
        phase: 'persisting',
        grounding: {
          batches: [
            expect.objectContaining({
              resultPath: ['records', 0],
              candidateCount: 1,
            }),
          ],
        },
      },
    })
    expect(module.runSingle).toHaveBeenCalledWith(
      {
        kind: 'fresh',
        extractionId: EXTRACTION,
        sourceRepresentationRevisionId: REPRESENTATION,
        schemaRevisionId: REVISION,
        strategy: 'ARTICLE',
      },
      expect.any(AbortSignal),
    )
    expect(await created.json()).toMatchObject({
      extractionId: EXTRACTION,
      resultPayload: snapshot.result,
      evidenceLinks: snapshot.evidence,
    })

    vi.mocked(module.runSingle).mockResolvedValueOnce({
      disposition: 'replayed',
      extraction: attemptSnapshot,
    })
    expect((await handle(request(fresh))).status).toBe(200)
  })

  it("reads the account's configured Extraction Model Choice by default", async () => {
    const module = extractionModule()
    runtime.createResearcherExtractions.mockReturnValue(module)
    modelConfig.configuredExtractionModels.mockResolvedValueOnce({ fields: 'nuextract' })
    const post = createResearcherApiHandlers({ researcherAccountId: ACCOUNT } as ResearcherProjectStore).POST

    expect((await post(request(fresh))).status).toBe(201)
    expect(modelConfig.configuredExtractionModels).toHaveBeenCalledWith(ACCOUNT)
    expect(module.runSingle).toHaveBeenCalledWith(
      expect.objectContaining({ models: { fields: 'nuextract' } }),
      expect.any(AbortSignal),
    )
  })

  it('passes the Catalog recipe chosen for an Extraction to runSingle', async () => {
    const module = extractionModule()
    await handlerFor(module)(request({ ...fresh, strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1' }))
    expect(module.runSingle).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'fresh', strategy: 'CATALOG', catalogRecipe: 'numbered-catalogue-de@1',
    }), expect.any(AbortSignal))
  })

  it('runs a fresh Extraction on the configured Extraction Model Choice and echoes it beside the models each role ran on', async () => {
    const models = { fields: 'nuextract', reasoning: 'instruct' }
    const used = { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' }
    const module = extractionModule({
      runSingle: vi.fn<ExtractionModule['runSingle']>(async () => ({
        disposition: 'created',
        extraction: {
          ...attemptSnapshot,
          requestedModels: models,
          modelAttribution: { provider: 'kei-exp', modelId: used.fields },
          diagnostics: { ...snapshot.diagnostics, models: used },
        },
      })),
    })
    const response = await handlerFor(module, models)(request(fresh))
    expect(response.status).toBe(201)
    expect(module.runSingle).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fresh', models }), expect.any(AbortSignal))
    const body = extractionAttemptSchema.parse(await response.json())
    expect(body.requestedModels).toEqual(models)
    expect(body.diagnostics?.models).toEqual(used)
    expect(body.modelAttribution).toEqual({ provider: 'kei-exp', modelId: used.fields })
  })

  it('refuses a client-sent model choice before the module runs: the configuration owns it', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    for (const body of [{ ...fresh, models: { fields: 'instruct' } }, { ...fresh, models: {} }, { ...fresh, model: 'instruct' }])
      expect((await handle(request(body))).status).toBe(422)
    expect(module.runSingle).not.toHaveBeenCalled()
  })

  it('omits backend-only Catalog document values from strict API JSON', async () => {
    const documentStage = {
      stage: 'document-values' as const,
      provenance: 'reused' as const,
      outcome: 'succeeded' as const,
      finishReason: 'stop',
      calls: 0,
      inputTokens: null,
      outputTokens: null,
      durationMs: 0,
      failureCode: null,
    }
    const catalogSnapshot: ExtractionSnapshot = {
      ...snapshot,
      strategy: 'CATALOG',
      diagnostics: {
        ...snapshot.diagnostics,
        catalog: {
          stages: [documentStage],
          records: [],
          documentValues: { archive: 'internal-only' },
        },
      },
    }
    const module = extractionModule({
      runSingle: vi.fn<ExtractionModule['runSingle']>(async () => ({
        disposition: 'created',
        extraction: { ...catalogSnapshot, executionStatus: 'COMPLETED' },
      })),
    })
    const response = await handlerFor(module)(
      request({ ...fresh, strategy: 'CATALOG' }),
    )
    const body = extractionAttemptSchema.parse(await response.json())

    expect(response.status).toBe(201)
    expect(body.diagnostics!.catalog).toEqual({
      stages: [documentStage],
      records: [],
    })
    expect(body.diagnostics!.catalog).not.toHaveProperty('documentValues')
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

  it('reads canonical review preparation and finalizes submitted decisions', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const read = await handle(
      new Request(`http://test/api/extractions/${EXTRACTION}`),
    )
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      pendingReviewDecisions: [
        {
          resultPath: ['records', 0, 'title'],
          evidenceAnchorId: 'anchor-alpha',
          reviewedOccurrenceIds: ['occurrence-alpha'],
          action: 'APPROVED',
          reviewedValue: null,
        },
      ],
    })

    const decisions = [
      {
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-alpha',
        reviewedOccurrenceIds: ['occurrence-alpha'],
        action: 'APPROVED',
        reviewedValue: null,
      },
    ]
    const reviewed = await handle(
      new Request(`http://test/api/extractions/${EXTRACTION}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reviewDecisions: decisions }),
      }),
    )
    expect(reviewed.status).toBe(200)
    expect(module.finalizeReview).toHaveBeenCalledWith(EXTRACTION, decisions, 0)
    expect(await reviewed.json()).toMatchObject({
      reviewedAt: '2026-08-20T10:01:00.000Z',
    })
  })

  it('reads a running or failed job without values or review authority', async () => {
    const running = {
      ...attemptSnapshot,
      executionStatus: 'RUNNING' as const,
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
      result: null,
      evidence: null,
      failure: null,
      reviewable: false,
      reviewedAt: null,
      reviewDecisions: [],
    }
    const runningModule = extractionModule({
      readExtractionAttempt: vi.fn(async () => running),
    })
    const runningResponse = await handlerFor(runningModule)(
      new Request(`http://test/api/extractions/${EXTRACTION}`),
    )

    expect(runningResponse.status).toBe(200)
    expect(await runningResponse.json()).toMatchObject({
      extraction: {
        executionStatus: 'RUNNING',
        outcome: null,
        resultPayload: null,
        evidenceLinks: null,
        reviewable: false,
      },
      pendingReviewDecisions: null,
    })
    expect(runningModule.prepareReview).not.toHaveBeenCalled()
    expect(runningModule.readReviewDraft).not.toHaveBeenCalled()

    // Legacy-row fixture: a FAILED job carries the same null checkpoint values, plus a failure the reader
    // passes through unfiltered (`postgres-persistence.ts`'s non-completed branch).
    const failure = { code: 'legacy_failure', message: 'Legacy job failure.', phase: 'grounding' as const }
    const failed = {
      ...running,
      executionStatus: 'FAILED' as const,
      failure,
    }
    const failedModule = extractionModule({
      readExtractionAttempt: vi.fn(async () => failed),
    })
    const failedResponse = await handlerFor(failedModule)(
      new Request(`http://test/api/extractions/${EXTRACTION}`),
    )

    expect(failedResponse.status).toBe(200)
    // The strict contract: extractionReadResponseSchema is what `read()` itself parses before responding.
    const failedBody = extractionReadResponseSchema.parse(await failedResponse.json())
    expect(failedBody).toMatchObject({
      extraction: {
        executionStatus: 'FAILED',
        outcome: null,
        resultPayload: null,
        evidenceLinks: null,
        reviewable: false,
        failure: { code: failure.code, message: failure.message },
      },
      pendingReviewDecisions: null,
    })
    expect(failedModule.prepareReview).not.toHaveBeenCalled()
    expect(failedModule.readReviewDraft).not.toHaveBeenCalled()
  })

  it('reads a completed job whose stored diagnostics still hold the legacy retry key', async () => {
    // Legacy-row fixture: Task 7 removed `diagnostics.retry` from the ExtractionDiagnostics type, but a
    // COMPLETED row written before it can still hold `"retry": null` in its stored diagnostics JSON. Cast
    // to simulate that stored shape without widening ExtractionDiagnostics itself.
    const legacyDiagnostics = {
      ...attemptSnapshot.diagnostics,
      retry: null,
    } as unknown as typeof attemptSnapshot.diagnostics
    const legacyCompleted = { ...attemptSnapshot, diagnostics: legacyDiagnostics }
    const module = extractionModule({
      readExtractionAttempt: vi.fn(async () => legacyCompleted),
    })
    const response = await handlerFor(module)(
      new Request(`http://test/api/extractions/${EXTRACTION}`),
    )

    expect(response.status).toBe(200)
    const body = extractionReadResponseSchema.parse(await response.json())
    expect(body.extraction.diagnostics).not.toHaveProperty('retry')
    expect(body.extraction.resultPayload).toEqual(attemptSnapshot.result)
    expect(body.pendingReviewDecisions).toEqual([
      {
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-alpha',
        reviewedOccurrenceIds: ['occurrence-alpha'],
        action: 'APPROVED',
        reviewedValue: null,
      },
    ])
  })

  it('uses bounded cancellation and domain-error HTTP mappings', async () => {
    const module = extractionModule()
    const handle = handlerFor(module)
    const cancelled = await handle(
      new Request(`http://test/api/extractions/${EXTRACTION}`, {
        method: 'DELETE',
      }),
    )
    expect(cancelled.status).toBe(202)
    expect(await cancelled.json()).toEqual({ extractionId: EXTRACTION })

    vi.mocked(module.runSingle).mockRejectedValueOnce(
      new ExtractionError(
        'extraction_id_conflict',
        'That Extraction ID is already bound.',
      ),
    )
    const conflict = await handle(request(fresh))
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: {
        code: 'extraction_id_conflict',
        message: 'That Extraction ID is already bound.',
      },
    })

    vi.mocked(module.runSingle).mockRejectedValueOnce(
      new ExtractionError(
        'source_representation_superseded',
        'This document has been reprocessed. No new Extraction was started.',
      ),
    )
    const superseded = await handle(request(fresh))
    expect(superseded.status).toBe(409)
    expect(await superseded.json()).toEqual({
      error: {
        code: 'source_representation_superseded',
        message: 'This document has been reprocessed. No new Extraction was started.',
      },
    })

    vi.mocked(module.prepareReview).mockRejectedValueOnce(
      new ExtractionError('invalid_source_representation', 'Unavailable.'),
    )
    const unavailable = await handle(
      new Request(`http://test/api/extractions/${EXTRACTION}`),
    )
    expect(unavailable.status).toBe(503)
    expect(await unavailable.json()).toEqual({
      error: {
        code: 'source_artifact_unavailable',
        message: 'The pinned Source Representation is unavailable.',
      },
    })
  })
})

it('transports the version 2 review material instead of stripping it', async () => {
  const { extractionAttemptDto } = await import('./_extraction_runtime.js')
  const grounded = {
    recipe: 'numbered-catalogue-de@1', segmentationFingerprint: 'f',
    budget: { inputTokens: 4096, outputTokens: 1024, tokenizer: { source: 'vllm:/tokenize' } },
    segmentationDiagnostics: [],
    normalization: { version: 1, rules: ['glossary' as const] },
    recordBlocks: [], proposed: [], rejected: [], competitors: [],
    coverage: { complete: true }, completeness: { processing: true, coverage: true, grounding: true, recall: 'unmeasured' as const },
  }
  const dto = extractionAttemptDto({ ...attemptSnapshot, diagnostics: { ...snapshot.diagnostics, grounded } })
  expect(dto.diagnostics?.grounded).toEqual(grounded)
})

it('echoes no Extraction Model Choice as null and transports no per-role models when kei-exp reported none', async () => {
  const { extractionAttemptDto } = await import('./_extraction_runtime.js')
  const dto = extractionAttemptDto(attemptSnapshot)
  expect(dto.requestedModels).toBeNull()
  expect(dto.diagnostics).not.toHaveProperty('models')
})

it('transports kei-exp attribution and service issue codes without filtering diagnostics', async () => {
  const { extractionAttemptDto } = await import('./_extraction_runtime.js')
  const dto = extractionAttemptDto({
    ...attemptSnapshot,
    modelAttribution: { provider: 'kei-exp', modelId: 'remote-model' },
    diagnostics: {
      ...snapshot.diagnostics,
      groundingIssues: [{ code: 'missing_value', detail: 'No source value', record: 0, path: ['records', 0, 'year'] }],
      groundingBatches: [],
    },
  })
  expect(dto.modelAttribution).toEqual({ provider: 'kei-exp', modelId: 'remote-model' })
  expect(dto.diagnostics?.grounding?.issueCodes).toEqual(['missing_value'])
})
