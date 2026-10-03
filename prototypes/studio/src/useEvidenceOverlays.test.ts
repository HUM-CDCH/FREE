// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import type { EvidenceLink } from '../shared/groundedExtraction'
import parsedFixture from './assets/parsed_document.v2.json'
import { useEvidenceOverlays } from './useEvidenceOverlays'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

describe('focused Evidence navigation', () => {
  it('repaints after a PDF page reset and releases the focus listener on selection and source changes', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    container.scrollTo = vi.fn()
    document.body.append(container)
    const listeners = new Set<() => void>()
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: {
      on: (_event: string, paint: () => void) => listeners.add(paint),
      off: (_event: string, paint: () => void) => listeners.delete(paint),
    } }
    const containerRef = { current: container }, viewerRef = { current: viewer as never }
    const { result, rerender } = renderHook(({ document }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument: document, attempt: null,
      fieldNames: [], resultPath: null, active: false,
    }), { initialProps: { document: parsedDocument as typeof parsedDocument | null } })

    act(() => result.current(anchor))
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    container.querySelector('.page')!.replaceChildren()
    act(() => listeners.forEach((paint) => paint()))
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    act(() => result.current(anchor))
    expect(listeners.size).toBe(1)
    rerender({ document: null })
    expect(listeners.size).toBe(0)
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
  })

  it.each([300, 2000])('centers off-screen columns when the passage is at y=%i', (top) => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    document.body.append(container)
    container.scrollLeft = 20
    container.scrollTop = 100
    container.scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('parsed-evidence-focus')
        ? new DOMRect(900, top, 200, 40)
        : new DOMRect(10, 20, 500, 600)
    })
    const { result } = renderHook(() => useEvidenceOverlays({
      containerRef: { current: container },
      viewerRef: { current: { scrollPageIntoView: vi.fn() } as never },
      parsedDocument,
      attempt: null,
      fieldNames: [],
      resultPath: null,
      active: false,
    }))

    act(() => result.current(anchor))

    expect(container.scrollTo).toHaveBeenCalledWith({
      left: 760,
      top: 100 + top - 300,
      behavior: 'auto',
    })
  })
})

describe('partial links (design §1)', () => {
  function viewerWithPage(anchor: ReturnType<typeof decodeParsedDocument>['evidence_index']['anchors'][number]) {
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    container.scrollTo = vi.fn()
    document.body.append(container)
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: { on: vi.fn(), off: vi.fn() } }
    // Stable refs keep a poll from looking like a different viewer.
    return { container, viewer, containerRef: { current: container }, viewerRef: { current: viewer as never } }
  }
  const running = { extractionId: 'x-1', executionStatus: 'RUNNING' as const, outcome: null, evidenceLinks: null, reviewDecisions: [] }

  it('paints a running attempt\'s partial links without moving the page the researcher is reading', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, viewer, containerRef, viewerRef } = viewerWithPage(anchor)
    renderHook(() => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt: running,
      fieldNames: ['title'], resultPath: ['records'], active: true,
      partialEvidenceLinks: [
        { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id },
        { resultPath: ['records', 1, 'title'], evidenceAnchorId: 'a_nowhere' },
      ],
    }))
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(1)
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled()
    expect(container.scrollTo).not.toHaveBeenCalled()
  })

  it('paints nothing without partial links, then uses a settled attempt\'s own links', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, viewer, containerRef, viewerRef } = viewerWithPage(anchor)
    const { rerender } = renderHook(({ attempt, partialEvidenceLinks }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt,
      fieldNames: ['title'], resultPath: ['records'], active: true, partialEvidenceLinks,
    }), { initialProps: { attempt: running as Parameters<typeof useEvidenceOverlays>[0]['attempt'], partialEvidenceLinks: null as readonly EvidenceLink[] | null } })
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(0)
    rerender({
      attempt: { ...running },
      partialEvidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id }],
    })
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(1)
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled()
    rerender({
      attempt: { ...running, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id }] },
      partialEvidenceLinks: [{ resultPath: ['records', 1, 'title'], evidenceAnchorId: 'a_nowhere' }],
    })
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(1)
    expect(viewer.scrollPageIntoView).toHaveBeenCalledTimes(1)
    rerender({ attempt: { ...running, executionStatus: 'FAILED' }, partialEvidenceLinks: null })
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(0)
  })

  it('a focused Evidence survives a poll of the same Extraction and clears for another one', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, containerRef, viewerRef } = viewerWithPage(anchor)
    const { result, rerender } = renderHook(({ attempt }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt,
      fieldNames: ['title'], resultPath: ['records'], active: true, partialEvidenceLinks: null,
    }), { initialProps: { attempt: running as Parameters<typeof useEvidenceOverlays>[0]['attempt'] } })
    act(() => result.current(anchor))
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    rerender({ attempt: { ...running } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    rerender({ attempt: { ...running, extractionId: 'x-2' } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
  })

  it('keeps an off-page Evidence selection through settlement while its PDF page renders', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const firstAnchor = parsedDocument.evidence_index.anchors[0]
    if (firstAnchor.kind !== 'text') throw new Error('The off-page focus fixture requires a text Evidence anchor.')
    const secondAnchor = {
      ...firstAnchor,
      anchor_id: 'second-page-anchor',
      producer_observations: firstAnchor.producer_observations.map((occurrence) => ({
        ...occurrence, occurrence_id: 'second-page-occurrence', page_number: 2,
      })),
    }
    const source = {
      ...parsedDocument,
      evidence_index: { ...parsedDocument.evidence_index, anchors: [firstAnchor, secondAnchor] },
    }
    const container = document.createElement('div')
    container.innerHTML = '<div class="page" data-page-number="1"></div>'
    container.scrollTo = vi.fn()
    document.body.append(container)
    const listeners = new Set<() => void>()
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: {
      on: (_event: string, paint: () => void) => listeners.add(paint),
      off: (_event: string, paint: () => void) => listeners.delete(paint),
    } }
    const containerRef = { current: container }, viewerRef = { current: viewer as never }
    const evidenceLinks = [
      { resultPath: ['records', 0, 'title'], evidenceAnchorId: firstAnchor.anchor_id },
      { resultPath: ['records', 1, 'title'], evidenceAnchorId: secondAnchor.anchor_id },
    ]
    const { result, rerender } = renderHook(({ attempt }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument: source, attempt,
      fieldNames: ['title'], resultPath: ['records'], active: true, partialEvidenceLinks: evidenceLinks,
    }), { initialProps: { attempt: running as Parameters<typeof useEvidenceOverlays>[0]['attempt'] } })

    act(() => result.current(secondAnchor))
    expect(viewer.scrollPageIntoView).toHaveBeenCalledExactlyOnceWith({ pageNumber: 2 })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)

    rerender({ attempt: { ...running, executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', evidenceLinks } })
    expect(viewer.scrollPageIntoView).toHaveBeenCalledExactlyOnceWith({ pageNumber: 2 })

    container.insertAdjacentHTML('beforeend', '<div class="page" data-page-number="2"></div>')
    act(() => listeners.forEach((paint) => paint()))
    const focused = container.querySelector('.page[data-page-number="2"] .parsed-evidence-focus')
    expect(focused?.getAttribute('data-occurrence-id')).toBe('second-page-occurrence')
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(2)
    expect(viewer.scrollPageIntoView).toHaveBeenCalledTimes(1)
  })
})
