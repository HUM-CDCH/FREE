// @vitest-environment jsdom

import type { ReviewDecisionInput } from '../shared/extraction.contract'
import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTRACTION_UNAVAILABLE, MONITOR_DISCONNECTED, useExtraction, type ReviewTarget } from './useExtraction'
import * as api from './api'
import { ApiRequestError } from './api'
import { REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import type { ExtractionAttempt, PartialRecord, PartialResult } from '../shared/extraction.contract'
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

/** The saved method of an account that keeps every service default, as an Article start view submits it. */
const SERVICE_DEFAULTS = { models: null, settings: { article: null } } as const
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
    catalogRecipe: null,
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

function partialFor(records: Array<{ index: number; state: PartialRecord['state'] }>): PartialResult {
  return {
    strategy: 'CATALOG', startedAtPage: 1, discovered: records.length,
    finished: records.filter((each) => each.state === 'finished').length,
    records: records.map(({ index, state }): PartialRecord => ({
      index, label: String(index + 1), page: 1, state,
      record: state === 'queued' || state === 'reading' ? null : { title: `Record ${index + 1}` },
      values: state === 'queued' || state === 'reading' ? {} : {
        '["title"]': { value: `Record ${index + 1}`, state: state === 'finished' ? 'grounded' : 'checking' },
      },
      evidenceLinks: [],
    })),
    document: null,
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
  it.each(['QUEUED','RUNNING','PAUSING','PAUSED','STOPPING','STOPPED','FAILED','COMPLETED'] as const)(
    'leaves native %s review reads and reloads to the durable actor', async (executionStatus) => {
      const native=jobAttempt({durable:true,executionStatus})
      const {result}=renderHook(()=>useExtraction(options(native)))
      await act(async()=>{})
      act(()=>result.current.review.reload())
      await act(async()=>{})
      expect(api.readExtraction).not.toHaveBeenCalled()
      expect(api.saveExtractionReviewDraft).not.toHaveBeenCalled()
      expect(result.current.review.loading).toBe(false)
    },
  )

  it('switches native Extractions on the same source and fences the previous observer', () => {
    const first = jobAttempt({durable:true,executionStatus:'PAUSING'})
    const second = jobAttempt({durable:true,extractionId:'55555555-5555-4555-8555-555555555555',executionStatus:'PAUSED'})
    const {result,rerender}=renderHook(({initialAttempt})=>useExtraction({...options(initialAttempt),documentKey:representationId}),
      {initialProps:{initialAttempt:first}})
    act(()=>result.current.acceptDurableStatus(first.extractionId,'PAUSING'))
    rerender({initialAttempt:second})
    expect(result.current.attempt?.extractionId).toBe(second.extractionId)
    expect(result.current.state).toEqual({status:'retained',executionStatus:'PAUSED'})
    act(()=>result.current.acceptDurableStatus(first.extractionId,'STOPPED'))
    expect(result.current.state).toEqual({status:'retained',executionStatus:'PAUSED'})
  })

  it('does not replace locally observed native status when admission metadata catches up', () => {
    const first = jobAttempt({durable:true,executionStatus:'QUEUED'})
    const {result,rerender}=renderHook(({initialAttempt})=>useExtraction({...options(initialAttempt),documentKey:representationId}),
      {initialProps:{initialAttempt:first}})
    act(()=>result.current.acceptDurableStatus(first.extractionId,'PAUSED'))
    rerender({initialAttempt:{...first,executionStatus:'RUNNING'}})
    expect(result.current.state).toEqual({status:'retained',executionStatus:'PAUSED'})
  })

  it('drops a previous same-source status read after explicit Extraction navigation', async () => {
    vi.useFakeTimers()
    try {
      const first=jobAttempt({durable:true})
      const second=jobAttempt({durable:true,extractionId:'55555555-5555-4555-8555-555555555555',executionStatus:'PAUSED'})
      const read=Promise.withResolvers<Awaited<ReturnType<typeof api.readExtraction>>>()
      vi.mocked(api.readExtraction).mockReturnValueOnce(read.promise)
      const {result,rerender}=renderHook(({initialAttempt})=>useExtraction({...options(initialAttempt),documentKey:representationId}),
        {initialProps:{initialAttempt:first}})
      await act(()=>vi.advanceTimersByTimeAsync(2000))
      expect(api.readExtraction).toHaveBeenCalledOnce()
      rerender({initialAttempt:second})
      expect(vi.mocked(api.readExtraction).mock.calls[0]![1]!.aborted).toBe(true)
      await act(async()=>read.resolve({extraction:{...first,executionStatus:'COMPLETED'},pendingReviewDecisions:null}))
      expect(result.current.attempt?.extractionId).toBe(second.extractionId)
      expect(result.current.state).toEqual({status:'retained',executionStatus:'PAUSED'})
    } finally {vi.useRealTimers()}
  })

  it('distinguishes a version-zero draft from an acknowledged server draft', async () => {
    const decision: ReviewDecisionInput = {
      resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED', reviewedValue: null,
    }
    const original = attempt({ evidenceLinks: [{ resultPath: decision.resultPath, evidenceAnchorId: 'anchor-1' }] })
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: original, pendingReviewDecisions: [decision],
      reviewDraft: { version: 0, decisions: [decision] } })
    const { result } = renderHook(() => useExtraction(options(original)))
    await waitFor(() => expect(result.current.review.requiredCount).toBe(1))
    expect(result.current.review.untouchedCount).toBe(0)
    expect(result.current.review.canAccept).toBe(true)
    expect(result.current.review.draftSaved).toBe(false)
    expect(api.saveExtractionReviewDraft).not.toHaveBeenCalled()
  })

  it('reports a draft saved only after acknowledgement and clears that status on document changes', async () => {
    const decision: ReviewDecisionInput = {
      resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED', reviewedValue: null,
    }
    const original = attempt({ evidenceLinks: [{ resultPath: decision.resultPath, evidenceAnchorId: 'anchor-1' }] })
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: original, pendingReviewDecisions: [decision] })
    const write = Promise.withResolvers<Awaited<ReturnType<typeof api.saveExtractionReviewDraft>>>()
    vi.mocked(api.saveExtractionReviewDraft).mockReturnValueOnce(write.promise)
    const { result, rerender } = renderHook(({ documentKey }) => useExtraction({ ...options(original), documentKey }),
      { initialProps: { documentKey: 'first' } })
    await waitFor(() => expect(result.current.review.requiredCount).toBe(1))
    expect(result.current.review.draftSaved).toBe(false)
    act(() => result.current.review.setDecision(decision.resultPath, 'REJECTED'))
    expect(result.current.review.untouchedCount).toBe(0)
    expect(result.current.review.draftSaving).toBe(true)
    expect(result.current.review.draftSaved).toBe(false)
    await act(async () => write.resolve({ version: 1, decisions: [{ ...decision, action: 'REJECTED' }] }))
    expect(result.current.review.draftSaving).toBe(false)
    expect(result.current.review.draftSaved).toBe(true)
    rerender({ documentKey: 'second' })
    await waitFor(() => expect(result.current.review.loading).toBe(false))
    expect(result.current.review.draftSaved).toBe(false)
  })

  it('does not mark a failed draft saved, or leak a late acknowledgement into a different document', async () => {
    const decision: ReviewDecisionInput = {
      resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED', reviewedValue: null,
    }
    const original = attempt({ evidenceLinks: [{ resultPath: decision.resultPath, evidenceAnchorId: 'anchor-1' }] })
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: original, pendingReviewDecisions: [decision] })
    vi.mocked(api.saveExtractionReviewDraft).mockRejectedValueOnce(new Error('Offline'))
    const { result, rerender } = renderHook(({ documentKey }) => useExtraction({ ...options(original), documentKey }),
      { initialProps: { documentKey: 'first' } })
    await waitFor(() => expect(result.current.review.requiredCount).toBe(1))
    act(() => result.current.review.setDecision(decision.resultPath, 'REJECTED'))
    await waitFor(() => expect(result.current.review.draftError).toBe('Offline'))
    expect(result.current.review.draftSaved).toBe(false)
    const retry = Promise.withResolvers<Awaited<ReturnType<typeof api.saveExtractionReviewDraft>>>()
    vi.mocked(api.saveExtractionReviewDraft).mockReturnValueOnce(retry.promise)
    act(() => result.current.review.retryDraft())
    rerender({ documentKey: 'second' })
    await waitFor(() => expect(result.current.review.requiredCount).toBe(1))
    await act(async () => retry.resolve({ version: 1, decisions: [{ ...decision, action: 'REJECTED' }] }))
    expect(result.current.review.draftSaved).toBe(false)
    expect(result.current.review.untouchedCount).toBe(1)
  })

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
    expect(restored.result.current.review.draftSaved).toBe(true)
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
    let request!: Promise<boolean>
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

  it('polls a queued job through retained partials to completion, where the settled result wins', async () => {
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
    const reading = partialFor([{ index: 0, state: 'finished' }, { index: 1, state: 'reading' }])
    const regressed = partialFor([{ index: 0, state: 'checking' }, { index: 1, state: 'finished' }])
    vi.mocked(api.requestExtraction).mockResolvedValue(queued)
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null, partial: reading })
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null })
      .mockResolvedValueOnce({ extraction: provisional, pendingReviewDecisions: null, partial: regressed })
      .mockResolvedValueOnce({ extraction: attempt({ resultPayload: { records: [] } }), pendingReviewDecisions: [], partial: reading })
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    let run!: Promise<ExtractionAttempt | null | undefined>
    act(() => { run = result.current.runExtraction(SERVICE_DEFAULTS) })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    // The state alone also fits the initial QUEUED attempt; the status proves the first read was applied.
    expect(result.current.attempt?.executionStatus).toBe('RUNNING')
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: reading })
    expect(result.current.review.available).toBe(false)

    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: reading })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.state.status === 'running' && result.current.state.partial?.records.map((each) => each.state))
      .toEqual(['finished', 'finished'])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
      await run
    })
    expect(result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(result.current.state.status).toBe('ready')
    expect(result.current.state).not.toHaveProperty('partial')
    expect(result.current.state.status === 'ready' && result.current.state.result).toEqual({ records: [] })
    expect(input.onTerminal).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })

  it('a restored running Extraction shows its partial from the first read', async () => {
    vi.useFakeTimers()
    const restored = jobAttempt()
    const reading = partialFor([{ index: 0, state: 'reading' }])
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: restored, pendingReviewDecisions: null, partial: reading })
    const { result, unmount } = renderHook(() => useExtraction(options(restored)))
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: null })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: reading })
    unmount()
    vi.useRealTimers()
  })

  it('a reconnect keeps the last partial when its first read brings no progress', async () => {
    vi.useFakeTimers()
    const restored = jobAttempt()
    const shown = partialFor([{ index: 5, state: 'finished' }])
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: restored, pendingReviewDecisions: null, partial: shown })
      .mockRejectedValueOnce(new ApiRequestError('Service Unavailable', 503))
      .mockResolvedValueOnce({ extraction: restored, pendingReviewDecisions: null })
    const { result, unmount } = renderHook(() => useExtraction(options(restored)))
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED)
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: shown })
    act(() => result.current.reconnect())
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(result.current.monitorError).toBeNull()
    expect(result.current.state).toEqual({ status: 'running', step: 'extraction', partial: shown })
    unmount()
    vi.useRealTimers()
  })

  it('a run names the page being read, and omits the page when none is known', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(jobAttempt({ executionStatus: 'QUEUED' }))
    const first = renderHook(() => useExtraction(options()))
    await act(() => first.result.current.runExtraction(SERVICE_DEFAULTS, undefined, 'ARTICLE', null, 6))
    expect(vi.mocked(api.requestExtraction).mock.calls[0]![0]).toEqual(expect.objectContaining({ startPage: 6 }))
    first.unmount()
    const second = renderHook(() => useExtraction(options()))
    await act(() => second.result.current.runExtraction(SERVICE_DEFAULTS))
    expect(vi.mocked(api.requestExtraction).mock.calls[1]![0]).not.toHaveProperty('startPage')
    second.unmount()
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
      partial: PartialResult
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
      response.resolve({ extraction: restored, pendingReviewDecisions: [], partial: partialFor([{ index: 5, state: 'finished' }]) })
      await Promise.resolve()
    })

    expect(hook.result.current.attempt?.extractionId).toBe(replacement.extractionId)
    expect(hook.result.current.state).not.toHaveProperty('partial')
    expect(onTerminal).not.toHaveBeenCalled()
    hook.unmount()
    vi.useRealTimers()
  })

  it('posts only new identity pins and presents the persisted attempt', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(attempt())
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

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

    await act(() => result.current.runExtraction({ models: null, settings: { generic: null } }, undefined, 'CATALOG'))

    expect(api.requestExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: 'CATALOG' }),
      expect.any(AbortSignal),
    )
    expect(result.current.attempt?.strategy).toBe('CATALOG')
  })

  it('sends the saved method it is given, and no Extraction Model Choice beside it', async () => {
    vi.mocked(api.requestExtraction).mockResolvedValue(attempt({ requestedModels: { reasoning: 'instruct' } }))
    const { result } = renderHook(() => useExtraction(options()))

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS, undefined, 'ARTICLE', null))

    expect(api.requestExtraction).toHaveBeenCalledWith(
      expect.objectContaining({ method: SERVICE_DEFAULTS }),
      expect.any(AbortSignal),
    )
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

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS, acknowledgedTarget))

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
      void result.current.runExtraction(SERVICE_DEFAULTS)
      void result.current.runExtraction(SERVICE_DEFAULTS)
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

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))
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

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))
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

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

    expect(result.current.monitorError).toBe(EXTRACTION_UNAVAILABLE)
    expect(result.current.state.status).toBe('running')
    expect(input.onError).not.toHaveBeenCalled()
    expect(api.requestExtraction).toHaveBeenCalledOnce()
  })

  it('fails immediately when the server definitely rejects the POST', async () => {
    vi.mocked(api.requestExtraction).mockRejectedValue(new ApiRequestError('conflict', 409))
    const input = options()
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

    expect(result.current.state).toEqual({ status: 'error', message: 'conflict' })
    expect(input.onError).toHaveBeenCalledWith('conflict')
    expect(api.readExtraction).not.toHaveBeenCalled()
  })

  it('a run refused as superseded keeps the earlier results and asks the page to refresh the document', async () => {
    const message = 'This document has been reprocessed. No new Extraction was started.'
    const actual = await vi.importActual<typeof import('./api')>('./api')
    vi.mocked(api.requestExtraction).mockImplementation(actual.requestExtraction)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json(
      { error: { code: 'source_representation_superseded', message } },
      { status: 409 },
    ))))
    try {
      const earlier = attempt()
      vi.mocked(api.readExtraction).mockResolvedValue({ extraction: earlier, pendingReviewDecisions: [] })
      const input = { ...options(earlier), onSuperseded: vi.fn() }
      const { result } = renderHook(() => useExtraction(input))
      const shown = result.current.state
      await waitFor(() => expect(result.current.review.canAccept).toBe(true))
      const readsBefore = vi.mocked(api.readExtraction).mock.calls.length

      await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

      expect(result.current.attempt).toBe(earlier)
      expect(result.current.state).toEqual(shown)
      expect(result.current.hasResults).toBe(true)
      // Nothing failed: the page explains the refusal through onSuperseded alone.
      expect(input.onError).not.toHaveBeenCalled()
      expect(input.onSuperseded).toHaveBeenCalledOnce()
      expect(input.onTerminal).not.toHaveBeenCalled()
      expect(api.readExtraction).toHaveBeenCalledTimes(readsBefore)
      expect(result.current.canRun).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('a superseded refusal of a run started over a paused monitor restores the kept attempt, not the paused run', async () => {
    vi.mocked(api.requestExtraction).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(api.readExtraction).mockRejectedValue(new TypeError('Failed to fetch'))
    const earlier = attempt()
    const input = { ...options(earlier), onSuperseded: vi.fn() }
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))
    expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED)
    expect(result.current.state.status).toBe('running')

    vi.mocked(api.requestExtraction).mockRejectedValueOnce(
      new ApiRequestError('source_representation_superseded: Reprocessed.', 409, 'source_representation_superseded'),
    )
    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

    expect(input.onSuperseded).toHaveBeenCalledOnce()
    expect(result.current.attempt).toBe(earlier)
    expect(result.current.state.status).toBe('ready')
    expect(result.current.hasResults).toBe(true)
  })

  it('a method_changed refusal starts nothing, keeps the previous attempt and reports to the start view, not as an error', async () => {
    const message = 'Your saved advanced settings changed after this summary was shown. Nothing was started; review the updated summary and start again.'
    vi.mocked(api.requestExtraction).mockRejectedValueOnce(new ApiRequestError(message, 409, 'method_changed'))
    const earlier = attempt()
    const input = { ...options(earlier), onMethodChanged: vi.fn() }
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

    expect(input.onMethodChanged).toHaveBeenCalledExactlyOnceWith(message, 'method_changed')
    expect(input.onError).not.toHaveBeenCalled()
    expect(api.requestExtraction).toHaveBeenCalledOnce()
    expect(result.current.attempt).toBe(earlier)
    expect(result.current.state.status).toBe('ready')
  })

  it('reports a refusal in the server\'s own words, without the code the request error prefixes', async () => {
    const message = 'The schema is saved as a Catalog; refresh to run it.'
    vi.mocked(api.requestExtraction).mockRejectedValueOnce(
      new ApiRequestError(`record_scope_mismatch: ${message}`, 409, 'record_scope_mismatch'),
    )
    const input = { ...options(attempt()), onMethodChanged: vi.fn() }
    const { result } = renderHook(() => useExtraction(input))

    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

    expect(input.onMethodChanged).toHaveBeenCalledExactlyOnceWith(message, 'record_scope_mismatch')
  })

  it('offers no cancellation until the server has acknowledged the run', async () => {
    const post = Promise.withResolvers<ExtractionAttempt>()
    vi.mocked(api.requestExtraction).mockReturnValue(post.promise)
    vi.mocked(api.readExtraction).mockReturnValue(new Promise(() => {}))
    vi.mocked(api.cancelExtraction).mockResolvedValue(undefined)
    const { result } = renderHook(() => useExtraction(options(attempt())))

    act(() => void result.current.runExtraction(SERVICE_DEFAULTS))
    expect(result.current.state.status).toBe('running')
    await act(() => result.current.requestCancellation())
    expect(api.cancelExtraction).not.toHaveBeenCalled()
    expect(result.current.cancellationRequested).toBe(false)
    expect(vi.mocked(api.requestExtraction).mock.calls[0][1]?.aborted).toBe(false)

    const admitted = jobAttempt({ extractionId: vi.mocked(api.requestExtraction).mock.calls[0][0].id, executionStatus: 'QUEUED' })
    await act(async () => post.resolve(admitted))
    await act(() => result.current.requestCancellation())
    expect(api.cancelExtraction).toHaveBeenCalledExactlyOnceWith(admitted.extractionId)
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

  it('allows explicitly finalizing a loaded review with zero required grounded decisions', async () => {
    const original = attempt()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: original, pendingReviewDecisions: [] })
    vi.mocked(api.finalizeExtractionReview).mockResolvedValue({ ...original, reviewedAt: '2026-09-30T00:00:00Z' })
    const { result } = renderHook(() => useExtraction(options(original)))
    expect(result.current.review.available).toBe(true)
    expect(result.current.review.canAccept).toBe(false)
    await waitFor(() => expect(result.current.review.canAccept).toBe(true))
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
    await act(() => result.current.review.accept())
    expect(api.finalizeExtractionReview).toHaveBeenCalledWith(original.extractionId, [], 0)
  })

  it('counts only grounded decisions in a mixed review, while retaining optional values', async () => {
    const grounded: ReviewDecisionInput = {
      resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'], action: 'APPROVED', reviewedValue: null,
    }
    const optional: ReviewDecisionInput = {
      resultPath: ['records', 0, 'year'], evidenceAnchorId: null,
      reviewedOccurrenceIds: [], action: 'APPROVED', reviewedValue: null,
    }
    const original = attempt({ evidenceLinks: [{ resultPath: grounded.resultPath, evidenceAnchorId: 'anchor-1' }] })
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: original, pendingReviewDecisions: [grounded, optional] })
    const { result } = renderHook(() => useExtraction(options(original)))
    await waitFor(() => expect(result.current.review.decisions).toHaveLength(2))
    expect(result.current.review.requiredCount).toBe(1)
    expect(result.current.review.untouchedCount).toBe(1)
    act(() => result.current.review.setDecision(grounded.resultPath, 'REJECTED'))
    expect(result.current.review.requiredCount).toBe(1)
    expect(result.current.review.untouchedCount).toBe(0)
    expect(result.current.review.isTouched(optional.resultPath)).toBe(false)
  })

  it('keeps an ungrounded-only value visible and permits an optional Evidence correction', async () => {
    const original = attempt({
        complete: false,
        resultPayload: { records: [{ title: 'ungrounded' }] },
        diagnostics: {
          ...attempt().diagnostics!,
          grounding: {
            groundedPaths: [],
            ungroundedPaths: [['records', 0, 'title']],
            issueCodes: ['missing_claim'],
            batches: [],
            claims: null,
          },
        },
      })
    const pending: ReviewDecisionInput = { resultPath: ['records', 0, 'title'], evidenceAnchorId: null,
      reviewedOccurrenceIds: [], action: 'APPROVED', reviewedValue: null }
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: original, pendingReviewDecisions: [pending] })
    const { result } = renderHook(() => useExtraction(options(original)))
    await waitFor(() => expect(result.current.review.decisions).toHaveLength(1))
    expect(result.current.review.available).toBe(true)
    expect(result.current.review.requiredCount).toBe(0)
    expect(result.current.review.untouchedCount).toBe(0)
    expect(result.current.review.isTouched(pending.resultPath)).toBe(false)
    const evidence = [{ evidenceAnchorId: 'canonical', reviewedOccurrenceIds: ['occurrence'] }]
    act(() => result.current.review.setDecision(pending.resultPath, 'EDITED', 'corrected', evidence))
    await waitFor(() => expect(api.saveExtractionReviewDraft).toHaveBeenCalledWith(original.extractionId,
      [{ ...pending, action: 'EDITED', reviewedValue: 'corrected', reviewedEvidence: evidence }], 0))
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

  it('answers which decision is the last, and saves only when the researcher asks, in the same handler (§6)', async () => {
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded', author: 'A. Researcher' }] },
      evidenceLinks: [
        { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' },
        { resultPath: ['records', 0, 'author'], evidenceAnchorId: 'anchor-2' },
      ],
    })
    const pending = (['title', 'author'] as const).map((field, index) => ({
      resultPath: ['records', 0, field], evidenceAnchorId: `anchor-${index + 1}`,
      reviewedOccurrenceIds: [`occurrence-${index + 1}`], action: 'APPROVED' as const, reviewedValue: null,
    }))
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: unreviewed, pendingReviewDecisions: pending })
    vi.mocked(api.finalizeExtractionReview).mockResolvedValue(attempt({ ...unreviewed, reviewedAt: '2026-10-04T00:00:00Z' }))
    const { result } = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(result.current.review.decisions).toHaveLength(2))

    expect(result.current.review.setDecision(['records', 9, 'title'], 'APPROVED')).toEqual({ last: false })
    let answer: { last: boolean } | undefined
    act(() => { answer = result.current.review.setDecision(['records', 0, 'title'], 'REJECTED') })
    expect(answer).toEqual({ last: false })
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
    await act(async () => {
      answer = result.current.review.setDecision(['records', 0, 'author'], 'APPROVED')
      if (answer.last) await result.current.review.accept()
    })
    expect(answer).toEqual({ last: true })
    expect(api.finalizeExtractionReview).toHaveBeenCalledOnce()
    expect(vi.mocked(api.finalizeExtractionReview).mock.calls[0]![1]).toHaveLength(2)
  })

  it('never saves a recovered complete draft by itself; it waits for the researcher (§6)', async () => {
    const unreviewed = attempt({
      resultPayload: { records: [{ title: 'Grounded' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }],
    })
    const decision = { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'], action: 'REJECTED' as const, reviewedValue: null }
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: unreviewed, pendingReviewDecisions: [{ ...decision, action: 'APPROVED' }],
      reviewDraft: { version: 2, decisions: [decision] } })
    const { result } = renderHook(() => useExtraction(options(unreviewed)))
    await waitFor(() => expect(result.current.review.canAccept).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
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
    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))

    expect(api.requestExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
      }),
      expect.any(AbortSignal),
    )
  })
})

