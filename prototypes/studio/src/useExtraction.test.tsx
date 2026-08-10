// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtraction } from './useExtraction'
import * as api from './api'
import type { ExtractionAttempt } from '../shared/articleExtraction.contract'

vi.mock('./api', () => ({
  requestArticleExtraction: vi.fn(),
  cancelArticleExtraction: vi.fn(),
  finalizeArticleReview: vi.fn(),
}))

const representationId = '22222222-2222-4222-8222-222222222222'
const schemaRevisionId = '33333333-3333-4333-8333-333333333333'

function attempt(
  overrides: Partial<ExtractionAttempt> = {},
): ExtractionAttempt {
  return {
    extractionId: '11111111-1111-4111-8111-111111111111',
    sourceDocumentId: '44444444-4444-4444-8444-444444444444',
    sourceRepresentationRevisionId: representationId,
    schemaRevisionId,
    strategy: 'ARTICLE',
    outcome: 'SUCCEEDED',
    complete: true,
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    diagnostics: {
      phase: 'persisting',
      durationMs: 1,
      modelCalls: 0,
      finishReason: null,
      inputTokens: null,
      outputTokens: null,
      grounding: null,
    },
    failure: null,
    resultPayload: { records: [{ filename: 'report.pdf' }] },
    evidenceLinks: [],
    reviewable: true,
    retryOfId: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    reviewedAt: null,
    reviewDecisions: [],
    ...overrides,
  }
}

function options(initialAttempt: ExtractionAttempt | null = null) {
  return {
    schemaReady: true,
    indexing: false,
    initialAttempt,
    reviewTarget: {
      sourceRepresentationId: representationId,
      schemaRevisionId,
    },
    onComplete: vi.fn(),
    onError: vi.fn(),
  }
}

beforeEach(() => {
  vi.mocked(api.requestArticleExtraction).mockReset()
  vi.mocked(api.cancelArticleExtraction).mockReset()
  vi.mocked(api.finalizeArticleReview).mockReset()
})

describe('useExtraction server-owned Article lifecycle', () => {
  it('posts only new identity pins and presents the persisted attempt', async () => {
    vi.mocked(api.requestArticleExtraction).mockResolvedValue(attempt())
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction())

    expect(api.requestArticleExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
        strategy: 'ARTICLE',
        id: expect.any(String),
      }),
      expect.any(AbortSignal),
    )
    expect(result.current.state).toMatchObject({
      status: 'ready',
      result: { records: [{ filename: 'report.pdf' }] },
    })
  })

  it('finalizes a package-only result with an empty decision set', async () => {
    const reviewed = attempt({ reviewedAt: '2026-08-10T00:01:00.000Z' })
    vi.mocked(api.finalizeArticleReview).mockResolvedValue(reviewed)
    const { result } = renderHook(() => useExtraction(options(attempt())))

    expect(result.current.review.canAccept).toBe(true)
    await act(() => result.current.review.accept())

    expect(api.finalizeArticleReview).toHaveBeenCalledWith(
      attempt().extractionId,
      [],
    )
    expect(result.current.review.reviewedExtractionId).toBe(
      reviewed.extractionId,
    )
  })

  it('does not offer review for an ungrounded attempt', () => {
    const { result } = renderHook(() =>
      useExtraction(options(attempt({ reviewable: false }))),
    )
    expect(result.current.review.available).toBe(false)
    expect(result.current.review.canAccept).toBe(false)
  })
})
