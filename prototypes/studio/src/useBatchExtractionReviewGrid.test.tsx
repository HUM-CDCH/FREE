// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  projectedRecords,
  valuesAtColumn,
  decisionMatchesColumn,
  useBatchExtractionReviewGrid,
} from './useBatchExtractionReviewGrid'
import { resultPathKey } from './reviewDecisions'
import * as api from './api'
import Grid from './projectContexts/BatchExtractionReviewGrid'
import ResultsTab from './ResultsTab'
import { useExtraction } from './useExtraction'
import { captureSessionRecovery, clearSessionRecovery, setSessionRecoveryAccount } from './auth/sessionRecovery'
import { forgetReviewDraft, rememberReviewDraft, REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import type { ReviewDecisionInput } from '../shared/extraction.contract'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import type { ExtractionAttempt } from '../shared/extraction.contract'

vi.mock('./api', () => ({
  readExtraction: vi.fn(),
  finalizeExtractionReview: vi.fn(),
  saveExtractionReviewDraft: vi.fn(),
  resetExtractionReview: vi.fn(),
}))

const schemaNodes = [
  { id: 'title', name: 'title', type: 'string' as const },
  { id: 'year', name: 'year', type: 'integer' as const },
]

const reviewableDocumentId = '51000000-0000-4000-8001-000000000001'
const failedDocumentId = '51000000-0000-4000-8001-000000000002'
const extractionId = '51000000-0000-4000-8006-000000000001'

function attempt(overrides: Partial<ExtractionAttempt> = {}): ExtractionAttempt {
  return {
    extractionId,
    sourceDocumentId: reviewableDocumentId,
    sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
    schemaRevisionId: '51000000-0000-4000-8004-000000000001',
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
    resultPayload: { records: [{ title: 'Grounded', year: 2020 }] },
    evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }],
    reviewable: true,
    batchExtractionId: null,
    createdAt: '2026-08-10T00:00:00.000Z',
    reviewedAt: null,
    reviewDecisions: [],
    ...overrides,
  }
}

const pendingDecisions = [
  {
    resultPath: ['records', 0, 'title'],
    evidenceAnchorId: 'anchor-1',
    reviewedOccurrenceIds: ['occurrence-1'],
    action: 'APPROVED' as const,
    reviewedValue: null,
  },
]

function batch(overrides: Partial<BatchExtraction> = {}): BatchExtraction {
  return {
    batchExtractionId: '51000000-0000-4000-8007-000000000001',
    projectContextId: '51000000-0000-4000-8000-000000000001',
    schemaRevisionId: '51000000-0000-4000-8004-000000000001',
    extractionSchemaId: '51000000-0000-4000-8003-000000000001',
    extractionSchemaName: 'Places',
    schemaRevisionNumber: 1,
    strategy: 'ARTICLE',
    createdAt: '2026-08-14T10:42:00.000Z',
    members: [
      {
        sourceDocumentId: reviewableDocumentId,
        sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
        latestExtraction: {
          extractionId,
          outcome: 'SUCCEEDED',
          complete: true,
          reviewable: true,
          createdAt: '2026-08-14T10:43:00.000Z',
          reviewedAt: null,
          failureMessage: null,
        },
      },
      {
        sourceDocumentId: failedDocumentId,
        sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000002',
        latestExtraction: {
          extractionId: '51000000-0000-4000-8006-000000000002',
          outcome: 'FAILED',
          complete: null,
          reviewable: false,
          createdAt: '2026-08-14T10:44:00.000Z',
          reviewedAt: null,
          failureMessage: 'The provider rejected this document.',
        },
      },
    ],
    ...overrides,
  }
}

const savedDrafts = new Map<string, { version: number; decisions: ReviewDecisionInput[] }>()

beforeEach(() => {
  vi.mocked(api.resetExtractionReview).mockReset()
  vi.mocked(api.resetExtractionReview).mockImplementation(async (_id, version) => ({ version: version + 1, decisions: [] }))
  savedDrafts.clear()
  vi.mocked(api.saveExtractionReviewDraft).mockReset()
  vi.mocked(api.saveExtractionReviewDraft).mockImplementation(async (id, decisions, version) => {
    const saved = { decisions: [...decisions], version: (savedDrafts.get(id)?.version ?? version) + 1 }
    savedDrafts.set(id, saved)
    return saved
  })
  clearSessionRecovery()
  setSessionRecoveryAccount('99999999-9999-4999-8999-999999999999')
  vi.mocked(api.readExtraction).mockReset()
  vi.mocked(api.readExtraction).mockImplementation(async () => ({
    extraction: attempt(), pendingReviewDecisions: pendingDecisions, reviewDraft: savedDrafts.get(extractionId),
  }))
  vi.mocked(api.finalizeExtractionReview).mockReset()
})

afterEach(() => { cleanup(); forgetReviewDraft(extractionId) })

it('Revert all returns a finalized review to pending', async () => {
  const reviewedAt = '2026-09-07T00:00:00Z'
  vi.mocked(api.readExtraction).mockResolvedValue({
    extraction: attempt({ reviewedAt, reviewDecisions: pendingDecisions.map(decision => ({
      ...decision, action: 'EDITED', reviewedValue: 'Reviewed title', createdAt: reviewedAt,
    })) }),
    pendingReviewDecisions: pendingDecisions,
    reviewDraft: { version: 2, decisions: [] },
  })
  const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
  await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
  expect(result.current.canRevert).toBe(true)
  await act(async () => { await result.current.revertAll() })
  expect(api.resetExtractionReview).toHaveBeenCalledWith(extractionId, 2)
  expect(api.saveExtractionReviewDraft).not.toHaveBeenCalled()
  await waitFor(() => {
    const state = result.current.members.get(reviewableDocumentId)
    expect(state?.status === 'ready' && state.editable).toBe(true)
    expect(state?.status === 'ready' && state.touched.size).toBe(0)
    expect(state?.status === 'ready' && state.attempt.reviewedAt).toBeNull()
    expect(state?.status === 'ready' && projectedRecords(state.attempt, state.decisions)).toEqual([{ title: 'Grounded', year: 2020 }])
  })
  vi.mocked(api.finalizeExtractionReview).mockResolvedValue(attempt({
    reviewedAt, reviewDecisions: pendingDecisions.map((decision) => ({ ...decision, createdAt: reviewedAt })),
  }))
  act(() => result.current.approveAll())
  await act(async () => { await result.current.saveMember(reviewableDocumentId) })
  expect(api.finalizeExtractionReview).toHaveBeenCalledWith(extractionId, expect.any(Array), 4)
  await act(async () => { result.current.revertAll() })
  expect(api.resetExtractionReview).toHaveBeenLastCalledWith(extractionId, 5)
})

