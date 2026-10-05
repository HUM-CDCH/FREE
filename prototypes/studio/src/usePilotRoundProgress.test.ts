// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchExtraction } from '../shared/batchExtraction.contract'

const { getBatchExtraction } = vi.hoisted(() => ({
  getBatchExtraction: vi.fn(),
}))
vi.mock('./projectContexts/batchExtractions', () => ({ getBatchExtraction }))

import { usePilotRoundProgress } from './usePilotRoundProgress'

afterEach(() => {
  cleanup()
  getBatchExtraction.mockReset()
  vi.restoreAllMocks()
})

const PROJECT = '10000000-0000-4000-8000-000000000001'
const BATCH = '20000000-0000-4000-8000-000000000001'
const DOC_A = '30000000-0000-4000-8000-000000000001'
const DOC_B = '30000000-0000-4000-8000-000000000002'
const DOC_C = '30000000-0000-4000-8000-000000000003'
const REPRESENTATION = '40000000-0000-4000-8000-000000000001'

/** A member with saved values to review, one whose current cut is finalized, or one with no saved value yet. */
function member(
  sourceDocumentId: string,
  state: 'open' | 'reviewed' | 'unsaved' = 'open',
  executionStatus: BatchExtraction['members'][number]['executionStatus'] = state === 'unsaved' ? 'RUNNING' : 'COMPLETED',
): BatchExtraction['members'][number] {
  return {
    extractionId: `${sourceDocumentId}-extraction`,
    sourceDocumentId,
    sourceRepresentationRevisionId: REPRESENTATION,
    executionStatus,
    reviewable: state !== 'unsaved',
    currentReview: state === 'reviewed'
      ? { snapshotVersion: 1, feedbackVersion: 1, createdAt: '2026-01-01T01:00:00.000Z', schemaRevisionId: '50000000-0000-4000-8000-000000000001' }
      : null,
  }
}

function batch(members: BatchExtraction['members']): BatchExtraction {
  return {
    batchExtractionId: BATCH,
    projectContextId: PROJECT,
    schemaRevisionId: '50000000-0000-4000-8000-000000000001',
    extractionSchemaId: '60000000-0000-4000-8000-000000000001',
    extractionSchemaName: 'Fixture schema',
    schemaRevisionNumber: 1,
    strategy: 'ARTICLE',
    executionStatus: 'COMPLETED',
    createdAt: '2026-01-01T00:00:00.000Z',
    members,
  }
}

describe('usePilotRoundProgress', () => {
  it('refreshes the current round after a review is finalized without navigating', async () => {
    getBatchExtraction.mockResolvedValueOnce(batch([member(DOC_A), member(DOC_B)]))
    const { result, rerender } = renderHook(
      ({ revision }) => usePilotRoundProgress(PROJECT, BATCH, DOC_A, revision),
      { initialProps: { revision: 0 } },
    )
    await waitFor(() => expect(result.current?.reviewed).toBe(0))
    getBatchExtraction.mockResolvedValueOnce(batch([
      member(DOC_A, 'reviewed'), member(DOC_B),
    ]))
    rerender({ revision: 1 })
    await waitFor(() => expect(result.current?.reviewed).toBe(1))
    expect(getBatchExtraction).toHaveBeenCalledTimes(2)
    expect(result.current?.nextMember?.sourceDocumentId).toBe(DOC_B)
  })
  it('counts a paused member\'s finalized review and opens a paused member with saved values next', async () => {
    getBatchExtraction.mockResolvedValueOnce(batch([member(DOC_A, 'reviewed', 'PAUSED'), member(DOC_B, 'open', 'PAUSED')]))
    const { result } = renderHook(() => usePilotRoundProgress(PROJECT, BATCH, DOC_A))
    await waitFor(() => expect(result.current).toEqual({ reviewed: 1, total: 2, nextMember: { sourceDocumentId: DOC_B, extractionId: `${DOC_B}-extraction` } }))
  })
  it('reports null before a projectContextId/batchExtractionId pair is available', () => {
    const { result } = renderHook(() => usePilotRoundProgress(null, null, null))
    expect(result.current).toBeNull()
    expect(getBatchExtraction).not.toHaveBeenCalled()
  })

  it('finds the next unreviewed member after the current document', async () => {
    getBatchExtraction.mockResolvedValueOnce(
      batch([
        member(DOC_A, 'reviewed'),
        member(DOC_B),
        member(DOC_C),
      ]),
    )
    const { result } = renderHook(() =>
      usePilotRoundProgress(PROJECT, BATCH, DOC_A),
    )
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current).toEqual({
      reviewed: 1,
      total: 3,
      nextMember: { sourceDocumentId: DOC_B, extractionId: `${DOC_B}-extraction` },
    })
  })

  it('wraps around to an earlier unreviewed member', async () => {
    getBatchExtraction.mockResolvedValueOnce(
      batch([
        member(DOC_A),
        member(DOC_B, 'reviewed'),
        member(DOC_C, 'reviewed'),
      ]),
    )
    const { result } = renderHook(() =>
      usePilotRoundProgress(PROJECT, BATCH, DOC_C),
    )
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current?.nextMember).toEqual({
      sourceDocumentId: DOC_A,
      extractionId: `${DOC_A}-extraction`,
    })
  })

  it('reports no next member once every member is reviewed', async () => {
    getBatchExtraction.mockResolvedValueOnce(
      batch([
        member(DOC_A, 'reviewed'),
        member(DOC_B, 'reviewed'),
      ]),
    )
    const { result } = renderHook(() =>
      usePilotRoundProgress(PROJECT, BATCH, DOC_A),
    )
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current).toEqual({ reviewed: 2, total: 2, nextMember: null })
  })

  it('skips a member with no Extraction yet when picking the next one', async () => {
    getBatchExtraction.mockResolvedValueOnce(
      batch([member(DOC_A), member(DOC_B, 'unsaved'), member(DOC_C)]),
    )
    const { result } = renderHook(() =>
      usePilotRoundProgress(PROJECT, BATCH, DOC_A),
    )
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(result.current?.nextMember).toEqual({
      sourceDocumentId: DOC_C,
      extractionId: `${DOC_C}-extraction`,
    })
  })

  it('yields null if the fetch fails, rather than throwing', async () => {
    getBatchExtraction.mockRejectedValueOnce(new Error('boom'))
    const { result } = renderHook(() =>
      usePilotRoundProgress(PROJECT, BATCH, DOC_A),
    )
    await waitFor(() => expect(getBatchExtraction).toHaveBeenCalled())
    expect(result.current).toBeNull()
  })
})
