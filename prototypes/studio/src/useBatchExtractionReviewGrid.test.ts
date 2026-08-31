// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  projectedRecords,
  useBatchExtractionReviewGrid,
} from './useBatchExtractionReviewGrid'
import { resultPathKey } from './reviewDecisions'
import * as api from './api'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import type { ExtractionAttempt } from '../shared/extraction.contract'

vi.mock('./api', () => ({
  readExtraction: vi.fn(),
  finalizeExtractionReview: vi.fn(),
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
    resultPayload: { records: [{ title: 'Grounded', year: 2020 }] },
    evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }],
    reviewable: true,
    retryOfId: null,
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

beforeEach(() => {
  vi.mocked(api.readExtraction).mockReset()
  vi.mocked(api.readExtraction).mockResolvedValue({
    extraction: attempt(),
    pendingReviewDecisions: pendingDecisions,
  })
  vi.mocked(api.finalizeExtractionReview).mockReset()
})

describe('useBatchExtractionReviewGrid', () => {
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
    ])
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

    await act(() => result.current.saveAll())

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
    await act(() => result.current.saveAll())

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