it('keeps a saved review visible when reset fails and allows retry', async () => {
  const reviewedAt = '2026-09-07T00:00:00Z'
  vi.mocked(api.readExtraction).mockResolvedValue({
    extraction: attempt({ reviewedAt, reviewDecisions: pendingDecisions.map((decision) => ({ ...decision, createdAt: reviewedAt })) }),
    pendingReviewDecisions: pendingDecisions, reviewDraft: { version: 2, decisions: [] },
  })
  vi.mocked(api.resetExtractionReview).mockRejectedValueOnce(new Error('Connection failed'))
  render(<Grid batch={batch()} schemaNodes={schemaNodes} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} />)
  await screen.findByText('100% approved unchanged')
  fireEvent.click(screen.getByRole('button', { name: 'Revert all' }))
  await screen.findByText('Connection failed')
  expect(screen.getByText('100% approved unchanged')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(screen.queryByText('100% approved unchanged')).toBeNull())
  expect(api.resetExtractionReview).toHaveBeenCalledTimes(2)
})

describe('useBatchExtractionReviewGrid', () => {
  it.each(['grid', 'document'] as const)('retains recovered conflicts in %s until explicitly reloading server state', async (view) => {
    const local = [{ ...pendingDecisions[0], action: 'REJECTED' as const }]
    rememberReviewDraft(extractionId, { version: 1, decisions: local })
    captureSessionRecovery()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt(), pendingReviewDecisions: pendingDecisions, reviewDraft: { version: 2, decisions: [] } })
    function DocumentReview() {
      const original = attempt()
      const controller = useExtraction({ schemaReady: true, indexing: false, initialAttempt: original,
        reviewTarget: { sourceRepresentationId: original.sourceRepresentationRevisionId, schemaRevisionId: original.schemaRevisionId }, onTerminal: vi.fn(), onError: vi.fn() })
      return <ResultsTab controller={controller} onRunExtraction={async () => {}} runExtractionDisabled={false} schemaReady
        pinnedSchema={{ recordDescription: 'Source', schemaNodes }} documentMarkdown="Grounded" sourceDocumentName="Source" />
    }
    render(view === 'grid' ? <Grid batch={batch()} schemaNodes={schemaNodes} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} /> : <DocumentReview />)
    await screen.findByText(`Draft not saved: ${REVIEW_DRAFT_CONFLICT}`)
    expect(api.saveExtractionReviewDraft).not.toHaveBeenCalled()
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload server review' }))
    await waitFor(() => expect(api.readExtraction).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(`Draft not saved: ${REVIEW_DRAFT_CONFLICT}`)).toBeNull())
    expect(api.saveExtractionReviewDraft).not.toHaveBeenCalled()
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  })

  it.each(['grid', 'document'] as const)('stops retrying a stale version after a live conflict in %s and reloads server state instead', async (view) => {
    vi.mocked(api.saveExtractionReviewDraft).mockRejectedValueOnce(new Error(REVIEW_DRAFT_CONFLICT))
    const original = attempt()
    const { result } = renderHook(() => view === 'grid'
      ? useBatchExtractionReviewGrid(batch(), schemaNodes)
      : useExtraction({ schemaReady: true, indexing: false, initialAttempt: original,
        reviewTarget: { sourceRepresentationId: original.sourceRepresentationRevisionId, schemaRevisionId: original.schemaRevisionId }, onTerminal: vi.fn(), onError: vi.fn() }))
    const current = () => {
      const hook = result.current
      return 'review' in hook
        ? { draftError: hook.review.draftError, ready: !hook.review.loading && hook.review.decisions.length > 0,
            decide: () => hook.review.setDecision(pendingDecisions[0].resultPath, 'REJECTED'), retry: hook.review.retryDraft }
        : { draftError: hook.draftError, ready: hook.members.get(reviewableDocumentId)?.status === 'ready',
            decide: () => hook.setDecision(reviewableDocumentId, pendingDecisions[0].resultPath, 'REJECTED'), retry: hook.retryDrafts }
    }
    await waitFor(() => expect(current().ready).toBe(true))
    act(() => current().decide())
    await waitFor(() => expect(current().draftError).toBe(REVIEW_DRAFT_CONFLICT))
    // The retry control must reload, never re-send the stale version.
    act(() => current().retry())
    await waitFor(() => expect(api.readExtraction).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(current().draftError).toBeNull())
    expect(api.saveExtractionReviewDraft).toHaveBeenCalledTimes(1)
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  })

  it('restores an empty batch Revert and retries it without finalizing default decisions', async () => {
    rememberReviewDraft(extractionId, { version: 1, decisions: [] })
    captureSessionRecovery()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt(), pendingReviewDecisions: pendingDecisions, reviewDraft: { version: 1, decisions: pendingDecisions } })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(api.saveExtractionReviewDraft).toHaveBeenCalledWith(extractionId, [], 1))
    expect(result.current.dirtyCount).toBe(0)
    await act(() => result.current.saveMember(reviewableDocumentId))
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  })

  it('discards recovered changes when the server review is finalized', async () => {
    rememberReviewDraft(extractionId, { version: 1, decisions: [{ ...pendingDecisions[0], action: 'REJECTED' }] })
    captureSessionRecovery()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt({ reviewedAt: '2026-09-06T00:00:00Z', reviewDecisions: [] }), pendingReviewDecisions: pendingDecisions, reviewDraft: { version: 2, decisions: [] } })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
    expect(result.current.draftError).toBeNull()
    expect(api.saveExtractionReviewDraft).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('free.auth.recovery.v1')).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('resets pending saves on a batch change and ignores an old %s', async (outcome) => {
    const oldWrite = Promise.withResolvers<{ version: number; decisions: ReviewDecisionInput[] }>()
    vi.mocked(api.saveExtractionReviewDraft).mockReturnValueOnce(oldWrite.promise)
    const { result, rerender } = renderHook(({ current }) => useBatchExtractionReviewGrid(current, schemaNodes), { initialProps: { current: batch() } })
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
    act(() => result.current.setDecision(reviewableDocumentId, pendingDecisions[0].resultPath, 'REJECTED'))
    expect(result.current.draftSaving).toBe(true)
    rerender({ current: batch({ batchExtractionId: 'another-batch' }) })
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
    expect(result.current.draftSaving).toBe(false)
    await act(async () => {
      if (outcome === 'resolve') oldWrite.resolve({ version: 99, decisions: [] })
      else oldWrite.reject(new Error('old error'))
      await Promise.allSettled([oldWrite.promise])
    })
    expect(result.current.draftError).toBeNull()
    act(() => result.current.setDecision(reviewableDocumentId, pendingDecisions[0].resultPath, 'REJECTED'))
    expect(api.saveExtractionReviewDraft).toHaveBeenLastCalledWith(extractionId, expect.any(Array), 0)
    await waitFor(() => expect(result.current.draftSaving).toBe(false))
  })

  it('shares drafts with document review and restores bulk actions and Revert after remount', async () => {
    const original = attempt()
    const pending = [...pendingDecisions, {
      ...pendingDecisions[0], resultPath: ['records', 0, 'year'], evidenceAnchorId: 'year-anchor',
    }]
    vi.mocked(api.readExtraction).mockImplementation(async () => ({ extraction: original, pendingReviewDecisions: pending, reviewDraft: savedDrafts.get(original.extractionId) }))
    const first = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(first.result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
    act(() => first.result.current.setDecision(reviewableDocumentId, pending[0].resultPath, 'EDITED', 'Corrected'))
    first.unmount()
    const document = renderHook(() => useExtraction({
      schemaReady: true, indexing: false, initialAttempt: original,
      reviewTarget: { sourceRepresentationId: original.sourceRepresentationRevisionId, schemaRevisionId: original.schemaRevisionId },
      onTerminal: vi.fn(), onError: vi.fn(),
    }))
    await waitFor(() => expect(document.result.current.review.decisions[0]?.reviewedValue).toBe('Corrected'))
    act(() => document.result.current.review.setDecision(pending[0].resultPath, 'REJECTED'))
    document.unmount()
    const second = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(second.result.current.dirtyCount).toBe(1))
    const state = second.result.current.members.get(reviewableDocumentId)
    expect(state?.status === 'ready' && state.decisions[0].action).toBe('REJECTED')
    act(() => second.result.current.approveColumn(second.result.current.columns[1]))
    expect(savedDrafts.get(extractionId)?.decisions.length).toBe(2)
    act(() => second.result.current.revertDecision(reviewableDocumentId, pending[0].resultPath))
    expect(savedDrafts.get(extractionId)?.decisions.length).toBe(1)
    second.unmount()
    const third = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(third.result.current.dirtyCount).toBe(1))
    act(() => third.result.current.revertAll())
    expect(savedDrafts.get(extractionId)?.decisions).toEqual([])
  })

  it('keeps a failed save draft and lets a finalized server review supersede it', async () => {
    const first = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(first.result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
    act(() => first.result.current.approveAll())
    vi.mocked(api.finalizeExtractionReview).mockRejectedValue(new Error('offline'))
    await act(() => first.result.current.saveMember(reviewableDocumentId))
    expect(savedDrafts.get(extractionId)?.decisions.length).toBe(1)
    first.unmount()
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt({ reviewedAt: '2026-09-06T00:00:00Z', reviewDecisions: [] }), pendingReviewDecisions: [] })
    const restored = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(restored.result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
    expect(restored.result.current.dirtyCount).toBe(0)
  })

  it.each(['grid', 'document'] as const)('shows an accessible draft-save failure in the %s view while retaining the decision', async (view) => {
    const pending = [...pendingDecisions, { ...pendingDecisions[0], resultPath: ['records', 0, 'year'] }]
    vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt(), pendingReviewDecisions: pending })
    vi.mocked(api.saveExtractionReviewDraft).mockRejectedValue(new Error('offline'))
    function DocumentReview() {
      const original = attempt()
      const controller = useExtraction({ schemaReady: true, indexing: false, initialAttempt: original,
        reviewTarget: { sourceRepresentationId: original.sourceRepresentationRevisionId, schemaRevisionId: original.schemaRevisionId }, onTerminal: vi.fn(), onError: vi.fn() })
      return <ResultsTab controller={controller} onRunExtraction={async () => {}} runExtractionDisabled={false} schemaReady
        pinnedSchema={{ recordDescription: 'Source', schemaNodes }} documentMarkdown="Grounded" sourceDocumentName="Source" />
    }
    {
      render(view === 'grid' ? <Grid batch={batch()} schemaNodes={schemaNodes} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} /> : <DocumentReview />)
      if (view === 'grid') {
        fireEvent.click(await screen.findByText('Grounded'))
        fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
      } else {
        fireEvent.click(await screen.findByRole('button', { name: 'Reject title' }))
      }
      expect((await screen.findByText(/Draft not saved: offline/)).getAttribute('role')).toBe('alert')
      expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
    }
  })

  it('derives grid columns from the pinned schema, excluding grouped/internal fields', () => {
    const { result } = renderHook(() =>
      useBatchExtractionReviewGrid(batch(), [
        ...schemaNodes,
        { id: 'internal', name: '_internal', type: 'string' as const },
      ]),
    )
    expect(result.current.columns.map((column) => column.key)).toEqual(['title', 'year'])
  })

  it('only reads SUCCEEDED members, staging their pending decisions', async () => {
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: attempt(),
      pendingReviewDecisions: pendingDecisions,
    })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))

    await waitFor(() => {
      const state = result.current.members.get(reviewableDocumentId)
      expect(state?.status).toBe('ready')
    })

    expect(api.readExtraction).toHaveBeenCalledTimes(1)
    expect(api.readExtraction).toHaveBeenCalledWith(extractionId, expect.any(AbortSignal))
    expect(result.current.members.has(failedDocumentId)).toBe(false)
    const state = result.current.members.get(reviewableDocumentId)
    if (state?.status !== 'ready') throw new Error('expected ready state')
    expect(state.editable).toBe(true)
    expect(state.decisions).toEqual(pendingDecisions)
  })

  it('stages a rejection locally, then saves it through finalizeExtractionReview', async () => {
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: attempt(),
      pendingReviewDecisions: pendingDecisions,
    })
    const reviewed = attempt({
      reviewedAt: '2026-08-14T10:45:00.000Z',
      reviewDecisions: [{ ...pendingDecisions[0], action: 'REJECTED', createdAt: '2026-08-14T10:45:00.000Z' }],
    })
    vi.mocked(api.finalizeExtractionReview).mockResolvedValue(reviewed)
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))

    act(() => result.current.setDecision(reviewableDocumentId, ['records', 0, 'title'], 'REJECTED'))
    expect(result.current.dirtyCount).toBe(1)

    await act(() => result.current.saveMember(reviewableDocumentId))

    expect(api.finalizeExtractionReview).toHaveBeenCalledWith(extractionId, [
      { ...pendingDecisions[0], action: 'REJECTED', reviewedValue: null },
    ], 1)
    const state = result.current.members.get(reviewableDocumentId)
    if (state?.status !== 'ready') throw new Error('expected ready state')
    expect(state.editable).toBe(false)
    expect(result.current.dirtyCount).toBe(0)
  })

  it('keeps saving other dirty members after one save fails', async () => {
    const secondDocumentId = '51000000-0000-4000-8001-000000000003'
    const secondExtractionId = '51000000-0000-4000-8006-000000000003'
    vi.mocked(api.readExtraction).mockImplementation(async (id) =>
      id === extractionId
        ? { extraction: attempt(), pendingReviewDecisions: pendingDecisions }
        : {
            extraction: attempt({
              extractionId: secondExtractionId,
              sourceDocumentId: secondDocumentId,
            }),
            pendingReviewDecisions: pendingDecisions,
          },
    )
    vi.mocked(api.finalizeExtractionReview).mockImplementation(async (id) =>
      id === extractionId
        ? Promise.reject(new Error('Saving failed.'))
        : attempt({
            extractionId: secondExtractionId,
            sourceDocumentId: secondDocumentId,
            reviewedAt: '2026-08-14T10:45:00.000Z',
            reviewDecisions: [{ ...pendingDecisions[0], createdAt: '2026-08-14T10:45:00.000Z' }],
          }),
    )
    const twoMemberBatch = batch({
      members: [
        ...batch().members.slice(0, 1),
        {
          sourceDocumentId: secondDocumentId,
          sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000003',
          latestExtraction: {
            extractionId: secondExtractionId,
            outcome: 'SUCCEEDED',
            complete: true,
            reviewable: true,
            createdAt: '2026-08-14T10:43:00.000Z',
            reviewedAt: null,
            failureMessage: null,
          },
        },
      ],
    })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(twoMemberBatch, schemaNodes))
    await waitFor(() => {
      expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready')
      expect(result.current.members.get(secondDocumentId)?.status).toBe('ready')
    })

    act(() => {
      result.current.setDecision(reviewableDocumentId, ['records', 0, 'title'], 'REJECTED')
      result.current.setDecision(secondDocumentId, ['records', 0, 'title'], 'REJECTED')
    })
    expect(result.current.dirtyCount).toBe(2)

    await act(async () => {
      await Promise.all([
        result.current.saveMember(reviewableDocumentId),
        result.current.saveMember(secondDocumentId),
      ])
    })

    const failedState = result.current.members.get(reviewableDocumentId)
    if (failedState?.status !== 'ready') throw new Error('expected ready state')
    expect(failedState.saveError).toBe('Saving failed.')
    expect(failedState.editable).toBe(true)

    const savedState = result.current.members.get(secondDocumentId)
    if (savedState?.status !== 'ready') throw new Error('expected ready state')
    expect(savedState.editable).toBe(false)
    expect(result.current.dirtyCount).toBe(1)
  })

  it('keeps a newer member load when an older retry resolves last', async () => {
    const newerExtractionId = '51000000-0000-4000-8006-000000000099'
    const staleRetry = Promise.withResolvers<{
      extraction: ExtractionAttempt
      pendingReviewDecisions: typeof pendingDecisions
    }>()
    let oldReads = 0
    vi.mocked(api.readExtraction).mockImplementation((id) => {
      if (id === extractionId) {
        oldReads += 1
        return oldReads === 1
          ? Promise.resolve({
              extraction: attempt(),
              pendingReviewDecisions: pendingDecisions,
            })
          : staleRetry.promise
      }
      return Promise.resolve({
        extraction: attempt({ extractionId: newerExtractionId }),
        pendingReviewDecisions: pendingDecisions,
      })
    })
    const { result, rerender } = renderHook(
      ({ currentBatch }) =>
        useBatchExtractionReviewGrid(currentBatch, schemaNodes),
      { initialProps: { currentBatch: batch() } },
    )
    await waitFor(() =>
      expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'),
    )

    act(() => result.current.retryMember(reviewableDocumentId))
    rerender({
      currentBatch: batch({
        members: [{
          ...batch().members[0],
          latestExtraction: {
            ...batch().members[0]!.latestExtraction!,
            extractionId: newerExtractionId,
          },
        }],
      }),
    })
    await waitFor(() => {
      const state = result.current.members.get(reviewableDocumentId)
      expect(state?.status).toBe('ready')
      if (state?.status === 'ready')
        expect(state.attempt.extractionId).toBe(newerExtractionId)
    })

    await act(async () => {
      staleRetry.resolve({
        extraction: attempt(),
        pendingReviewDecisions: pendingDecisions,
      })
      await staleRetry.promise
    })
    const state = result.current.members.get(reviewableDocumentId)
    expect(state?.status).toBe('ready')
    if (state?.status === 'ready')
      expect(state.attempt.extractionId).toBe(newerExtractionId)
  })

  it('aborts an explicit retry when the grid unmounts', async () => {
    const retry = Promise.withResolvers<{
      extraction: ExtractionAttempt
      pendingReviewDecisions: typeof pendingDecisions
    }>()
    let reads = 0
    let retrySignal: AbortSignal | undefined
    vi.mocked(api.readExtraction).mockImplementation((_id, signal) => {
      reads += 1
      if (reads === 1)
        return Promise.resolve({
          extraction: attempt(),
          pendingReviewDecisions: pendingDecisions,
        })
      retrySignal = signal
      return retry.promise
    })
    const { result, unmount } = renderHook(() =>
      useBatchExtractionReviewGrid(batch(), schemaNodes),
    )
    await waitFor(() =>
      expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'),
    )

    act(() => result.current.retryMember(reviewableDocumentId))
    unmount()

    expect(retrySignal?.aborted).toBe(true)
    retry.resolve({
      extraction: attempt(),
      pendingReviewDecisions: pendingDecisions,
    })
  })

  it('drops dirty members when the Batch Extraction changes', async () => {
    vi.mocked(api.finalizeExtractionReview).mockResolvedValue(attempt())
    const { result, rerender } = renderHook(
      ({ currentBatch }) =>
        useBatchExtractionReviewGrid(currentBatch, schemaNodes),
      { initialProps: { currentBatch: batch() } },
    )
    await waitFor(() =>
      expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'),
    )
    act(() =>
      result.current.setDecision(
        reviewableDocumentId,
        ['records', 0, 'title'],
        'REJECTED',
      ),
    )
    expect(result.current.dirtyCount).toBe(1)

    rerender({
      currentBatch: batch({
        batchExtractionId: '51000000-0000-4000-8007-000000000099',
        members: [batch().members[1]!],
      }),
    })
    await act(async () => {})
    await act(() => result.current.saveMember(reviewableDocumentId))

    expect(result.current.members.has(reviewableDocumentId)).toBe(false)
    expect(result.current.dirtyCount).toBe(0)
    expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  })

  const twoFieldDecisions = [
    pendingDecisions[0],
    {
      resultPath: ['records', 0, 'year'],
      evidenceAnchorId: 'anchor-2',
      reviewedOccurrenceIds: ['occurrence-2'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    },
  ]

  it('approveAll marks untouched decisions touched without changing an already-rejected decision', async () => {
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: attempt(),
      pendingReviewDecisions: twoFieldDecisions,
    })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))

    act(() => result.current.setDecision(reviewableDocumentId, ['records', 0, 'title'], 'REJECTED'))
    expect(result.current.dirtyCount).toBe(1)

    act(() => result.current.approveAll())

    const state = result.current.members.get(reviewableDocumentId)
    if (state?.status !== 'ready') throw new Error('expected ready state')
    // The explicitly-rejected field keeps its action — bulk approve never
    // overwrites a decision the researcher already acted on.
    expect(state.decisions.find((d) => d.resultPath[2] === 'title')?.action).toBe('REJECTED')
    // The still-pending field is now marked touched (and stays APPROVED,
    // its untouched default), which is what makes it count as reviewed.
    expect(state.touched.has(resultPathKey(['records', 0, 'year']))).toBe(true)
    expect(state.decisions.find((d) => d.resultPath[2] === 'year')?.action).toBe('APPROVED')
  })

  it('approveRow and approveColumn also leave an already-rejected decision unchanged', async () => {
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: attempt(),
      pendingReviewDecisions: twoFieldDecisions,
    })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))

    act(() => result.current.setDecision(reviewableDocumentId, ['records', 0, 'title'], 'REJECTED'))
    act(() => result.current.approveRow(reviewableDocumentId, 0))
    let state = result.current.members.get(reviewableDocumentId)
    if (state?.status !== 'ready') throw new Error('expected ready state')
    expect(state.decisions.find((d) => d.resultPath[2] === 'title')?.action).toBe('REJECTED')
    expect(state.touched.has(resultPathKey(['records', 0, 'year']))).toBe(true)

    act(() => result.current.approveColumn(result.current.columns[0]))
    state = result.current.members.get(reviewableDocumentId)
    if (state?.status !== 'ready') throw new Error('expected ready state')
    expect(state.decisions.find((d) => d.resultPath[2] === 'title')?.action).toBe('REJECTED')
  })

  it('revertDecision restores one touched field to its untouched APPROVED default', async () => {
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: attempt(),
      pendingReviewDecisions: twoFieldDecisions,
    })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))

    act(() => result.current.setDecision(reviewableDocumentId, ['records', 0, 'title'], 'REJECTED'))
    expect(result.current.dirtyCount).toBe(1)

    act(() => result.current.revertDecision(reviewableDocumentId, ['records', 0, 'title']))

    const state = result.current.members.get(reviewableDocumentId)
    if (state?.status !== 'ready') throw new Error('expected ready state')
    expect(state.decisions.find((d) => d.resultPath[2] === 'title')?.action).toBe('APPROVED')
    expect(state.touched.has(resultPathKey(['records', 0, 'title']))).toBe(false)
    expect(result.current.dirtyCount).toBe(0)
  })

  it('revertRow restores only the touched decisions of that row, leaving other rows alone', async () => {
    const secondDocumentId = '51000000-0000-4000-8001-000000000004'
    const secondExtractionId = '51000000-0000-4000-8006-000000000004'
    vi.mocked(api.readExtraction).mockImplementation(async (id) =>
      id === extractionId
        ? { extraction: attempt(), pendingReviewDecisions: twoFieldDecisions }
        : {
            extraction: attempt({ extractionId: secondExtractionId, sourceDocumentId: secondDocumentId }),
            pendingReviewDecisions: twoFieldDecisions,
          },
    )
    const twoMemberBatch = batch({
      members: [
        ...batch().members.slice(0, 1),
        {
          sourceDocumentId: secondDocumentId,
          sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000004',
          latestExtraction: {
            extractionId: secondExtractionId,
            outcome: 'SUCCEEDED',
            complete: true,
            reviewable: true,
            createdAt: '2026-08-14T10:43:00.000Z',
            reviewedAt: null,
            failureMessage: null,
          },
        },
      ],
    })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(twoMemberBatch, schemaNodes))
    await waitFor(() => {
      expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready')
      expect(result.current.members.get(secondDocumentId)?.status).toBe('ready')
    })

    act(() => {
      result.current.setDecision(reviewableDocumentId, ['records', 0, 'title'], 'REJECTED')
      result.current.setDecision(secondDocumentId, ['records', 0, 'title'], 'REJECTED')
    })
    expect(result.current.dirtyCount).toBe(2)

    act(() => result.current.revertRow(reviewableDocumentId, 0))

    const revertedState = result.current.members.get(reviewableDocumentId)
    if (revertedState?.status !== 'ready') throw new Error('expected ready state')
    expect(revertedState.touched.size).toBe(0)
    expect(revertedState.decisions.find((d) => d.resultPath[2] === 'title')?.action).toBe('APPROVED')

    const otherState = result.current.members.get(secondDocumentId)
    if (otherState?.status !== 'ready') throw new Error('expected ready state')
    expect(otherState.decisions.find((d) => d.resultPath[2] === 'title')?.action).toBe('REJECTED')
    expect(result.current.dirtyCount).toBe(1)
  })

  it('revertAll restores every member back to its untouched, unreviewed default', async () => {
    vi.mocked(api.readExtraction).mockResolvedValue({
      extraction: attempt(),
      pendingReviewDecisions: twoFieldDecisions,
    })
    const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
    await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))

    act(() => {
      result.current.setDecision(reviewableDocumentId, ['records', 0, 'title'], 'EDITED', 'Changed')
      result.current.approveAll()
    })
    expect(result.current.dirtyCount).toBe(1)

    act(() => result.current.revertAll())

    const state = result.current.members.get(reviewableDocumentId)
    if (state?.status !== 'ready') throw new Error('expected ready state')
    expect(state.touched.size).toBe(0)
    expect(state.decisions.every((d) => d.action === 'APPROVED' && d.reviewedValue === null)).toBe(true)
    expect(result.current.dirtyCount).toBe(0)
  })
})

