// @vitest-environment jsdom

import type { ReviewDecisionInput } from '../shared/extraction.contract'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTRACTION_UNAVAILABLE, MONITOR_DISCONNECTED, useExtraction, type ReviewTarget } from './useExtraction'
import * as api from './api'
import { ApiRequestError } from './api'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import {
  clearSessionRecovery,
  setSessionRecoveryAccount,
} from './auth/sessionRecovery'

vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  requestExtraction: vi.fn(),
  readExtraction: vi.fn(),
  cancelExtraction: vi.fn(),
  finalizeExtractionReview: vi.fn(),
  saveExtractionReviewDraft: vi.fn(),
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
    },
    failure: null,
    resultPayload: { records: [{}] },
    evidenceLinks: [],
    reviewable: true,
    batchExtractionId: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    reviewedAt: null,
    reviewDecisions: [],
    ...overrides,
  }
}

/** A QUEUED or RUNNING attempt: a job carries no values, attribution or diagnostics until it completes. */
function jobAttempt(overrides: Partial<ExtractionAttempt> = {}): ExtractionAttempt {
  return attempt({
    executionStatus: 'RUNNING', outcome: null, complete: null, modelAttribution: null,
    diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false, ...overrides,
  })
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

const savedDrafts = new Map<string, { version: number; decisions: ReviewDecisionInput[] }>()

beforeEach(() => {
  savedDrafts.clear()
  vi.mocked(api.saveExtractionReviewDraft).mockReset()
  vi.mocked(api.saveExtractionReviewDraft).mockImplementation(async (id, decisions, version) => {
    const saved = { decisions: [...decisions], version: (savedDrafts.get(id)?.version ?? version) + 1 }
    savedDrafts.set(id, saved)
    return saved
  })
  clearSessionRecovery()
  sessionStorage.clear()
  setSessionRecoveryAccount('99999999-9999-4999-8999-999999999999')
  vi.mocked(api.requestExtraction).mockReset()
  vi.mocked(api.readExtraction).mockReset()
  vi.mocked(api.cancelExtraction).mockReset()
  vi.mocked(api.finalizeExtractionReview).mockReset()
})

describe('useExtraction server-owned lifecycle', () => {
  it('retains successive decisions before React renders and clears the draft after saving', async () => {
    const pending = ['title', 'year'].map((name) => ({ resultPath: ['records', 0, name], evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED' as const, reviewedValue: null }))
    const original = attempt({ evidenceLinks: [{ resultPath: pending[0].resultPath, evidenceAnchorId: 'anchor-1' }] })
    vi.mocked(api.readExtraction).mockImplementation(async () => ({ extraction: original, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(original.extractionId) }))
    const first = renderHook(() => useExtraction(options(original)))
    await waitFor(() => expect(first.result.current.review.decisions).toHaveLength(2))
    act(() => {
      first.result.current.review.setDecision(pending[0].resultPath, 'EDITED', 'Corrected')
      first.result.current.review.setDecision(pending[1].resultPath, 'REJECTED')
      first.result.current.review.approveAll()
    })
    expect(first.result.current.review.decisions.map((decision) => decision.action)).toEqual(['EDITED', 'REJECTED'])
    expect(first.result.current.review.untouchedCount).toBe(0)
    vi.mocked(api.finalizeExtractionReview).mockResolvedValue(attempt({ reviewedAt: '2026-09-06T00:00:00Z' }))
    await act(() => first.result.current.review.accept())
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith('free.review-draft.'))).toEqual([])
  })

  it('restores committed decisions after document navigation and a remount without authentication recovery', async () => {
    const original = attempt({ evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }] })
    const pending = [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED' as const, reviewedValue: null }]
    vi.mocked(api.readExtraction).mockImplementation(async () => ({ extraction: original, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(original.extractionId) }))
    const first = renderHook(({ documentKey }) => useExtraction({ ...options(original), documentKey }), { initialProps: { documentKey: 'first' } })
    await waitFor(() => expect(first.result.current.review.decisions).toHaveLength(1))
    act(() => first.result.current.review.setDecision(pending[0].resultPath, 'REJECTED'))
    first.rerender({ documentKey: 'second' })
    first.rerender({ documentKey: 'first' })
    await waitFor(() => expect(first.result.current.review.decisions[0]?.action).toBe('REJECTED'))
    first.unmount()
    const restored = renderHook(() => useExtraction(options(original)))
    await waitFor(() => expect(restored.result.current.review.decisions[0]?.action).toBe('REJECTED'))
    expect(restored.result.current.review.isTouched(pending[0].resultPath)).toBe(true)
  })

  it('locks a submitted review and ignores its response after switching documents', async () => {
    const pending = [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED' as const, reviewedValue: null }]
    const original = attempt({ resultPayload: { records: [{ title: 'Grounded' }] }, evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }] })
    vi.mocked(api.readExtraction).mockImplementation(async () => ({ extraction: original, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(original.extractionId) }))
    const save = Promise.withResolvers<ExtractionAttempt>()
    vi.mocked(api.finalizeExtractionReview).mockReturnValue(save.promise)
    const { result, rerender } = renderHook(({ current, documentKey }) => useExtraction({ ...options(current), documentKey }), { initialProps: { current: original, documentKey: 'first' } })
    await waitFor(() => expect(result.current.review.decisions).toHaveLength(1))
    act(() => result.current.review.setDecision(pending[0].resultPath, 'EDITED', 'Submitted'))
    let request!: Promise<void>
    act(() => {
      request = result.current.review.accept()
      void result.current.review.accept()
      result.current.review.setDecision(pending[0].resultPath, 'EDITED', 'Lost')
      result.current.review.approveAll()
    })
    await waitFor(() => expect(api.finalizeExtractionReview).toHaveBeenCalledTimes(1))
    expect(result.current.review.decisions[0].reviewedValue).toBe('Submitted')
    const newer = attempt({ extractionId: '11111111-1111-4111-8111-111111111112' })
    rerender({ current: newer, documentKey: 'second' })
    await act(async () => { save.resolve({ ...original, reviewedAt: '2026-09-04T00:00:00Z' }); await request })
    expect(result.current.attempt?.extractionId).toBe(newer.extractionId)
    expect(result.current.review.saving).toBe(false)
  })

  it('polls a queued job to completion', async () => {
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
    const provisional = jobAttempt()
    vi.mocked(api.requestExtraction).mockResolvedValue(queued)
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null })
      .mockResolvedValueOnce({ extraction: attempt(), pendingReviewDecisions: [] })
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    let run!: Promise<ExtractionAttempt | null | undefined>
    act(() => { run = result.current.runExtraction() })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    // The state alone also fits the initial QUEUED attempt; the status proves the first read was applied.
    expect(result.current.attempt?.executionStatus).toBe('RUNNING')
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction' })
    expect(result.current.review.available).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      await run
    })
    expect(result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(input.onTerminal).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('keeps a restored running job cancellable', async () => {
    const restored = jobAttempt()
    vi.mocked(api.cancelExtraction).mockResolvedValue(undefined)
    const { result, unmount } = renderHook(() =>
      useExtraction(options(restored)),
    )

    expect(result.current.state.status).toBe('running')
    await act(() => result.current.requestCancellation())

    expect(api.cancelExtraction).toHaveBeenCalledWith(restored.extractionId)
    unmount()
  })

  it('keeps polling through transient schema hydration for a restored job', async () => {
    vi.useFakeTimers()
    const restored = jobAttempt()
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
    const restored = jobAttempt()
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

  it('sends no Extraction Model Choice: the server applies the configured one', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(attempt({ requestedModels: { reasoning: 'instruct' } }))
    const { result } = renderHook(() => useExtraction(options()))

    await act(() => result.current.runExtraction(undefined, 'ARTICLE', null))

    expect(vi.mocked(api.requestExtraction).mock.calls[0]![0]).not.toHaveProperty('models')
    expect(result.current.attempt?.requestedModels).toEqual({ reasoning: 'instruct' })
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

  it('keeps polling and the Extraction state when the Current Schema Revision changes', async () => {
    vi.useFakeTimers()
    const running = attempt({ executionStatus: 'RUNNING', outcome: null, complete: null, modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false })
    vi.mocked(api.requestExtraction).mockResolvedValue(running)
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: running, pendingReviewDecisions: null })
      .mockResolvedValueOnce({ extraction: attempt(), pendingReviewDecisions: [] })
    vi.mocked(api.cancelExtraction).mockResolvedValue(undefined)
    const onTerminal = vi.fn()
    const { result, rerender } = renderHook(
      ({ revision }) =>
        useExtraction({
          ...options(),
          onTerminal,
          reviewTarget: {
            sourceRepresentationId: representationId,
            schemaRevisionId: revision,
          },
        }),
      { initialProps: { revision: schemaRevisionId as string | null } },
    )

    await act(() => result.current.runExtraction())
    expect(result.current.state.status).toBe('running')

    // Unsaved edits (null) and a newer saved revision both leave the run alone.
    rerender({ revision: null })
    rerender({ revision: '55555555-5555-4555-8555-555555555555' })
    expect(result.current.state.status).toBe('running')
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.attempt?.executionStatus).toBe('RUNNING')
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(onTerminal).toHaveBeenCalledOnce()
    expect(api.requestExtraction).toHaveBeenCalledOnce()
    expect(api.cancelExtraction).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('monitors a restored previous-schema run after a document switch and offers its review', async () => {
    vi.useFakeTimers()
    const previousRevisionId = '66666666-6666-4666-8666-666666666666'
    const restored = jobAttempt({ extractionId: '77777777-7777-4777-8777-777777777777', schemaRevisionId: previousRevisionId })
    const finished = attempt({ extractionId: restored.extractionId, schemaRevisionId: previousRevisionId, resultPayload: { records: [{ title: 'Grounded' }] }, evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }], reviewable: true })
    const pending = [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED' as const, reviewedValue: null }]
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: finished, pendingReviewDecisions: pending })
    const onTerminal = vi.fn()
    const hook = renderHook(
      ({ initialAttempt, documentKey }) =>
        useExtraction({ ...options(initialAttempt), documentKey, onTerminal }),
      { initialProps: { initialAttempt: attempt(), documentKey: 'first' } },
    )

    hook.rerender({ initialAttempt: restored, documentKey: 'second' })
    expect(hook.result.current.state.status).toBe('running')
    expect(hook.result.current.attempt?.extractionId).toBe(restored.extractionId)
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ extractionId: restored.extractionId }), true)
    // The current revision differs, but the source matches: review stays open.
    expect(hook.result.current.review.available).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(hook.result.current.review.decisions).toHaveLength(1)
    vi.useRealTimers()
  })

  it('keeps draft decisions while the Current Schema Revision is temporarily unsaved', async () => {
    const pending = [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED' as const, reviewedValue: null }]
    const original = attempt({ evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }] })
    vi.mocked(api.readExtraction).mockImplementation(async () => ({ extraction: original, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(original.extractionId) }))
    const hook = renderHook(
      ({ revision }) =>
        useExtraction({
          ...options(original),
          reviewTarget: { sourceRepresentationId: representationId, schemaRevisionId: revision },
        }),
      { initialProps: { revision: schemaRevisionId as string | null } },
    )
    await waitFor(() => expect(hook.result.current.review.decisions).toHaveLength(1))
    act(() => hook.result.current.review.setDecision(pending[0].resultPath, 'REJECTED'))
    const readsBefore = vi.mocked(api.readExtraction).mock.calls.length

    hook.rerender({ revision: null })
    hook.rerender({ revision: '55555555-5555-4555-8555-555555555555' })

    expect(hook.result.current.review.available).toBe(true)
    expect(hook.result.current.review.decisions[0]?.action).toBe('REJECTED')
    expect(hook.result.current.review.isTouched(pending[0].resultPath)).toBe(true)
    expect(vi.mocked(api.readExtraction).mock.calls).toHaveLength(readsBefore)
  })

  it('blocks review for a different Source Representation regardless of the schema', () => {
    const otherSource = attempt({
      sourceRepresentationRevisionId: '55555555-5555-4555-8555-555555555555',
      evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }],
    })
    const { result } = renderHook(() => useExtraction(options(otherSource)))
    expect(result.current.review.available).toBe(false)
  })

  it('pauses on a failed status read and reconnects by reading the same Extraction', async () => {
    vi.useFakeTimers()
    const running = attempt({ executionStatus: 'RUNNING', outcome: null, complete: null, modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false })
    vi.mocked(api.readExtraction)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ extraction: running, pendingReviewDecisions: null })
      .mockResolvedValueOnce({ extraction: attempt(), pendingReviewDecisions: [] })
    const input = options(running)
    const { result } = renderHook(() => useExtraction(input))

    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED)
    expect(result.current.state.status).toBe('running')
    expect(result.current.attempt?.extractionId).toBe(running.extractionId)
    // Paused: no further reads until the researcher reconnects.
    await act(() => vi.advanceTimersByTimeAsync(4_000))
    expect(api.readExtraction).toHaveBeenCalledTimes(1)

    act(() => result.current.reconnect())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(api.readExtraction).toHaveBeenCalledTimes(2)
    expect(api.readExtraction).toHaveBeenLastCalledWith(running.extractionId, expect.any(AbortSignal))
    expect(result.current.monitorError).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(input.onTerminal).toHaveBeenCalledOnce()
    expect(api.requestExtraction).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('reconciles an uncertain POST through its generated identity instead of posting again', async () => {
    vi.useFakeTimers()
    vi.mocked(api.requestExtraction).mockRejectedValue(new TypeError('Failed to fetch'))
    const queued = attempt({ executionStatus: 'QUEUED', outcome: null, complete: null, modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false })
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: queued, pendingReviewDecisions: null })
      .mockResolvedValueOnce({ extraction: attempt(), pendingReviewDecisions: [] })
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction())
    const posted = vi.mocked(api.requestExtraction).mock.calls[0]![0].id
    expect(api.readExtraction).toHaveBeenCalledWith(posted, expect.any(AbortSignal))
    expect(result.current.attempt?.executionStatus).toBe('QUEUED')
    expect(result.current.monitorError).toBeNull()
    expect(input.onError).not.toHaveBeenCalled()
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(api.requestExtraction).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('reports an unavailable Extraction after an uncertain POST without inventing a failure', async () => {
    vi.mocked(api.requestExtraction).mockRejectedValue(new TypeError('Failed to fetch'))
    vi.mocked(api.readExtraction).mockRejectedValue(new ApiRequestError('not found', 404))
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction())

    expect(result.current.monitorError).toBe(EXTRACTION_UNAVAILABLE)
    expect(result.current.state.status).toBe('running')
    expect(input.onError).not.toHaveBeenCalled()
    expect(api.requestExtraction).toHaveBeenCalledOnce()
  })

  it('fails immediately when the server definitely rejects the POST', async () => {
    vi.mocked(api.requestExtraction).mockRejectedValue(new ApiRequestError('conflict', 409))
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction())

    expect(result.current.state).toEqual({ status: 'error', message: 'conflict' })
    expect(input.onError).toHaveBeenCalledWith('conflict')
    expect(api.readExtraction).not.toHaveBeenCalled()
  })

  it('keeps a failed cancellation separate from the connection and re-enables the request', async () => {
    vi.useFakeTimers()
    const running = attempt({ executionStatus: 'RUNNING', outcome: null, complete: null, modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false })
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: running, pendingReviewDecisions: null })
    vi.mocked(api.cancelExtraction).mockRejectedValueOnce(new Error('Cancellation failed (HTTP 500)'))
    const { result } = renderHook(() => useExtraction(options(running)))

    await act(() => result.current.requestCancellation())

    expect(result.current.cancellationRequested).toBe(false)
    expect(result.current.cancellationError).toBe('Cancellation failed (HTTP 500)')
    expect(result.current.monitorError).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(api.readExtraction).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('shows the actual outcome when the Extraction completes before the cancellation lands', async () => {
    vi.useFakeTimers()
    const running = attempt({ executionStatus: 'RUNNING', outcome: null, complete: null, modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false })
    const cancel = Promise.withResolvers<void>()
    vi.mocked(api.cancelExtraction).mockReturnValue(cancel.promise)
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt(), pendingReviewDecisions: [] })
    const input = options(running)
    const { result } = renderHook(() => useExtraction(input))

    act(() => void result.current.requestCancellation())
    expect(result.current.cancellationRequested).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.attempt?.outcome).toBe('SUCCEEDED')
    expect(result.current.state.status).toBe('ready')
    expect(input.onTerminal).toHaveBeenCalledOnce()

    await act(async () => { cancel.reject(new Error('Extraction failed (HTTP 404)')); await Promise.resolve() })
    expect(result.current.state.status).toBe('ready')
    expect(result.current.monitorError).toBeNull()
    vi.useRealTimers()
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

    await waitFor(() => expect(result.current.review.decisions.length).toBeGreaterThan(0))
    expect(result.current.review.canAccept).toBe(false)
    act(() => result.current.review.approveAll())
    expect(result.current.review.canAccept).toBe(true)
    await act(() => result.current.review.accept())

    expect(api.readExtraction).toHaveBeenCalledWith(
      unreviewed.extractionId,
      expect.any(AbortSignal),
    )
    expect(api.finalizeExtractionReview).toHaveBeenCalledWith(
      unreviewed.extractionId,
      decisions,
      1,
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
    vi.mocked(api.readExtraction).mockImplementation(async () => ({
      extraction: unreviewed, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(unreviewed.extractionId),
    }))
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
    await waitFor(() => expect(result.current.review.decisions.length).toBeGreaterThan(0))

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
      3,
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
    await waitFor(() => expect(result.current.review.decisions.length).toBeGreaterThan(0))

    expect(result.current.review.untouchedCount).toBe(2)
    expect(result.current.review.canAccept).toBe(false)
    await act(() => result.current.review.accept())
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(false)
    expect(result.current.review.isTouched(['records', 0, 'author'])).toBe(false)

    act(() => result.current.review.setDecision(['records', 0, 'title'], 'REJECTED', null))
    expect(result.current.review.untouchedCount).toBe(1)
    expect(result.current.review.canAccept).toBe(false)
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(true)
    expect(result.current.review.isTouched(['records', 0, 'author'])).toBe(false)

    act(() => result.current.review.approveAll())
    expect(result.current.review.untouchedCount).toBe(0)
    expect(result.current.review.canAccept).toBe(true)
    expect(result.current.review.isTouched(['records', 0, 'author'])).toBe(true)
    // Approve All only fills in the untouched field — the explicit Reject stands.
    expect(result.current.review.decisions.find(
      (decision) => decision.resultPath.join('.') === 'records.0.title',
    )?.action).toBe('REJECTED')
  })

  it('restores server-saved draft decisions without browser storage', async () => {
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
    vi.mocked(api.readExtraction).mockImplementation(async () => ({
      extraction: unreviewed, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(unreviewed.extractionId),
    }))
    const first = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(first.result.current.review.decisions.length).toBeGreaterThan(0))
    act(() =>
      first.result.current.review.setDecision(
        ['records', 0, 'title'],
        'REJECTED',
        null,
      ),
    )
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

  it('does not write an empty draft when a pending review load unmounts', async () => {
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
    vi.mocked(api.readExtraction).mockImplementation(async () => ({
      extraction: unreviewed, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(unreviewed.extractionId),
    }))
    const first = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(first.result.current.review.decisions.length).toBeGreaterThan(0))
    act(() =>
      first.result.current.review.setDecision(
        ['records', 0, 'title'],
        'REJECTED',
        null,
      ),
    )
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
    expect(savedDrafts.get(unreviewed.extractionId)?.decisions[0].action).toBe('REJECTED')
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
    vi.mocked(api.readExtraction).mockImplementation(async () => ({
      extraction: unreviewed, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(unreviewed.extractionId),
    }))
    const first = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(first.result.current.review.decisions.length).toBeGreaterThan(0))
    act(() =>
      first.result.current.review.setDecision(
        ['records', 0, 'title'],
        'REJECTED',
        null,
      ),
    )
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
