// @vitest-environment jsdom

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import bundled from './assets/parsed_document.v2.json'
import { decodeParsedDocument } from './parsedDocument'
import { useExtraction, type ReviewTarget } from './useExtraction'

const api = vi.hoisted(() => ({
  requestExtraction: vi.fn(),
  requestGrounding: vi.fn(),
  postExtractionReview: vi.fn(),
}))

vi.mock('./api', () => api)

const document = decodeParsedDocument(bundled)
const reviewTarget: ReviewTarget = {
  sourceRepresentationId: 'source-representation-1',
  schemaRevisionId: 'schema-revision-1',
}

function options(target = reviewTarget) {
  return {
    pdfSource: { url: '/source.pdf', filename: 'source.pdf' },
    template: { title: 'verbatim-string' },
    schemaReady: true,
    markdown: '# Source',
    indexing: false,
    onComplete: vi.fn(),
    onError: vi.fn(),
    parsedDocument: document,
    reviewTarget: target,
  }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('pdf')))
  api.requestExtraction.mockReset()
  api.requestGrounding.mockReset()
  api.postExtractionReview.mockReset()
  api.requestExtraction.mockResolvedValue({
    result: { title: 'Report' },
    modelAttribution: { stage: 'extraction' },
  })
})

afterEach(() => vi.unstubAllGlobals())

describe('useExtraction two-stage orchestration', () => {
  it('retries grounding without rerunning clean extraction', async () => {
    api.requestGrounding
      .mockRejectedValueOnce(new Error('grounder unavailable'))
      .mockResolvedValueOnce({
        result: { links: { C1: 'E1' } },
        modelAttribution: { stage: 'grounding' },
      })
    const hookOptions = options()
    const { result } = renderHook(() => useExtraction(hookOptions))

    await act(async () => result.current.runExtraction())
    expect(result.current.state).toMatchObject({
      status: 'ready',
      result: { title: 'Report' },
      evidenceLinks: [],
      groundingError: 'grounder unavailable',
    })
    expect(hookOptions.onError).not.toHaveBeenCalled()

    await act(async () => result.current.retryGrounding())
    expect(api.requestExtraction).toHaveBeenCalledOnce()
    expect(api.requestGrounding).toHaveBeenCalledTimes(2)
    expect(result.current.state).toMatchObject({
      status: 'ready',
      result: { title: 'Report' },
      evidenceLinks: [
        {
          resultPath: ['title'],
          evidenceAnchorId: document.evidence_index.anchors[0].anchor_id,
        },
      ],
    })
  })

  it('aborts a stale grounding response when the pinned schema changes', async () => {
    let resolveGrounding!: (value: {
      result: { links: { C1: string } }
      modelAttribution: unknown
    }) => void
    api.requestGrounding.mockReturnValue(
      new Promise((resolve) => {
        resolveGrounding = resolve
      }),
    )
    const first = options()
    const { result, rerender } = renderHook(
      ({ target }: { target: ReviewTarget }) =>
        useExtraction({ ...first, reviewTarget: target }),
      { initialProps: { target: reviewTarget } },
    )

    let run!: Promise<void>
    act(() => {
      run = result.current.runExtraction()
    })
    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        status: 'running',
        step: 'grounding',
      }),
    )

    rerender({
      target: { ...reviewTarget, schemaRevisionId: 'schema-revision-2' },
    })
    await waitFor(() => expect(result.current.state.status).toBe('idle'))
    await act(async () => {
      resolveGrounding({
        result: { links: { C1: 'E1' } },
        modelAttribution: { stage: 'grounding' },
      })
      await run
    })

    expect(result.current.state.status).toBe('idle')
    expect(result.current.review.canAccept).toBe(false)
  })
})