describe('projectedRecords', () => {
  it('applies staged decisions and returns every record, not just the first', () => {
    const twoRecordAttempt = attempt({
      resultPayload: {
        records: [
          { title: 'First', year: 2019 },
          { title: 'Second', year: 2021 },
        ],
      },
    })
    const decisions = [
      {
        resultPath: ['records', 1, 'title'],
        evidenceAnchorId: 'anchor-2',
        reviewedOccurrenceIds: ['occurrence-2'],
        action: 'EDITED' as const,
        reviewedValue: 'Corrected',
      },
    ]
    const records = projectedRecords(twoRecordAttempt, decisions)
    expect(records).toEqual([
      { title: 'First', year: 2019 },
      { title: 'Corrected', year: 2021 },
    ])
  })
})

it.each(['grid', 'document'] as const)('automatically saves a complete %s review and retains failed drafts for retry', async (view) => {
  const original = attempt()
  const saving = Promise.withResolvers<ExtractionAttempt>()
  vi.mocked(api.finalizeExtractionReview).mockReturnValueOnce(saving.promise)
  vi.mocked(api.finalizeExtractionReview).mockImplementation(async (id, decisions) => attempt({
    extractionId: id, reviewedAt: '2026-09-05T00:00:00Z',
    reviewDecisions: decisions.map((decision) => ({ ...decision, createdAt: '2026-09-05T00:00:00Z' })),
  }))
  function DocumentReview() {
    const controller = useExtraction({
      initialAttempt: original, schemaReady: true, indexing: false,
      reviewTarget: { sourceRepresentationId: original.sourceRepresentationRevisionId, schemaRevisionId: original.schemaRevisionId },
      onTerminal: () => {}, onError: () => {},
    })
    return <ResultsTab controller={controller} onRunExtraction={async () => {}} runExtractionDisabled={false}
      schemaReady pinnedSchema={{ recordDescription: 'Source', schemaNodes }} documentMarkdown="Grounded" sourceDocumentName="Source" />
  }
  const scene = view === 'grid'
    ? <Grid batch={batch()} schemaNodes={schemaNodes} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} />
    : <DocumentReview />
  const { rerender } = render(scene)
  await screen.findByText('Grounded')
  expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  if (view === 'grid') fireEvent.click(screen.getByRole('button', { name: 'Grounded' }))
  fireEvent.click(await screen.findByRole('button', { name: view === 'grid' ? 'Edit' : 'Edit title' }))
  const editor = screen.getByRole('textbox')
  fireEvent.change(editor, { target: { value: 'Corrected' } })
  expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: /Save/ })).toBeNull()
  fireEvent.blur(editor)
  await waitFor(() => expect(api.finalizeExtractionReview).toHaveBeenCalledTimes(1))
  expect(api.finalizeExtractionReview).toHaveBeenLastCalledWith(extractionId, [{ ...pendingDecisions[0], action: 'EDITED', reviewedValue: 'Corrected' }], 1)
  expect(screen.getByRole('button', { name: /Approve remaining/ }).hasAttribute('disabled')).toBe(true)
  await act(async () => saving.reject(new Error('Offline')))
  await screen.findByText('Review not saved')
  rerender(scene)
  await waitFor(() => expect(api.finalizeExtractionReview).toHaveBeenCalledTimes(1))
  expect(screen.getByText('Corrected')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(await screen.findByText('Review saved')).toBeTruthy()
  expect(api.finalizeExtractionReview).toHaveBeenCalledTimes(2)
})

