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
      resultPath: null, active: false,
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

describe('saved Evidence marks across reads', () => {
  function viewerWithPage(anchor: ReturnType<typeof decodeParsedDocument>['evidence_index']['anchors'][number]) {
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    container.scrollTo = vi.fn()
    document.body.append(container)
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: { on: vi.fn(), off: vi.fn() } }
    // Stable refs keep a poll from looking like a different viewer.
    return { container, viewer, containerRef: { current: container }, viewerRef: { current: viewer as never } }
  }
  const running = { extractionId: 'x-1' }



  it('a focused Evidence survives a poll of the same Extraction and clears for another one', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, containerRef, viewerRef } = viewerWithPage(anchor)
    const { result, rerender } = renderHook(({ attempt }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt,
      resultPath: ['records'], active: true,
    }), { initialProps: { attempt: running as Parameters<typeof useEvidenceOverlays>[0]['attempt'] } })
    act(() => result.current(anchor))
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    rerender({ attempt: { ...running } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    rerender({ attempt: { ...running, extractionId: 'x-2' } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
  })

  it('keeps an off-page Evidence selection through a later read while its PDF page renders', () => {
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
    const marks = (selected: string | null) => ({ describe: new Map(), selected, onSelect: vi.fn(),
      savedLinks: evidenceLinks.map((link) => ({ key: JSON.stringify(link.resultPath), link })) })
    const { result, rerender } = renderHook(({ attempt, marks }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument: source, attempt, marks,
      resultPath: ['records'], active: true,
    }), { initialProps: { attempt: running as Parameters<typeof useEvidenceOverlays>[0]['attempt'], marks: marks(null) } })

    act(() => result.current(secondAnchor))
    expect(viewer.scrollPageIntoView).toHaveBeenCalledExactlyOnceWith({ pageNumber: 2 })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)

    // The durable reader's next read of the same Extraction repaints its marks.
    rerender({ attempt: { ...running }, marks: marks(null) })
    expect(viewer.scrollPageIntoView).toHaveBeenCalledExactlyOnceWith({ pageNumber: 2 })

    container.insertAdjacentHTML('beforeend', '<div class="page" data-page-number="2"></div>')
    act(() => listeners.forEach((paint) => paint()))
    const focused = container.querySelector('.page[data-page-number="2"] .parsed-evidence-focus')
    expect(focused?.getAttribute('data-occurrence-id')).toBe('second-page-occurrence')
    expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(2)
    expect(viewer.scrollPageIntoView).toHaveBeenCalledTimes(1)
  })
})

describe('dimming in one-by-one (results review redesign §7.3)', () => {
  it.each([
    ['segment', 4], ['cell', 4], ['input', 0], [undefined, 0],
  ] as const)('a %s link dims its page in %i rectangles that take no pointer hits', (precision, rectangles) => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    document.body.append(container)
    const dimLink: EvidenceLink = { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id, ...(precision ? { precision } : {}) }
    const { rerender } = renderHook(({ link }) => useEvidenceOverlays({
      containerRef: { current: container }, viewerRef: { current: { scrollPageIntoView: vi.fn() } as never },
      parsedDocument, attempt: null, resultPath: null, active: true, dimLink: link,
    }), { initialProps: { link: dimLink as EvidenceLink | null } })
    const shades = container.querySelectorAll<HTMLElement>('.evidence-dim')
    expect(shades).toHaveLength(rectangles)
    shades.forEach((shade) => {
      expect(shade.style.pointerEvents).toBe('none')
      expect(shade.style.opacity).toBe('0.45')
    })
    rerender({ link: null })
    expect(container.querySelectorAll('.evidence-dim')).toHaveLength(0)
  })

  it('leaves both places of a passage continued in the next column clear', () => {
    const fixture = decodeParsedDocument(parsedFixture)
    const [anchor, ...others] = fixture.evidence_index.anchors
    const first = anchor.producer_observations[0]
    // The fixture's passage at the head of the left column, continued at the foot of the right one.
    const continued = { ...first, occurrence_id: `${first.occurrence_id}_1`, bbox: { x0: 330, y0: 700, x1: 560, y1: 740 } }
    const parsedDocument = decodeParsedDocument({ ...fixture, evidence_index: { anchors: [
      { ...anchor, producer_observations: [first, continued] }, ...others,
    ] } })
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${first.page_number}"></div>`
    document.body.append(container)
    renderHook(() => useEvidenceOverlays({
      containerRef: { current: container }, viewerRef: { current: { scrollPageIntoView: vi.fn() } as never },
      parsedDocument, attempt: null, resultPath: null, active: true,
      dimLink: { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id, precision: 'segment' },
    }))
    // In percent of the 612 x 792 pt page: each place grown by 24pt.
    const holes = [[12, 12, 124, 78], [306, 676, 584, 764]]
      .map(([x0, y0, x1, y1]) => [x0! / 6.12, y0! / 7.92, x1! / 6.12, y1! / 7.92])
    const shades = [...container.querySelectorAll<HTMLElement>('.evidence-dim')].map((shade) => {
      const [left, top, width, height] = [shade.style.left, shade.style.top, shade.style.width, shade.style.height].map(Number.parseFloat)
      return [left!, top!, left! + width!, top! + height!]
    })
    const area = ([x0, y0, x1, y1]: number[]) => (x1! - x0!) * (y1! - y0!)
    const overlap = (a: number[], b: number[]) => Math.max(0, Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!))
      * Math.max(0, Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!))
    for (const shade of shades) for (const hole of holes) expect(overlap(shade, hole)).toBeCloseTo(0)
    // Shaded: the whole page but the two places, nothing twice.
    expect(shades.reduce((sum, shade) => sum + area(shade), 0)).toBeCloseTo(100 * 100 - area(holes[0]!) - area(holes[1]!))
  })
})

