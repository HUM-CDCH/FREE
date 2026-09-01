// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useExtraction, type ReviewTarget } from './useExtraction'
import * as api from './api'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import {
  captureSessionRecovery,
  clearSessionRecovery,
  setSessionRecoveryAccount,
} from './auth/sessionRecovery'

vi.mock('./api', () => ({
  requestExtraction: vi.fn(),
  readExtraction: vi.fn(),
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
    executionStatus: 'COMPLETED',
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
      grounding: null,
      catalog: null,
      retry: null,
    },
    failure: null,
    resultPayload: { records: [{}] },
    evidenceLinks: [],
    reviewable: true,
    retryOfId: null,
    batchExtractionId: null,
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
  clearSessionRecovery()
  sessionStorage.clear()
  setSessionRecoveryAccount('99999999-9999-4999-8999-999999999999')
  vi.mocked(api.requestExtraction).mockReset()
  vi.mocked(api.readExtraction).mockReset()
  vi.mocked(api.cancelExtraction).mockReset()
  vi.mocked(api.finalizeExtractionReview).mockReset()
})

describe('useExtraction server-owned lifecycle', () => {
  it('polls a queued job through provisional values to completion', async () => {
    vi.useFakeTimers()
    const queued = attempt({
      executionStatus: 'QUEUED',
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
      resultPayload: null,
      evidenceLinks: null,
      reviewable: false,
    })
    const provisional = attempt({
      executionStatus: 'RUNNING',
      outcome: null,
      resultPayload: { records: [{ place: 'Rome' }] },
      evidenceLinks: null,
      reviewable: false,
    })
    vi.mocked(api.requestExtraction).mockResolvedValue(queued)
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null })
      .mockResolvedValueOnce({ extraction: attempt(), pendingReviewDecisions: [] })
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    let run!: Promise<ExtractionAttempt | null | undefined>
    act(() => { run = result.current.runExtraction() })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.state).toMatchObject({
      status: 'ready',
      result: { records: [{ place: 'Rome' }] },
    })
    expect(result.current.review.available).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      await run
    })
    expect(result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(input.onTerminal).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('keeps a checkpointed restored job cancellable', async () => {
    const restored = attempt({
      executionStatus: 'RUNNING',
      outcome: null,
      evidenceLinks: null,
      reviewable: false,
    })
    vi.mocked(api.cancelExtraction).mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() =>
      useExtraction(options(restored)),
    )

    expect(result.current.state.status).toBe('ready')
    await act(() => result.current.requestCancellation())

    expect(api.cancelExtraction).toHaveBeenCalledWith(restored.extractionId)
    unmount()
  })

  it('keeps polling through transient schema hydration for a restored job', async () => {
    vi.useFakeTimers()
    const restored = attempt({
      executionStatus: 'RUNNING',
      outcome: null,
      evidenceLinks: null,
      reviewable: false,
    })
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: attempt(),
      pendingReviewDecisions: [],
    })
    const onTerminal = vi.fn()
    const hook = renderHook(
      ({ reviewTarget }) =>
        useExtraction({
          ...options(restored),
          reviewTarget,
          onTerminal,
        }),
      {
        wrapper: StrictMode,
        initialProps: {
          reviewTarget: {
            sourceRepresentationId: representationId,
            schemaRevisionId,
          } as ReviewTarget | null,
        },
      },
    )

    hook.rerender({ reviewTarget: null })
    hook.rerender({
      reviewTarget: {
        sourceRepresentationId: representationId,
        schemaRevisionId,
      },
    })
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(hook.result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(onTerminal).toHaveBeenCalledOnce()
    hook.unmount()
    vi.useRealTimers()
  })

  it('ignores a stale restored-job read after its document changes', async () => {
    vi.useFakeTimers()
    const nextRepresentationId = '55555555-5555-4555-8555-555555555555'
    const restored = attempt({
      executionStatus: 'RUNNING',
      outcome: null,
      evidenceLinks: null,
      reviewable: false,
    })
    const replacement = attempt({
      extractionId: '66666666-6666-4666-8666-666666666666',
      sourceRepresentationRevisionId: nextRepresentationId,
    })
    const response = Promise.withResolvers<{
      extraction: ExtractionAttempt
      pendingReviewDecisions: []
    }>()
    const onTerminal = vi.fn()
    vi.mocked(api.readExtraction).mockReturnValueOnce(response.promise)
    const hook = renderHook(
      ({ initialAttempt, documentKey }) =>
        useExtraction({
          ...options(initialAttempt),
          documentKey,
          onTerminal,
        }),
      {
        initialProps: {
          initialAttempt: restored,
          documentKey: restored.sourceRepresentationRevisionId,
        },
      },
    )

    await act(() => vi.advanceTimersByTimeAsync(2_000))
    hook.rerender({
      initialAttempt: replacement,
      documentKey: nextRepresentationId,
    })
    await act(async () => {
      response.resolve({ extraction: attempt(), pendingReviewDecisions: [] })
      await Promise.resolve()
    })

    expect(hook.result.current.attempt?.extractionId).toBe(replacement.extractionId)
    expect(onTerminal).not.toHaveBeenCalled()
    hook.unmount()
    vi.useRealTimers()
  })

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

  it('submits the selected Catalog strategy with the run identity', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(
      attempt({
        strategy: 'CATALOG',
        diagnostics: {
          ...attempt().diagnostics!,
          catalog: { stages: [], records: [] },
        },
      }),
    )
    const { result } = renderHook(() => useExtraction(options()))

    await act(() => result.current.runExtraction(undefined, 'CATALOG'))

    expect(api.requestExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'CATALOG' }),
      expect.any(AbortSignal),
    )
    expect(result.current.attempt?.strategy).toBe('CATALOG')
  })

  it('submits targeted Catalog retries only for a Catalog parent', async () => {
    const article = attempt()
    const { result: articleHook } = renderHook(() =>
      useExtraction(options(article)),
    )
    await act(() =>
      articleHook.current.retryExtraction({
        retryDocument: false,
        rediscover: false,
        retryRecordStartBlockIds: ['h1'],
      }),
    )
    expect(api.requestExtraction).not.toHaveBeenCalled()

    const catalog = attempt({
      strategy: 'CATALOG',
      executionStatus: 'FAILED',
      outcome: null,
      evidenceLinks: null,
      reviewable: false,
      diagnostics: {
        ...attempt().diagnostics!,
        catalog: { stages: [], records: [] },
      },
    })
    vi.mocked(api.requestExtraction).mockResolvedValue(catalog)
    const { result } = renderHook(() => useExtraction(options(catalog)))
    await act(() =>
      result.current.retryExtraction({
        retryDocument: false,
        rediscover: true,
        retryRecordStartBlockIds: ['h1'],
      }),
    )
    expect(api.requestExtraction).toHaveBeenCalledWith(
      {
        id: expect.any(String),
        retryOfId: catalog.extractionId,
        retryDocument: false,
        rediscover: true,
        retryRecordStartBlockIds: ['h1'],
      },
      expect.any(AbortSignal),
    )
  })

  it('runs with an explicit acknowledged target before the next render', async () => {
    const acknowledgedTarget = {
      sourceRepresentationId: representationId,
      schemaRevisionId: '55555555-5555-4555-8555-555555555555',
    }
    vi.mocked(api.requestExtraction).mockResolvedValue(
      attempt({ schemaRevisionId: acknowledgedTarget.schemaRevisionId }),
    )
    const input = { ...options(), reviewTarget: null }
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction(acknowledgedTarget))

    expect(api.requestExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRepresentationRevisionId:
          acknowledgedTarget.sourceRepresentationId,
        schemaRevisionId: acknowledgedTarget.schemaRevisionId,
      }),
      expect.any(AbortSignal),
    )
  })

  it('schedules only one job when a run is invoked twice before the next render', () => {
    vi.mocked(api.requestExtraction).mockImplementation(
      () => new Promise(() => {}),
    )
    const { result } = renderHook(() => useExtraction(options()))

    act(() => {
      void result.current.runExtraction()
      void result.current.runExtraction()
    })

    expect(api.requestExtraction).toHaveBeenCalledOnce()
  })

  it('returns to idle when changed pins stop local polling', () => {
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
    expect(api.cancelExtraction).not.toHaveBeenCalled()
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

  it('does not offer review when no populated value has Evidence', async () => {
    const { result } = renderHook(() => useExtraction(options(attempt())))

    expect(result.current.review.available).toBe(false)
    expect(result.current.review.canAccept).toBe(false)
    await act(() => result.current.review.accept())
    expect(api.readExtraction).not.toHaveBeenCalled()
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  })

  it('keeps an ungrounded-only attempt visible but not reviewable', () => {
    const { result } = renderHook(() =>
      useExtraction(options(attempt({
        complete: false,
        diagnostics: {
          ...attempt().diagnostics!,
          grounding: {
            groundedPaths: [],
            ungroundedPaths: [['records', 0, 'title']],
            issueCodes: ['missing_claim'],
            batches: [],
          },
        },
      }))),
    )
    expect(result.current.review.available).toBe(false)
    expect(result.current.review.canAccept).toBe(false)
  })

  it('uses server-derived pending decisions when finalizing review', async () => {
    const decisions = [{
      resultPath: ['records', 0, 'title'],
      evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    }]
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-1',
      }],
    })
    const reviewed = attempt({
      ...unreviewed,
      reviewedAt: '2026-08-10T00:01:00.000Z',
      reviewDecisions: [{
        ...decisions[0],
        createdAt: '2026-08-10T00:01:00.000Z',
      }],
    })
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: unreviewed,
      pendingReviewDecisions: decisions,
    })
    vi.mocked(api.finalizeExtractionReview).mockResolvedValue(reviewed)
    const { result } = renderHook(() => useExtraction(options(unreviewed)))

    await waitFor(() => expect(result.current.review.canAccept).toBe(true))
    await act(() => result.current.review.accept())

    expect(api.readExtraction).toHaveBeenCalledWith(
      unreviewed.extractionId,
      expect.any(AbortSignal),
    )
    expect(api.finalizeExtractionReview).toHaveBeenCalledWith(
      unreviewed.extractionId,
      decisions,
    )
  })

  it('changes and reverses one value decision before submitting the exact draft', async () => {
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-1',
      }],
    })
    const pending = [{
      resultPath: ['records', 0, 'title'],
      evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    }]
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: unreviewed,
      pendingReviewDecisions: pending,
    })
    vi.mocked(api.finalizeExtractionReview).mockImplementation(
      async (_id, submitted) => attempt({
        ...unreviewed,
        reviewedAt: '2026-08-10T00:01:00.000Z',
        reviewDecisions: submitted.map((decision) => ({
          ...decision,
          createdAt: '2026-08-10T00:01:00.000Z',
        })),
      }),
    )
    const { result } = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(result.current.review.canAccept).toBe(true))

    act(() => result.current.review.setDecision(
      ['records', 0, 'title'], 'REJECTED', null,
    ))
    expect(result.current.review.decisions[0]?.action).toBe('REJECTED')
    act(() => result.current.review.setDecision(
      ['records', 0, 'title'], 'APPROVED', null,
    ))
    expect(result.current.review.decisions[0]?.action).toBe('APPROVED')
    act(() => result.current.review.setDecision(
      ['records', 0, 'title'], 'EDITED', 'Corrected',
    ))
    await act(() => result.current.review.accept())

    expect(api.finalizeExtractionReview).toHaveBeenCalledWith(
      unreviewed.extractionId,
      [{ ...pending[0], action: 'EDITED', reviewedValue: 'Corrected' }],
    )
    expect(result.current.review.reviewedExtractionId).toBe(unreviewed.extractionId)
  })

  it('treats every server-defaulted decision as untouched until acted on', async () => {
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded', author: 'A. Researcher' }] },
      evidenceLinks: [
        { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' },
        { resultPath: ['records', 0, 'author'], evidenceAnchorId: 'anchor-2' },
      ],
    })
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: unreviewed,
      pendingReviewDecisions: [
        {
          resultPath: ['records', 0, 'title'],
          evidenceAnchorId: 'anchor-1',
          reviewedOccurrenceIds: ['occurrence-1'],
          action: 'APPROVED',
          reviewedValue: null,
        },
        {
          resultPath: ['records', 0, 'author'],
          evidenceAnchorId: 'anchor-2',
          reviewedOccurrenceIds: ['occurrence-2'],
          action: 'APPROVED',
          reviewedValue: null,
        },
      ],
    })
    const { result } = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(result.current.review.canAccept).toBe(true))

    expect(result.current.review.untouchedCount).toBe(2)
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(false)
    expect(result.current.review.isTouched(['records', 0, 'author'])).toBe(false)

    act(() => result.current.review.setDecision(['records', 0, 'title'], 'REJECTED', null))
    expect(result.current.review.untouchedCount).toBe(1)
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(true)
    expect(result.current.review.isTouched(['records', 0, 'author'])).toBe(false)

    act(() => result.current.review.approveAll())
    expect(result.current.review.untouchedCount).toBe(0)
    expect(result.current.review.isTouched(['records', 0, 'author'])).toBe(true)
    // Approve All only fills in the untouched field — the explicit Reject stands.
    expect(result.current.review.decisions.find(
      (decision) => decision.resultPath.join('.') === 'records.0.title',
    )?.action).toBe('REJECTED')
  })

  it('restores touched review decisions only against the same server preparation', async () => {
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded' }] },
      evidenceLinks: [
        {
          resultPath: ['records', 0, 'title'],
          evidenceAnchorId: 'anchor-1',
        },
      ],
    })
    const pending = [
      {
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-1',
        reviewedOccurrenceIds: ['occurrence-1'],
        action: 'APPROVED' as const,
        reviewedValue: null,
      },
    ]
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: unreviewed,
      pendingReviewDecisions: pending,
    })
    const first = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(first.result.current.review.canAccept).toBe(true))
    act(() =>
      first.result.current.review.setDecision(
        ['records', 0, 'title'],
        'REJECTED',
        null,
      ),
    )
    act(() => captureSessionRecovery())
    first.unmount()

    setSessionRecoveryAccount('99999999-9999-4999-8999-999999999999')
    const restored = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() =>
      expect(restored.result.current.review.decisions[0]?.action).toBe(
        'REJECTED',
      ),
    )
    expect(
      restored.result.current.review.isTouched(['records', 0, 'title']),
    ).toBe(true)
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('leaves recovery untouched when a pending review load unmounts', async () => {
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-1',
      }],
    })
    const pending = [{
      resultPath: ['records', 0, 'title'],
      evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    }]
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: unreviewed,
      pendingReviewDecisions: pending,
    })
    const first = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(first.result.current.review.canAccept).toBe(true))
    act(() =>
      first.result.current.review.setDecision(
        ['records', 0, 'title'],
        'REJECTED',
        null,
      ),
    )
    act(() => captureSessionRecovery())
    first.unmount()

    setSessionRecoveryAccount('99999999-9999-4999-8999-999999999999')
    const deferred = Promise.withResolvers<{
      extraction: ExtractionAttempt
      pendingReviewDecisions: typeof pending
    }>()
    vi.mocked(api.readExtraction).mockReset()
    vi.mocked(api.readExtraction).mockReturnValue(deferred.promise)
    const second = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(api.readExtraction).toHaveBeenCalledOnce())
    const signal = vi.mocked(api.readExtraction).mock.calls[0]?.[1]
    second.unmount()

    deferred.resolve({ extraction: unreviewed, pendingReviewDecisions: pending })
    await act(async () => deferred.promise)

    expect(signal?.aborted).toBe(true)
    expect(sessionStorage.getItem('free.auth.recovery.v1')).not.toBeNull()
  })

  it('keeps a concurrently finalized server review over recovered decisions', async () => {
    const pending = [{
      resultPath: ['records', 0, 'title'],
      evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    }]
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-1',
      }],
    })
    const reviewed = attempt({
      ...unreviewed,
      reviewedAt: '2026-08-10T00:01:00.000Z',
      reviewDecisions: [{
        ...pending[0],
        createdAt: '2026-08-10T00:01:00.000Z',
      }],
    })
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: unreviewed,
      pendingReviewDecisions: pending,
    })
    const first = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(first.result.current.review.canAccept).toBe(true))
    act(() =>
      first.result.current.review.setDecision(
        ['records', 0, 'title'],
        'REJECTED',
        null,
      ),
    )
    act(() => captureSessionRecovery())
    first.unmount()

    setSessionRecoveryAccount('99999999-9999-4999-8999-999999999999')
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: reviewed,
      pendingReviewDecisions: [],
    })
    const restored = renderHook(() => useExtraction(options(unreviewed)))

    await waitFor(() =>
      expect(restored.result.current.attempt?.reviewedAt).toBe(
        reviewed.reviewedAt,
      ),
    )
    expect(restored.result.current.review.decisions[0]?.action).toBe('APPROVED')
    expect(restored.result.current.review.untouchedCount).toBe(0)
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it('reads an already-saved review as fully touched', async () => {
    const reviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }],
      reviewedAt: '2026-08-10T00:01:00.000Z',
      reviewDecisions: [{
        resultPath: ['records', 0, 'title'],
        evidenceAnchorId: 'anchor-1',
        reviewedOccurrenceIds: ['occurrence-1'],
        action: 'APPROVED',
        reviewedValue: null,
        createdAt: '2026-08-10T00:01:00.000Z',
      }],
    })
    const { result } = renderHook(() => useExtraction(options(reviewed)))

    await waitFor(() => expect(result.current.review.decisions).toHaveLength(1))
    expect(result.current.review.untouchedCount).toBe(0)
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(true)
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
