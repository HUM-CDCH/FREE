import { describe, expect, it, vi } from 'vitest'
import {
  ExtractionError,
  type ExtractionModule,
  type ExtractionSnapshot,
} from 'extraction'
import { createExtractionsApi } from './extractions.js'

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
  },
  result: { records: [{ title: 'Alpha' }] },
  evidence: [
    { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-alpha' },
  ],
  failure: null,
  reviewable: true,
  retryOfId: null,
  batchExtractionId: null,
  createdAt: new Date('2026-08-20T10:00:00.000Z'),
  reviewedAt: null,
  reviewDecisions: [],
}

function extractionModule(overrides: Partial<ExtractionModule> = {}) {
  const module: ExtractionModule = {
    runSingle: vi.fn<ExtractionModule['runSingle']>(async () => ({
      disposition: 'created',
      extraction: snapshot,
    })),
    cancelSingle: vi.fn<ExtractionModule['cancelSingle']>(
      async () => 'cancellation-requested',
    ),
    prepareReview: vi.fn<ExtractionModule['prepareReview']>(async () => ({
      extraction: snapshot,
      reviewDecisions: [
        {
          evidenceAnchorId: 'anchor-alpha',
          reviewedOccurrenceIds: ['occurrence-alpha'],
        },
      ],
    })),
    finalizeReview: vi.fn<ExtractionModule['finalizeReview']>(async () => ({
      disposition: 'reviewed',
      extraction: {
        ...snapshot,
        reviewedAt: new Date('2026-08-20T10:01:00.000Z'),
        reviewDecisions: [
          {
            evidenceAnchorId: 'anchor-alpha',
            reviewedOccurrenceIds: ['occurrence-alpha'],
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
  it('maps a fresh request to runSingle and preserves created/replayed status', async () => {
    const module = extractionModule()
    const handle = createExtractionsApi(module)

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
      extraction: snapshot,
    })
    expect((await handle(request(fresh))).status).toBe(200)
  })

  it('rejects targeted retry requests', async () => {
    const module = extractionModule()
    const handle = createExtractionsApi(module)
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
    expect(module.runSingle).not.toHaveBeenCalled()
  })

  it('reads canonical review preparation and finalizes submitted decisions', async () => {
    const module = extractionModule()
    const handle = createExtractionsApi(module)
    const read = await handle(
      new Request(`http://test/api/extractions/${EXTRACTION}`),
    )
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({
      pendingReviewDecisions: [
        {
          evidenceAnchorId: 'anchor-alpha',
          reviewedOccurrenceIds: ['occurrence-alpha'],
        },
      ],
    })

    const decisions = [
      {
        evidenceAnchorId: 'anchor-alpha',
        reviewedOccurrenceIds: ['occurrence-alpha'],
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
    expect(module.finalizeReview).toHaveBeenCalledWith(EXTRACTION, decisions)
    expect(await reviewed.json()).toMatchObject({
      reviewedAt: '2026-08-20T10:01:00.000Z',
    })
  })

  it('uses bounded cancellation and domain-error HTTP mappings', async () => {
    const module = extractionModule()
    const handle = createExtractionsApi(module)
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