describe('marks select their values (results review redesign §7.2)', () => {
  it('paints one button per occurrence, named by its values, current when selected; a click hands over every value of the passage', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    document.body.append(container)
    const links: EvidenceLink[] = [
      { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id },
      { resultPath: ['records', 0, 'subtitle'], evidenceAnchorId: anchor.anchor_id },
    ]
    const onSelect = vi.fn()
    const describe = new Map([
      [JSON.stringify(['records', 0, 'title']), { name: 'title', value: 'Alpha', word: 'Approved', style: 'rule' as const, anchorId: anchor.anchor_id }],
      [JSON.stringify(['records', 0, 'subtitle']), { name: 'subtitle', value: 'Beta', word: null, style: 'rule' as const, anchorId: anchor.anchor_id }],
    ])
    renderHook(() => useEvidenceOverlays({
      containerRef: { current: container }, viewerRef: { current: { scrollPageIntoView: vi.fn() } as never }, parsedDocument,
      attempt: { extractionId: 'x' },
      resultPath: [], active: true, marks: { describe, selected: JSON.stringify(['records', 0, 'subtitle']), onSelect,
        savedLinks: links.map((link) => ({ key: JSON.stringify(link.resultPath), link })) },
    }))
    const marks = container.querySelectorAll<HTMLButtonElement>('button.evidence-mark')
    expect(marks).toHaveLength(anchor.producer_observations.length)
    const mark = marks[0]!
    expect(mark.getAttribute('aria-label')).toBe('title: Alpha, Approved; subtitle: Beta')
    expect(mark.getAttribute('aria-current')).toBe('true')
    expect(mark.className).toMatch(/\brule\b/)
    expect(mark.className).toMatch(/\bselected\b/)
    expect(mark.className).not.toMatch(/\bdecided\b/)
    expect(mark.style.background).toBe('')
    mark.click()
    expect(onSelect).toHaveBeenCalledWith([JSON.stringify(['records', 0, 'title']), JSON.stringify(['records', 0, 'subtitle'])], mark)
  })
})

describe('mark precision, focus and navigation ownership', () => {
  function fixture(precision: EvidenceLink['precision'] = 'segment') {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    document.body.append(container)
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: { on: vi.fn(), off: vi.fn() } }
    const key = JSON.stringify(['records', 0, 'title'])
    const attempt = { extractionId: 'mark-run' }
    const marks = { describe: new Map([[key, { name: 'title', value: 'Alpha', word: null, style: 'link' as const, anchorId: anchor.anchor_id }]]), selected: null as string | null, onSelect: vi.fn(),
      savedLinks: [{ key, link: { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id, precision } }] }
    const containerRef = { current: container }, viewerRef = { current: viewer as never }
    const hook = renderHook(({ attempt, marks }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt, resultPath: [], active: true, marks,
    }), { initialProps: { attempt, marks } })
    return { ...hook, attempt, marks, key, container, viewer, anchor }
  }
  it('draws no rectangle for page-only precision', () => {
    const { container } = fixture('input')
    expect(container.querySelectorAll('.evidence-mark')).toHaveLength(0)
  })
  it('selecting a page-only link navigates to its page without drawing a focus rectangle', () => {
    const { result, anchor, container, viewer } = fixture('input')
    act(() => result.current(anchor, 'input'))
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
    expect(viewer.scrollPageIntoView).toHaveBeenCalledExactlyOnceWith({ pageNumber: anchor.producer_observations[0].page_number })
  })
  it('keeps the focused mark through a poll of the same Extraction', () => {
    const { container, rerender, attempt, marks } = fixture()
    const mark = container.querySelector<HTMLButtonElement>('button.evidence-mark')!
    mark.focus()
    rerender({ attempt: { ...attempt }, marks })
    expect(document.activeElement).toBe(container.querySelector('button.evidence-mark'))
  })
  it('clears the focus when the selection closes, and keeps one painted with nothing selected', () => {
    const { result, rerender, attempt, marks, key, container, anchor } = fixture()
    act(() => result.current(anchor))
    rerender({ attempt, marks: { ...marks } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    rerender({ attempt, marks: { ...marks, selected: key } })
    rerender({ attempt, marks: { ...marks, selected: null } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
    expect(container.querySelectorAll('.evidence-mark')).toHaveLength(anchor.producer_observations.length)
  })
  it('does not navigate the PDF when marks repaint after selecting a value', () => {
    const { rerender, attempt, marks, key, viewer } = fixture()
    viewer.scrollPageIntoView.mockClear()
    rerender({ attempt, marks: { ...marks, selected: key } })
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled()
  })
})