it('preserves an unsaved review when another member completes', async () => {
  vi.mocked(api.readExtraction).mockImplementation(async (id) => ({
    extraction: attempt({ extractionId: id }), pendingReviewDecisions: pendingDecisions,
  }))
  const initial = batch()
  const { result, rerender } = renderHook(({ current }) => useBatchExtractionReviewGrid(current, schemaNodes), {
    initialProps: { current: initial },
  })
  await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
  act(() => result.current.setDecision(reviewableDocumentId, pendingDecisions[0].resultPath, 'EDITED', 'Corrected'))
  expect(result.current.dirtyCount).toBe(1)
  const next = structuredClone(initial)
  next.members[1].latestExtraction!.outcome = 'SUCCEEDED'
  rerender({ current: next })
  await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
  const state = result.current.members.get(reviewableDocumentId)
  expect(state?.status === 'ready' && state.decisions[0].reviewedValue).toBe('Corrected')
  expect(result.current.dirtyCount).toBe(1)
})

it('renders existing nested array values instead of presenting them as missing', async () => {
  vi.mocked(api.readExtraction).mockResolvedValue({
    extraction: attempt({ resultPayload: { records: [{ finds: [{ material: 'Bronze' }] }] } }),
    pendingReviewDecisions: [{ ...pendingDecisions[0], resultPath: ['records', 0, 'finds', 0, 'material'] }],
  })
  render(<Grid batch={batch()} schemaNodes={[{ id: 'finds', name: 'finds', type: 'array', children: [{ id: 'material', name: 'material', type: 'string' }] }]}
    documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} />)
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
  expect(screen.queryByText('Bronze')).not.toBeNull()
})

