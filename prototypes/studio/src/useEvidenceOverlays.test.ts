// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
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