describe('review while the run reads (ADR 0016; results review redesign §5)', () => {
  const occurrenceIdsByAnchor = new Map([['anchor-0', ['occurrence-0']], ['anchor-1', ['occurrence-1']]])
  const titles = ['Record 1', 'Record 2']
  function reading(states: Array<PartialRecord['state']>): PartialResult {
    return {
      strategy: 'CATALOG', startedAtPage: 1, discovered: states.length, finished: states.filter((state) => state === 'finished').length,
      records: states.map((state, index): PartialRecord => ({
        index, label: titles[index]!, page: 1, state,
        record: state === 'finished' ? { title: titles[index] } : null,
        values: state === 'finished' ? { '["title"]': { value: titles[index], state: 'grounded' } } : {},
        evidenceLinks: state === 'finished' ? [{ resultPath: ['records', index, 'title'], evidenceAnchorId: `anchor-${index}` }] : [],
      })),
      document: null,
    }
  }
  const decision = (index: number, action: ReviewDecisionInput['action'] = 'APPROVED'): ReviewDecisionInput => ({
    resultPath: ['records', index, 'title'], evidenceAnchorId: `anchor-${index}`, reviewedOccurrenceIds: [`occurrence-${index}`],
    action, reviewedValue: null,
  })
  const running = () => jobAttempt({ strategy: 'CATALOG' })
  const hook = (initial: ExtractionAttempt) => renderHook(() => useExtraction({ ...options(initial), occurrenceIdsByAnchor }))
  const poll = () => act(() => vi.advanceTimersByTimeAsync(2_000))
  const flush = () => act(() => vi.advanceTimersByTimeAsync(0))
  afterEach(() => { vi.useRealTimers() })

  it('drafts a decision on a finished record; a later poll adds new records and never reverts it', async () => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: running(), pendingReviewDecisions: null, partial: reading(['finished', 'reading']), reviewDraft: { version: 2, decisions: [] } })
      .mockResolvedValue({ extraction: running(), pendingReviewDecisions: null, partial: reading(['finished', 'finished']), reviewDraft: { version: 2, decisions: [] } })
    const { result, unmount } = hook(running())
    await poll()
    expect(result.current.review.draftAvailable).toBe(true)
    expect(result.current.review.available).toBe(false)
    expect(result.current.review.decisions).toEqual([decision(0)])
    let answer: { last: boolean } | undefined
    act(() => { answer = result.current.review.setDecision(['records', 0, 'title'], 'REJECTED') })
    expect(answer).toEqual({ last: false }) // nothing saves the review while the run goes on
    expect(result.current.review.canAccept).toBe(false)
    expect(api.saveExtractionReviewDraft).toHaveBeenCalledWith(running().extractionId, [decision(0, 'REJECTED')], 2)
    await poll()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED'), decision(1)])
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(true)
    expect(result.current.review.decidedOn.get(JSON.stringify(['records', 0, 'title']))).toBe('Record 1')
    unmount()
  })

  it('adopts the server draft of a restored run once', async () => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
      partial: reading(['finished', 'reading']), reviewDraft: { version: 5, decisions: [decision(0, 'REJECTED')] } })
    const { result, unmount } = hook(running())
    await poll()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED')])
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(true)
    expect(result.current.review.draftSaved).toBe(true)
    unmount()
  })

  it('restores the running server draft after navigating through a document without an Extraction', async () => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
      partial: reading(['finished']), reviewDraft: { version: 5, decisions: [decision(0, 'REJECTED')] } })
    const { result, rerender, unmount } = renderHook(({ current, documentKey }) =>
      useExtraction({ ...options(current), documentKey, occurrenceIdsByAnchor }),
    { initialProps: { current: running() as ExtractionAttempt | null, documentKey: 'first' } })
    await poll()
    rerender({ current: null, documentKey: 'empty' })
    await flush()
    expect(result.current.review.decisions).toEqual([])
    expect(result.current.review.decidedOn.size).toBe(0)
    rerender({ current: running(), documentKey: 'first' })
    await poll()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED')])
    expect(result.current.review.isTouched(decision(0).resultPath)).toBe(true)
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'APPROVED') })
    expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(running().extractionId, [decision(0)], 5)
    unmount()
  })

  it('reloads a conflicting running server draft and resumes writes with its version', async () => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: running(), pendingReviewDecisions: null,
        partial: reading(['finished']), reviewDraft: { version: 2, decisions: [] } })
      .mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
        partial: reading(['finished']), reviewDraft: { version: 5, decisions: [decision(0)] } })
    vi.mocked(api.saveExtractionReviewDraft).mockRejectedValueOnce(new Error(REVIEW_DRAFT_CONFLICT))
    const { result, unmount } = hook(running())
    await poll()
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'REJECTED') })
    await flush()
    expect(result.current.review.draftError).toBe(REVIEW_DRAFT_CONFLICT)
    act(() => { result.current.review.retryDraft() })
    await flush()
    expect(result.current.review.draftError).toBeNull()
    expect(result.current.review.decisions).toEqual([decision(0)])
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'REJECTED') })
    expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(running().extractionId, [decision(0, 'REJECTED')], 5)
    unmount()
  })

  it('adopts the changed running server draft on reconnect', async () => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: running(), pendingReviewDecisions: null,
        partial: reading(['finished']), reviewDraft: { version: 2, decisions: [] } })
      .mockRejectedValueOnce(new ApiRequestError('Service Unavailable', 503))
      .mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
        partial: reading(['finished']), reviewDraft: { version: 5, decisions: [decision(0, 'REJECTED')] } })
    const { result, unmount } = hook(running())
    await poll()
    await poll()
    expect(result.current.monitorError).toBe(MONITOR_DISCONNECTED)
    act(() => { result.current.reconnect() })
    await flush()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED')])
    expect(result.current.review.isTouched(decision(0).resultPath)).toBe(true)
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'APPROVED') })
    expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(running().extractionId, [decision(0)], 5)
    unmount()
  })

  it.each([2, 5])('preserves a failed local write on reconnect against server version %s', async (version) => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction)
      .mockResolvedValueOnce({ extraction: running(), pendingReviewDecisions: null,
        partial: reading(['finished']), reviewDraft: { version: 2, decisions: [] } })
      .mockRejectedValueOnce(new ApiRequestError('Service Unavailable', 503))
      .mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
        partial: reading(['finished']), reviewDraft: { version, decisions: [decision(0)] } })
    vi.mocked(api.saveExtractionReviewDraft).mockRejectedValueOnce(new Error('Offline'))
    const { result, unmount } = hook(running())
    await poll()
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'REJECTED') })
    await flush()
    expect(result.current.review.draftError).toBe('Offline')
    await poll()
    act(() => { result.current.reconnect() })
    await flush()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED')])
    if (version === 2) {
      expect(api.saveExtractionReviewDraft).toHaveBeenCalledTimes(2)
      expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(running().extractionId, [decision(0, 'REJECTED')], 2)
      expect(result.current.review.draftError).toBeNull()
    } else {
      expect(api.saveExtractionReviewDraft).toHaveBeenCalledTimes(1)
      expect(result.current.review.draftError).toBe(REVIEW_DRAFT_CONFLICT)
    }
    unmount()
  })

  it('keeps an explicit running reload alive across a normal monitor poll', async () => {
    vi.useFakeTimers()
    const response = { extraction: running(), pendingReviewDecisions: null,
      partial: reading(['finished']), reviewDraft: { version: 5, decisions: [decision(0)] } }
    const reload = Promise.withResolvers<Awaited<ReturnType<typeof api.readExtraction>>>()
    vi.mocked(api.readExtraction).mockResolvedValueOnce({ ...response, reviewDraft: { version: 2, decisions: [] } })
      .mockReturnValueOnce(reload.promise).mockImplementation(async () => ({ ...response, extraction: running() }))
    const { result, unmount } = hook(running())
    await poll()
    act(() => { result.current.review.reload() })
    await flush()
    expect(result.current.review.loading).toBe(true)
    await poll()
    expect(result.current.review.loading).toBe(true)
    await act(async () => { reload.resolve(response) })
    await flush()
    expect(result.current.review.loading).toBe(false)
    expect(result.current.review.decisions).toEqual([decision(0)])
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'REJECTED') })
    expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(running().extractionId, [decision(0, 'REJECTED')], 5)
    unmount()
  })

  it('keeps a decision made after a reconnect GET began and adopts a fresh draft after its write', async () => {
    vi.useFakeTimers()
    const response = { extraction: running(), pendingReviewDecisions: null,
      partial: reading(['finished']), reviewDraft: { version: 2, decisions: [] } }
    const read = Promise.withResolvers<Awaited<ReturnType<typeof api.readExtraction>>>()
    const write = Promise.withResolvers<Awaited<ReturnType<typeof api.saveExtractionReviewDraft>>>()
    vi.mocked(api.readExtraction).mockResolvedValueOnce(response)
      .mockRejectedValueOnce(new ApiRequestError('Service Unavailable', 503))
      .mockReturnValueOnce(read.promise)
      .mockResolvedValue({ ...response, reviewDraft: { version: 3, decisions: [decision(0, 'REJECTED')] } })
    vi.mocked(api.saveExtractionReviewDraft).mockReturnValueOnce(write.promise)
    const { result, unmount } = hook(running())
    await poll()
    await poll()
    act(() => { result.current.reconnect() })
    await flush()
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'REJECTED') })
    await act(async () => { read.resolve(response) })
    await flush()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED')])
    expect(result.current.review.draftSaving).toBe(true)
    await act(async () => { write.resolve({ version: 3, decisions: [decision(0, 'REJECTED')] }) })
    await poll()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED')])
    expect(result.current.review.draftSaved).toBe(true)
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'APPROVED') })
    expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(running().extractionId, [decision(0)], 3)
    unmount()
  })

  it('adopts a running draft when polling first acknowledges a run whose start response was lost', async () => {
    vi.useFakeTimers()
    vi.mocked(api.requestExtraction).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
      partial: reading(['finished']), reviewDraft: { version: 5, decisions: [decision(0, 'REJECTED')] } })
    const { result, unmount } = renderHook(() => useExtraction({ ...options(), occurrenceIdsByAnchor }))
    await act(async () => { await result.current.runExtraction(SERVICE_DEFAULTS, undefined, 'CATALOG') })
    await flush()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED')])
    expect(result.current.review.isTouched(decision(0).resultPath)).toBe(true)
    act(() => { result.current.review.setDecision(decision(0).resultPath, 'APPROVED') })
    expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(running().extractionId, [decision(0)], 5)
    unmount()
  })

  it('reverts a decision the server refuses during the run and says why', async () => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
      partial: reading(['finished']), reviewDraft: { version: 0, decisions: [] } })
    vi.mocked(api.saveExtractionReviewDraft).mockRejectedValueOnce(
      new ApiRequestError('invalid_review: Draft decisions do not match the pinned document and schema.', 422, 'invalid_review'))
    const { result, unmount } = hook(running())
    await poll()
    act(() => { result.current.review.setDecision(['records', 0, 'title'], 'APPROVED') })
    await flush()
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(false)
    expect(result.current.review.draftRefused).toBe('This value can’t be reviewed: its Evidence is not in this document.')
    expect(result.current.review.draftError).toBeNull()
    unmount()
  })

  it('a refusal right after adopting a restored run reverts to the adopted draft', async () => {
    vi.useFakeTimers()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: running(), pendingReviewDecisions: null,
      partial: reading(['finished', 'finished']), reviewDraft: { version: 3, decisions: [decision(0, 'REJECTED')] } })
    vi.mocked(api.saveExtractionReviewDraft).mockRejectedValueOnce(new ApiRequestError('invalid_review: refused', 422, 'invalid_review'))
    const { result, unmount } = hook(running())
    await poll()
    act(() => { result.current.review.setDecision(['records', 1, 'title'], 'REJECTED') })
    await flush()
    expect(result.current.review.decisions).toEqual([decision(0, 'REJECTED'), decision(1)])
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(true)
    expect(result.current.review.isTouched(['records', 1, 'title'])).toBe(false)
    unmount()
  })

  it('at settlement keeps a decision whose value held, returns a changed one to To check, and never saves', async () => {
    vi.useFakeTimers()
    const settled = attempt({ ...running(), executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', reviewable: true, complete: true,
      resultPayload: { records: [{ title: 'Record 1' }, { title: 'Changed' }] },
      evidenceLinks: [0, 1].map((index) => ({ resultPath: ['records', index, 'title'], evidenceAnchorId: `anchor-${index}` })) })
    let reads = 0
    vi.mocked(api.readExtraction).mockImplementation(async () => (reads++ === 0
      ? { extraction: running(), pendingReviewDecisions: null, partial: reading(['finished', 'finished']), reviewDraft: { version: 0, decisions: [] } }
      : { extraction: settled, pendingReviewDecisions: [decision(0), decision(1)],
          reviewDraft: { version: 2, decisions: [decision(0, 'REJECTED'), decision(1, 'REJECTED')] } }))
    const { result, unmount } = hook(running())
    await poll()
    act(() => { result.current.review.setDecision(['records', 0, 'title'], 'REJECTED') })
    act(() => { result.current.review.setDecision(['records', 1, 'title'], 'REJECTED') })
    await poll()
    await flush()
    await flush()
    expect(result.current.attempt?.executionStatus).toBe('COMPLETED')
    expect(result.current.review.settlement).toEqual({ kept: 1, changed: 1 })
    expect([...result.current.review.changedAfterReview]).toEqual([JSON.stringify(['records', 1, 'title'])])
    expect(result.current.review.isTouched(['records', 0, 'title'])).toBe(true)
    expect(result.current.review.isTouched(['records', 1, 'title'])).toBe(false)
    expect(result.current.review.decisions[1]).toEqual(decision(1))
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
    unmount()
  })

  it('a watched run without drafted decisions still reports its settlement, once its review is loaded', async () => {
    vi.useFakeTimers()
    const settled = attempt({ ...running(), executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', reviewable: true, complete: true,
      resultPayload: { records: [{ title: 'Record 1' }] }, evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-0' }] })
    let reads = 0
    vi.mocked(api.readExtraction).mockImplementation(async () => (reads++ === 0
      ? { extraction: running(), pendingReviewDecisions: null, partial: null }
      : { extraction: settled, pendingReviewDecisions: [decision(0)], reviewDraft: { version: 0, decisions: [] } }))
    const { result, unmount } = hook(running())
    await poll()
    expect(result.current.review.settlement).toBeNull()
    await poll()
    await flush()
    await flush()
    expect(result.current.review.settlement).toEqual({ kept: 0, changed: 0 })
    unmount()
  })

  it('reports settlement when the first poll of a watched run is already terminal', async () => {
    vi.useFakeTimers()
    const settled = attempt({ resultPayload: { records: [{ title: 'Record 1' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-0' }] })
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: settled,
      pendingReviewDecisions: [decision(0)], reviewDraft: { version: 0, decisions: [] } })
    const { result, unmount } = hook(running())
    await poll()
    await flush()
    await flush()
    expect(result.current.review.settlement).toEqual({ kept: 0, changed: 0 })
    unmount()
  })

  it('reports settlement when a requested run completes before admission is acknowledged', async () => {
    vi.useFakeTimers()
    const settled = attempt({ resultPayload: { records: [{ title: 'Record 1' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-0' }] })
    vi.mocked(api.requestExtraction).mockImplementation(async ({ id }) => ({ ...settled, extractionId: id }))
    vi.mocked(api.readExtraction).mockImplementation(async (id) => ({ extraction: { ...settled, extractionId: id },
      pendingReviewDecisions: [decision(0)], reviewDraft: { version: 0, decisions: [] } }))
    const { result, unmount } = renderHook(() => useExtraction(options()))
    await act(() => result.current.runExtraction(SERVICE_DEFAULTS))
    await flush()
    await flush()
    expect(result.current.review.settlement).toEqual({ kept: 0, changed: 0 })
    unmount()
  })

  it('a stopped run discards its draft and says how many decisions went with it', async () => {
    vi.useFakeTimers()
    const stopped = jobAttempt({ strategy: 'CATALOG', executionStatus: 'FAILED',
      failure: { code: 'cancelled', message: 'The Extraction was cancelled.' } })
    let reads = 0
    vi.mocked(api.readExtraction).mockImplementation(async () => (reads++ === 0
      ? { extraction: running(), pendingReviewDecisions: null, partial: reading(['finished']), reviewDraft: { version: 0, decisions: [] } }
      : { extraction: stopped, pendingReviewDecisions: null }))
    const { result, unmount } = hook(running())
    await poll()
    act(() => { result.current.review.setDecision(['records', 0, 'title'], 'APPROVED') })
    await poll()
    await flush()
    expect(result.current.state.status).toBe('cancelled')
    expect(result.current.review.discarded).toBe(1)
    expect(result.current.review.decisions).toEqual([])
    unmount()
  })
})