it('does not claim an unreviewed extraction needed no changes', async () => {
  render(<Grid batch={batch()} schemaNodes={schemaNodes} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} />)
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull())
  expect(screen.queryByText(/approved unchanged/)).toBeNull()
})

it('does not save a reverted field as approved while another field stays edited', async () => {
  const decisions = [...pendingDecisions, { ...pendingDecisions[0], resultPath: ['records', 0, 'year'] }]
  vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt(), pendingReviewDecisions: decisions })
  vi.mocked(api.finalizeExtractionReview).mockResolvedValue(attempt())
  const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
  await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
  act(() => result.current.setDecision(reviewableDocumentId, decisions[0].resultPath, 'EDITED', 'Corrected'))
  act(() => result.current.setDecision(reviewableDocumentId, decisions[1].resultPath, 'REJECTED'))
  act(() => result.current.revertDecision(reviewableDocumentId, decisions[1].resultPath))
  await act(() => result.current.saveMember(reviewableDocumentId))
  expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
})

it('locks edits, bulk changes, reversions and duplicate saves until the request settles', async () => {
  const saving = Promise.withResolvers<ExtractionAttempt>()
  vi.mocked(api.finalizeExtractionReview).mockReturnValue(saving.promise)
  const { result } = renderHook(() => useBatchExtractionReviewGrid(batch(), schemaNodes))
  await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
  let save!: Promise<void>
  act(() => {
    result.current.setDecision(reviewableDocumentId, pendingDecisions[0].resultPath, 'EDITED', 'First')
    save = result.current.saveMember(reviewableDocumentId)
    void result.current.saveMember(reviewableDocumentId)
    result.current.setDecision(reviewableDocumentId, pendingDecisions[0].resultPath, 'EDITED', 'Second')
    result.current.revertAll()
    result.current.approveAll()
    result.current.revertRow(reviewableDocumentId, 0)
  })
  await waitFor(() => expect(api.finalizeExtractionReview).toHaveBeenCalledTimes(1))
  let state = result.current.members.get(reviewableDocumentId)
  expect(state?.status === 'ready' && state.decisions[0].reviewedValue).toBe('First')
  await act(async () => { saving.reject(new Error('Offline')); await save })
  state = result.current.members.get(reviewableDocumentId)
  expect(state?.status === 'ready' && !state.saving && state.decisions[0].reviewedValue).toBe('First')
  expect(state?.status === 'ready' && state.saveError).toBe('Offline')
  act(() => result.current.setDecision(reviewableDocumentId, pendingDecisions[0].resultPath, 'EDITED', 'Retry edit'))
  state = result.current.members.get(reviewableDocumentId)
  expect(state?.status === 'ready' && state.decisions[0].reviewedValue).toBe('Retry edit')
})

