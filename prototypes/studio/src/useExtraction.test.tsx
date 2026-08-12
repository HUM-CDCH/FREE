// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtraction } from './useExtraction'
import * as api from './api'
import type { ExtractionAttempt } from '../shared/extraction.contract'

vi.mock('./api', () => ({
  requestExtraction: vi.fn(),
  cancelExtraction: vi.fn(),
  finalizeExtractionReview: vi.fn(),
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
      phase: 'grounding',
      durationMs: 1,
      modelCalls: 0,
      finishReason: null,
      inputTokens: null,
      outputTokens: null,
      values: null,
      grounding: null,
      catalog: null,
    },
    failure: null,
    resultPayload: { records: [{}] },
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
    onTerminal: vi.fn(),
    onError: vi.fn(),
  }
}

beforeEach(() => {
  vi.mocked(api.requestExtraction).mockReset()
  vi.mocked(api.cancelExtraction).mockReset()
  vi.mocked(api.finalizeExtractionReview).mockReset()
})

describe('useExtraction server-owned lifecycle', () => {
  it('posts only new identity pins and presents the persisted attempt', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(attempt())
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction())

    expect(api.requestExtraction).toHaveBeenCalledWith(
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
      result: { records: [{}] },
    })
  })

  it('submits an explicitly selected Catalog strategy', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(
      attempt({
        strategy: 'CATALOG',
        diagnostics: {
          phase: 'grounding',
          durationMs: 1,
          modelCalls: 1,
          finishReason: 'stop',
          inputTokens: 1,
          outputTokens: 1,
          values: null,
          grounding: null,
          catalog: { stages: [], records: [] },
        },
      }),
    )
    const { result } = renderHook(() => useExtraction(options()))

    await act(() => result.current.runExtraction('CATALOG'))

    expect(api.requestExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'CATALOG' }),
      expect.any(AbortSignal),
    )
    expect(result.current.attempt?.strategy).toBe('CATALOG')
  })

  it('submits a fresh targeted Catalog retry and supports grounding-only selection', async () => {
    const parent = attempt({
      strategy: 'CATALOG',
      diagnostics: {
        phase: 'grounding', durationMs: 1, modelCalls: 1,
        finishReason: null, inputTokens: 1, outputTokens: 1,
        values: null, grounding: null,
        catalog: {
          stages: [],
          records: [],
        },
      },
    })
    const child = attempt({
      extractionId: '66666666-6666-4666-8666-666666666666',
      strategy: 'CATALOG', retryOfId: parent.extractionId,
      diagnostics: parent.diagnostics,
    })
    vi.mocked(api.requestExtraction).mockResolvedValue(child)
    const { result } = renderHook(() => useExtraction(options(parent)))

    await act(() => result.current.retryExtraction({
      retryDocument: false,
      rediscover: false,
      retryRecordStartBlockIds: [],
    }))

    expect(api.requestExtraction).toHaveBeenCalledWith(
      {
        id: expect.any(String),
        retryOfId: parent.extractionId,
        retryDocument: false,
        rediscover: false,
        retryRecordStartBlockIds: [],
      },
      expect.any(AbortSignal),
    )
    expect(result.current.attempt?.extractionId).toBe(child.extractionId)
  })

  it('blocks a second targeted retry while the first request is active', () => {
    vi.mocked(api.requestExtraction).mockImplementation(() => new Promise(() => {}))
    const parent = attempt({ strategy: 'CATALOG', diagnostics: {
      phase: 'grounding', durationMs: 1, modelCalls: 1,
      finishReason: null, inputTokens: 1, outputTokens: 1,
      values: null, grounding: null, catalog: { stages: [], records: [] },
    } })
    const { result } = renderHook(() => useExtraction(options(parent)))
    const selection = { retryDocument: false, rediscover: false, retryRecordStartBlockIds: [] }

    act(() => void result.current.retryExtraction(selection))
    act(() => void result.current.retryExtraction(selection))

    expect(api.requestExtraction).toHaveBeenCalledOnce()
    expect(result.current.state.status).toBe('running')
  })

  it('returns to idle when changed pins cancel a running extraction', () => {
    vi.mocked(api.requestExtraction).mockImplementation(
      () => new Promise(() => {}),
    )
    vi.mocked(api.cancelExtraction).mockResolvedValue(undefined)
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useExtraction({
          ...options(),
          reviewTarget: {
            sourceRepresentationId: representationId,
            schemaRevisionId: revision,
          },
        }),
      { initialProps: { revision: schemaRevisionId } },
    )

    act(() => void result.current.runExtraction())
    expect(result.current.state.status).toBe('running')

    rerender({ revision: '55555555-5555-4555-8555-555555555555' })

    expect(result.current.state.status).toBe('idle')
    expect(api.cancelExtraction).toHaveBeenCalledOnce()
  })

  it('keeps the POST live until persisted cancellation returns', async () => {
    let resolvePost!: (attempt: ExtractionAttempt) => void
    let signal: AbortSignal | undefined
    vi.mocked(api.requestExtraction).mockImplementation((_input, requestSignal) => {
      signal = requestSignal
      return new Promise((resolve) => { resolvePost = resolve })
    })
    vi.mocked(api.cancelExtraction).mockResolvedValue(undefined)
    const { result } = renderHook(() => useExtraction(options()))

    act(() => void result.current.runExtraction())
    await act(() => result.current.requestCancellation())

    expect(signal?.aborted).toBe(false)
    expect(result.current.state.status).toBe('running')
    expect(result.current.cancellationRequested).toBe(true)

    await act(() => {
      resolvePost(attempt({ outcome: 'CANCELLED', complete: null, resultPayload: null, evidenceLinks: null, modelAttribution: null, reviewable: false }))
    })
    expect(result.current.state.status).toBe('cancelled')
    expect(result.current.attempt?.outcome).toBe('CANCELLED')
  })

  it('finalizes a result without populated values using an empty decision set', async () => {
    const reviewed = attempt({ reviewedAt: '2026-08-10T00:01:00.000Z' })
    vi.mocked(api.finalizeExtractionReview).mockResolvedValue(reviewed)
    const { result } = renderHook(() => useExtraction(options(attempt())))

    expect(result.current.review.canAccept).toBe(true)
    await act(() => result.current.review.accept())

    expect(api.finalizeExtractionReview).toHaveBeenCalledWith(
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

  it('blocks review of a historical attempt and reruns with current pins', async () => {
    const historical = attempt({
      sourceRepresentationRevisionId:
        '55555555-5555-4555-8555-555555555555',
      schemaRevisionId: '66666666-6666-4666-8666-666666666666',
    })
    vi.mocked(api.requestExtraction).mockResolvedValue(attempt())
    const { result } = renderHook(() =>
      useExtraction(options(historical)),
    )

    expect(result.current.review.available).toBe(false)
    expect(result.current.review.canAccept).toBe(false)
    await act(() => result.current.runExtraction())

    expect(api.requestExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
      }),
      expect.any(AbortSignal),
    )
  })
})