it('ignores a save response after the member extraction changes', async () => {
  const saving = Promise.withResolvers<ExtractionAttempt>()
  vi.mocked(api.finalizeExtractionReview).mockReturnValue(saving.promise)
  vi.mocked(api.readExtraction).mockImplementation(async (id) => ({ extraction: attempt({ extractionId: id }), pendingReviewDecisions: pendingDecisions }))
  const { result, rerender } = renderHook(({ current }) => useBatchExtractionReviewGrid(current, schemaNodes), { initialProps: { current: batch() } })
  await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
  let save!: Promise<void>
  act(() => { result.current.approveAll(); save = result.current.saveMember(reviewableDocumentId) })
  const next = batch()
  next.members[0].latestExtraction!.extractionId = 'new-extraction'
  rerender({ current: next })
  await waitFor(() => expect(result.current.members.get(reviewableDocumentId)?.status).toBe('ready'))
  await act(async () => { saving.resolve(attempt({ reviewedAt: '2026-09-04T00:00:00Z' })); await save })
  const state = result.current.members.get(reviewableDocumentId)
  expect(state?.status === 'ready' && state.attempt.extractionId).toBe('new-extraction')
  expect(state?.status === 'ready' && state.editable).toBe(true)
})

it('preserves browser shortcuts and handles unmodified grid shortcuts', async () => {
  render(<Grid batch={batch()} schemaNodes={schemaNodes} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} />)
  for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
    for (const key of ['+', '-', '0']) {
      const event = new KeyboardEvent('keydown', { key, [modifier]: true, cancelable: true, bubbles: true })
      act(() => { document.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
    }
  }
  const event = new KeyboardEvent('keydown', { key: '+', cancelable: true, bubbles: true })
  act(() => { document.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  expect(screen.getByRole('button', { name: 'Fit columns to screen width' }).textContent).toBe('110%')
})

it('expands nested and scalar arrays without losing numeric field names or joining sibling arrays', () => {
  const column = { key: 'finds.material', path: ['finds', 'material'], node: schemaNodes[0] }
  expect(valuesAtColumn({ finds: [{ material: ['Bronze', 'Iron'] }, { material: ['Gold'] }] }, column)).toEqual([
    { path: ['finds', 0, 'material', 0], value: 'Bronze' },
    { path: ['finds', 0, 'material', 1], value: 'Iron' },
    { path: ['finds', 1, 'material', 0], value: 'Gold' },
  ])
  expect(valuesAtColumn({ finds: [] }, column)).toEqual([])
  expect(valuesAtColumn({ finds: null }, column)).toEqual([{ path: ['finds', 'material'], value: undefined }])
  expect(decisionMatchesColumn(['records', 0, 'finds', 1, 'material', 0], column)).toBe(true)
  expect(decisionMatchesColumn(['records', 0, 'finds', 1, 'other'], column)).toBe(false)
  expect(valuesAtColumn({ '0': 'Zero' }, { ...column, path: ['0'] })).toEqual([{ path: ['0'], value: 'Zero' }])
})

it('reviews indexed scalar array values and excludes open editors from saving', async () => {
  const decisions = [0, 1].map((index) => ({ ...pendingDecisions[0], resultPath: ['records', 0, 'years', index] }))
  vi.mocked(api.finalizeExtractionReview).mockImplementation(async (id, submitted) => attempt({
    extractionId: id, reviewedAt: '2026-09-04T00:00:00Z',
    reviewDecisions: submitted.map((decision) => ({ ...decision, createdAt: '2026-09-04T00:00:00Z' })),
  }))
  vi.mocked(api.readExtraction).mockResolvedValue({ extraction: attempt({ resultPayload: { records: [{ years: [2000, 2001] }] } }), pendingReviewDecisions: decisions })
  render(<Grid batch={batch()} schemaNodes={[{ id: 'years', name: 'years', type: 'array', itemType: 'integer' }]} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} />)
  await screen.findByText('2001')
  const item = within(screen.getByRole('group', { name: 'years · Item 2' }))
  fireEvent.click(item.getByRole('button', { name: '2001' }))
  fireEvent.click(item.getByRole('button', { name: 'Edit' }))
  expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  fireEvent.change(item.getByRole('textbox'), { target: { value: '2002' } })
  fireEvent.keyDown(item.getByRole('textbox'), { key: 'Enter' })
  expect(item.getByText('2002')).toBeTruthy()
  expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Approve remaining' }))
  await waitFor(() => expect(api.finalizeExtractionReview).toHaveBeenCalledWith(extractionId, [decisions[0], { ...decisions[1], action: 'EDITED', reviewedValue: 2002 }], 2))
  expect(await screen.findByText('50% approved unchanged')).toBeTruthy()
})

it('autosaves only complete documents and preserves partially reviewed drafts', async () => {
  const otherId = '51000000-0000-4000-8006-000000000002'
  const decisions = [...pendingDecisions, { ...pendingDecisions[0], resultPath: ['records', 0, 'year'] }]
  const current = batch()
  current.members[1].latestExtraction!.outcome = 'SUCCEEDED'
  vi.mocked(api.readExtraction).mockImplementation(async (id) => ({
    extraction: attempt({ extractionId: id }), pendingReviewDecisions: decisions,
  }))
  vi.mocked(api.finalizeExtractionReview).mockImplementation(async (id, submitted) => attempt({
    extractionId: id, reviewedAt: '2026-09-04T00:00:00Z',
    reviewDecisions: submitted.map((decision) => ({ ...decision, createdAt: '2026-09-04T00:00:00Z' })),
  }))
  render(<Grid batch={current} schemaNodes={schemaNodes}
    documentName={(id) => id === reviewableDocumentId ? 'Document A' : 'Document B'} onBack={() => {}} onOpenMember={() => {}} />)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Grounded' })).toHaveLength(2))
  const firstRow = within(screen.getByRole('row', { name: /Document A/ }))
  fireEvent.click(firstRow.getByRole('button', { name: 'Grounded' }))
  fireEvent.click(firstRow.getByRole('button', { name: 'Edit' }))
  fireEvent.change(firstRow.getByRole('textbox'), { target: { value: 'Draft title' } })
  fireEvent.keyDown(firstRow.getByRole('textbox'), { key: 'Enter' })
  expect(api.finalizeExtractionReview).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('row', { name: /Document B/ })).getByRole('button', { name: 'Approve 2 pending in this row' }))
  await screen.findByText('Review saved')
  expect(api.finalizeExtractionReview).toHaveBeenCalledExactlyOnceWith(otherId, decisions, 1)
  expect(firstRow.getByText('Draft title')).toBeTruthy()
  expect(firstRow.getByText('Draft')).toBeTruthy()
})

it('shows unchanged percentages only from finalized decisions', async () => {
  const reviewedAt = '2026-09-04T00:00:00Z'
  vi.mocked(api.readExtraction).mockResolvedValue({
    extraction: attempt({ reviewedAt, reviewDecisions: [
      { ...pendingDecisions[0], createdAt: reviewedAt },
      { ...pendingDecisions[0], resultPath: ['records', 0, 'year'], action: 'REJECTED', createdAt: reviewedAt },
    ] }), pendingReviewDecisions: [],
  })
  render(<Grid batch={batch()} schemaNodes={schemaNodes} documentName={() => 'Source'} onBack={() => {}} onOpenMember={() => {}} />)
  expect(await screen.findByText('50% approved unchanged')).toBeTruthy()
})
