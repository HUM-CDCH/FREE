// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import type { EvidenceLink } from '../shared/groundedExtraction'
import parsedFixture from './assets/parsed_document.v2.json'
import { useEvidenceOverlays, type MarkInfo, type RailMarks } from './useEvidenceOverlays'
import { verifiedEvidenceBbox } from './evidenceNavigation'

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
      active: false,
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
      active: false,
    }))

    act(() => result.current(anchor))

    expect(container.scrollTo).toHaveBeenCalledWith({
      left: 760,
      top: 100 + top - 300,
      behavior: 'auto',
    })
  })

  // Narrowing to the quote in the text layer failed its safety gate (ADR 0029): a link's spans or location never narrow.
  it.each([
    ['grounding spans', { grounding: { textSpans: [{ segment: 's1', start: 11, end: 16 }] } }],
    ['an Article location', { location: { textSpans: [{ segment: 's1', start: 11, end: 16 }], raw: 'Gamma' } }],
  ])('outlines the whole block for a link with %s on a text layer, and never scrolls again on a repaint', (_, quote) => {
    const block = 'Alpha Beta Gamma'
    const parsedDocument = decodeParsedDocument(JSON.parse(JSON.stringify(parsedFixture).replaceAll('"bundled-anchor"', '"a_s1"').replace('"Unit 7"', JSON.stringify(block))))
    const anchor = parsedDocument.evidence_index.anchors[0]!
    const occurrence = anchor.producer_observations[0]!, bbox = verifiedEvidenceBbox(parsedDocument, occurrence)!
    const page = parsedDocument.pages.find((each) => each.page_number === occurrence.page_number)!
    const link = { resultPath: ['records', 0, 'gamma'], evidenceAnchorId: anchor.anchor_id, precision: 'segment', ...quote } as EvidenceLink
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${occurrence.page_number}"><div class="textLayer"><span>${block}</span></div></div>`
    container.scrollTo = vi.fn()
    document.body.append(container)
    const listeners = new Map<string, () => void>()
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: {
      on: (event: string, paint: () => void) => listeners.set(event, paint), off: (event: string) => listeners.delete(event) } }
    // The block's focus shows in the pane; a text layer in page points holds the block's text in one span over its box,
    // and a range's rect spans its characters, so a narrowing hook would find the quote.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('parsed-evidence-focus') ? new DOMRect(10, 100, 200, 60)
        : this.classList.contains('textLayer') ? new DOMRect(0, 0, page.width_pt, page.height_pt)
          : this.tagName === 'SPAN' ? new DOMRect(bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0) : new DOMRect(0, 0, 500, 600)
    })
    let range = [0, 0]
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: (_: Node, at: number) => { range = [at, range[1]!] }, setEnd: (_: Node, at: number) => { range = [range[0]!, at] },
      getClientRects: () => [new DOMRect(bbox.x0 + range[0]!, bbox.y0, range[1]! - range[0]!, 10)],
    }) as unknown as Range)
    const { result } = renderHook(() => useEvidenceOverlays({ containerRef: { current: container }, viewerRef: { current: viewer as never },
      parsedDocument, attempt: null, active: false }))

    act(() => result.current(anchor, link))
    const focus = () => container.querySelector<HTMLElement>('.parsed-evidence-focus')!
    expect(parseFloat(focus().style.left)).toBeCloseTo((bbox.x0 / page.width_pt) * 100)
    expect(parseFloat(focus().style.width)).toBeCloseTo(((bbox.x1 - bbox.x0) / page.width_pt) * 100)
    expect([...listeners.keys()]).toEqual(['pagerendered'])
    const blockBox = focus().style.cssText
    act(() => listeners.get('pagerendered')!())
    expect(focus().style.cssText).toBe(blockBox)
    expect(container.scrollTo).not.toHaveBeenCalled()
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



  it('keeps a shared occurrence provisional until every highlighted value is verified', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]!
    const { container, containerRef, viewerRef } = viewerWithPage(anchor)
    const verified = { name: 'title', value: 'Unit 7', word: null, style: 'link' as const, anchorId: anchor.anchor_id }
    const preview = { ...verified, name: 'unit (preview, not verified)', style: 'preview' as const }
    const describe = new Map<string, typeof verified | typeof preview>([['title', verified], ['unit', preview]])
    const savedLinks = ['title', 'unit'].map((key) => ({ key,
      link: { resultPath: ['records', 0, key], evidenceAnchorId: anchor.anchor_id } }))
    const { rerender } = renderHook(({ describe }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt: running, active: true,
      marks: { describe, selected: null, onSelect: vi.fn(), savedLinks },
    }), { initialProps: { describe } })
    const mark = container.querySelector('.parsed-evidence-highlight')!
    expect(mark.classList.contains('preview')).toBe(true)
    expect(mark.getAttribute('aria-label')).toContain('not verified')
    rerender({ describe: new Map([['title', verified], ['unit', { ...verified, name: 'unit' }]]) })
    expect(container.querySelector('.parsed-evidence-highlight')!.classList.contains('link')).toBe(true)
  })

  it('a focused Evidence survives a poll of the same Extraction and clears for another one', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const { container, containerRef, viewerRef } = viewerWithPage(anchor)
    const { result, rerender } = renderHook(({ attempt }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt,
      active: true,
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
      active: true,
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

describe('dimming in one-by-one', () => {
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
      parsedDocument, attempt: null, active: true, dimLink: link,
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
      parsedDocument, attempt: null, active: true,
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

describe('marks select their values', () => {
  it('paints one button per occurrence, named by its values, current when selected; a click hands over every value of the passage and no record start', () => {
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
      active: true, marks: { describe, selected: JSON.stringify(['records', 0, 'subtitle']), onSelect,
        // Discovery's record start in the same passage has no value to select.
        savedLinks: [{ key: 'found:0', link: { resultPath: ['records', 0], evidenceAnchorId: anchor.anchor_id } },
          ...links.map((link) => ({ key: JSON.stringify(link.resultPath), link }))] },
    }))
    const marks = container.querySelectorAll<HTMLButtonElement>('button.evidence-mark')
    expect(marks).toHaveLength(anchor.producer_observations.length)
    const mark = marks[0]!
    expect(mark.getAttribute('aria-label')).toBe('title: Alpha, linked by rule, Approved; subtitle: Beta, linked by rule')
    // No browser tooltip: the pointer gets the mark's name tag instead.
    expect(mark.title).toBe('')
    expect(mark.getAttribute('aria-current')).toBe('true')
    expect(mark.className).toMatch(/\brule\b/)
    expect(mark.className).toMatch(/\bselected\b/)
    expect(mark.className).not.toMatch(/\bdecided\b/)
    expect(mark.style.background).toBe('')
    mark.click()
    expect(onSelect).toHaveBeenCalledWith([JSON.stringify(['records', 0, 'title']), JSON.stringify(['records', 0, 'subtitle'])], mark)
  })

  it('names the values of the passage under the pointer, no record start, and lights the marks of a value hovered in Results', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    document.body.append(container)
    const key = JSON.stringify(['records', 0, 'title'])
    const onHover = vi.fn()
    const marks = { describe: new Map([[key, { name: 'title', value: 'Alpha', word: null, style: 'link' as const, anchorId: anchor.anchor_id }]]),
      selected: null, onSelect: vi.fn(), onHover, hovered: null as readonly string[] | null,
      savedLinks: [{ key: 'found:0', link: { resultPath: ['records', 0], evidenceAnchorId: anchor.anchor_id } },
        { key, link: { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id } }] }
    const containerRef = { current: container }, viewerRef = { current: { scrollPageIntoView: vi.fn() } as never }, attempt = { extractionId: 'x' }
    const { rerender } = renderHook(({ marks }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt, active: true, marks,
    }), { initialProps: { marks } })
    const mark = container.querySelector<HTMLButtonElement>('button.evidence-mark')!
    expect(mark.className).not.toMatch(/\bhovered\b/)
    // A mark that scrolls in under a still pointer gets `mouseenter` and no `mousemove`: it lights and names nothing.
    onHover.mockClear()
    mark.dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).not.toHaveBeenCalled()
    expect(container.querySelector('.evidence-mark-name')).toBeNull()
    // The pointer's own movement does, once per mark, with the field's name beside it.
    mark.dispatchEvent(new MouseEvent('mousemove'))
    mark.dispatchEvent(new MouseEvent('mousemove'))
    expect(onHover).toHaveBeenCalledTimes(1)
    expect(onHover).toHaveBeenLastCalledWith([key])
    expect(container.querySelectorAll('.evidence-mark-name')).toHaveLength(1)
    expect(container.querySelector('.evidence-mark-name')!.textContent).toBe('title')
    mark.dispatchEvent(new MouseEvent('mouseleave'))
    expect(onHover).toHaveBeenLastCalledWith(null)
    expect(container.querySelector('.evidence-mark-name')).toBeNull()
    rerender({ marks: { ...marks, hovered: [key] } })
    expect(container.querySelector('button.evidence-mark')).toBe(mark)
    expect(mark.className).toMatch(/\bhovered\b/)
  })
})

describe('correction marks', () => {
  it('names a value once when its model and correction Evidence share a passage, lit while one of its parts is chosen', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    document.body.append(container)
    const link: EvidenceLink = { resultPath: ['records', 0, 'site'], evidenceAnchorId: anchor.anchor_id }
    const edited = { name: 'site', value: 'Elmbrooke', word: 'Edited', style: 'link' as const, anchorId: anchor.anchor_id }
    renderHook(() => useEvidenceOverlays({
      containerRef: { current: container }, viewerRef: { current: { scrollPageIntoView: vi.fn() } as never }, parsedDocument,
      attempt: { extractionId: 'x' }, active: true, marks: { describe: new Map([['v', edited], ['v#correction', edited]]), selected: 'v#["x"]',
        onSelect: vi.fn(), savedLinks: [{ key: 'v', link }, { key: 'v#correction', link, occurrenceIds: [anchor.producer_observations[0].occurrence_id] }] },
    }))
    const [mark, ...rest] = container.querySelectorAll<HTMLButtonElement>('button.evidence-mark')
    expect(rest).toHaveLength(0)
    expect(mark!.getAttribute('aria-label')).toBe('site: Elmbrooke, Edited')
    expect(mark!.getAttribute('aria-current')).toBe('true')
  })

  it('names two values that read alike in one passage, from two records, twice', () => {
    const parsedDocument = decodeParsedDocument(parsedFixture)
    const anchor = parsedDocument.evidence_index.anchors[0]
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0].page_number}"></div>`
    document.body.append(container)
    const harlow = { name: 'place', value: 'Harlow', word: null, style: 'link' as const, anchorId: anchor.anchor_id }
    const link = (record: number): EvidenceLink => ({ resultPath: ['records', record, 'place'], evidenceAnchorId: anchor.anchor_id })
    renderHook(() => useEvidenceOverlays({
      containerRef: { current: container }, viewerRef: { current: { scrollPageIntoView: vi.fn() } as never }, parsedDocument,
      attempt: { extractionId: 'x' }, active: true, marks: { describe: new Map([['v', harlow], ['w', harlow]]), selected: null,
        onSelect: vi.fn(), savedLinks: [{ key: 'v', link: link(0) }, { key: 'w', link: link(1) }] },
    }))
    expect(container.querySelector('button.evidence-mark')!.getAttribute('aria-label')).toBe('place: Harlow; place: Harlow')
  })
})

describe('part marks', () => {
  it('a value\'s parts in one passage share its block mark in their field\'s colour, text layer or not', () => {
    // The fixture's one passage, renamed as a segment's anchor and holding two values' quotes: one part's link has
    // grounding spans, the other an Article location; spans count code points.
    const block = '𝛼 Alpha Beta Gamma'
    const parsedDocument = decodeParsedDocument(JSON.parse(JSON.stringify(parsedFixture).replaceAll('"bundled-anchor"', '"a_s1"').replace('"Unit 7"', JSON.stringify(block))))
    const anchor = parsedDocument.evidence_index.anchors[0]!
    const occurrence = anchor.producer_observations[0]!, bbox = verifiedEvidenceBbox(parsedDocument, occurrence)!
    const page = parsedDocument.pages.find((each) => each.page_number === occurrence.page_number)!
    const spans = (start: number) => [{ segment: anchor.anchor_id.slice(2), start, end: start + 3 }]
    const part = (name: string, quote: object) => ({ key: `v#["${name}"]`, link: { resultPath: ['records', 0, 's', name],
      evidenceAnchorId: anchor.anchor_id, precision: 'segment', ...quote } as EvidenceLink })
    const parts = [part('a', { grounding: { textSpans: spans(2) } }),
      part('b', { location: { textSpans: spans([...block].length - 3), raw: 'mma' } })]
    const describe = new Map(parts.map(({ key }) => [key, { name: key, value: key, word: null, style: 'link' as const, anchorId: anchor.anchor_id, color: '#e15759' }]))
    const render = (layer: string) => {
      const container = document.createElement('div')
      container.innerHTML = `<div class="page" data-page-number="${occurrence.page_number}">${layer}</div>`
      document.body.append(container)
      renderHook(() => useEvidenceOverlays({
        containerRef: { current: container }, viewerRef: { current: { scrollPageIntoView: vi.fn() } as never }, parsedDocument,
        attempt: { extractionId: 'x' }, active: true, marks: { describe, selected: 'v', onSelect: vi.fn(), savedLinks: parts },
      }))
      return [...container.querySelectorAll<HTMLButtonElement>('button.evidence-mark')]
    }
    // A text layer in page points: the block's text in one span over its box; a range's rect spans its characters.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('textLayer') ? new DOMRect(0, 0, page.width_pt, page.height_pt)
        : new DOMRect(bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0)
    })
    let range = [0, 0]
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: (_: Node, at: number) => { range = [at, range[1]!] }, setEnd: (_: Node, at: number) => { range = [range[0]!, at] },
      getClientRects: () => [new DOMRect(bbox.x0 + range[0]!, bbox.y0, range[1]! - range[0]!, 10)],
    }) as unknown as Range)
    // No text layer (a scanned page) or one showing both quotes: one block mark naming both parts, selected with its
    // value.
    for (const layer of ['', `<div class="textLayer"><span>${block}</span></div>`]) {
      const [shared, ...rest] = render(layer)
      expect(rest).toHaveLength(0)
      expect(shared!.getAttribute('aria-label')).toBe('v#["a"]: v#["a"]; v#["b"]: v#["b"]')
      expect(shared!.getAttribute('aria-current')).toBe('true')
      expect(shared!.style.getPropertyValue('--color-ev')).toBe('#e15759')
      expect(parseFloat(shared!.style.left)).toBeCloseTo((bbox.x0 / page.width_pt) * 100)
      expect(parseFloat(shared!.style.width)).toBeCloseTo(((bbox.x1 - bbox.x0) / page.width_pt) * 100)
    }
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
    type Props = { attempt: typeof attempt; marks: typeof marks; active?: boolean }
    const hook = renderHook(({ attempt, marks, active = true }: Props) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt, active, marks,
    }), { initialProps: { attempt, marks } as Props })
    return { ...hook, attempt, marks, key, container, viewer, anchor }
  }
  it('draws no rectangle for page-only precision', () => {
    const { container } = fixture('input')
    expect(container.querySelectorAll('.evidence-mark')).toHaveLength(0)
  })
  it('selecting a page-only link navigates to its page without drawing a focus rectangle', () => {
    const { result, anchor, container, viewer } = fixture('input')
    act(() => result.current(anchor, { resultPath: ['x'], evidenceAnchorId: anchor.anchor_id, precision: 'input' }))
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
  it('names the page holding the selected mark, and no page once the marks go', () => {
    const { rerender, attempt, marks, key, container } = fixture()
    const named = () => [...container.querySelectorAll('.page.holds-selected-mark')]
    expect(named()).toHaveLength(0)
    rerender({ attempt, marks: { ...marks, selected: key } })
    const pages = [...new Set([...container.querySelectorAll('.evidence-mark.selected')].map((mark) => mark.parentElement))]
    expect(pages.length).toBeGreaterThan(0)
    expect(named()).toEqual(pages)
    rerender({ attempt, marks: { ...marks, selected: key }, active: false })
    expect(named()).toHaveLength(0)
  })
  it('keeps the selected value\'s outline while the rail is collapsed; only the marks go', () => {
    const { result, rerender, attempt, marks, key, container, anchor, viewer } = fixture()
    const selected = { ...marks, selected: key }
    rerender({ attempt, marks: selected })
    act(() => result.current(anchor))
    viewer.scrollPageIntoView.mockClear()
    rerender({ attempt, marks: selected, active: false })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    expect(container.querySelectorAll('.evidence-mark')).toHaveLength(0)
    rerender({ attempt, marks: selected })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    expect(container.querySelectorAll('.evidence-mark')).toHaveLength(anchor.producer_observations.length)
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled()
  })
  it('does not navigate the PDF when marks repaint after selecting a value', () => {
    const { rerender, attempt, marks, key, viewer } = fixture()
    viewer.scrollPageIntoView.mockClear()
    rerender({ attempt, marks: { ...marks, selected: key } })
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled()
  })
  it('clears an earlier passage outline when another Evidence mark selects its result, without navigating', () => {
    const { result, rerender, attempt, marks, key, container, anchor, viewer } = fixture()
    act(() => result.current(anchor))
    rerender({ attempt, marks: { ...marks, selected: key } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
    viewer.scrollPageIntoView.mockClear()
    rerender({ attempt, marks: { ...marks, selected: 'other', savedLinks: [
      ...marks.savedLinks, { key: 'other', link: { ...marks.savedLinks[0]!.link, evidenceAnchorId: 'other-anchor' } },
    ] } })
    expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
    expect(viewer.scrollPageIntoView).not.toHaveBeenCalled()
  })
})

describe('value marks', () => {
  const parsedDocument = decodeParsedDocument(parsedFixture)
  const anchor = parsedDocument.evidence_index.anchors[0]!
  const bbox = verifiedEvidenceBbox(parsedDocument, anchor.producer_observations[0]!)!
  const inside = { x0: bbox.x0 + 2, y0: bbox.y0 + 1, x1: bbox.x0 + 20, y1: bbox.y0 + 8 }
  const key = JSON.stringify(['records', 0, 'title'])
  function paint(valueBoxes: EvidenceLink['valueBoxes'], precision: EvidenceLink['precision'] = 'segment', selected: string | null = key) {
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${anchor.producer_observations[0]!.page_number}"></div>`
    document.body.append(container)
    const listeners = new Map<string, () => void>()
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: { on: (event: string, paint: () => void) => listeners.set(event, paint), off: (event: string) => listeners.delete(event) } }
    const marks: RailMarks = { describe: new Map<string, MarkInfo>([[key, { name: 'title', value: 'Alpha', word: null, style: 'link', anchorId: anchor.anchor_id }]]), selected, onSelect: vi.fn(),
      savedLinks: [{ key, link: { resultPath: ['records', 0, 'title'], evidenceAnchorId: anchor.anchor_id, precision, valueBoxes } }] }
    // jsdom lays nothing out: the document is given a height, so the overview has one to place its ticks in.
    const overview = document.createElement('div')
    Object.defineProperty(container, 'scrollHeight', { value: 1000 })
    // One ref object for the hook's life, as the workspace's are: a new one would rightly drop the marks.
    const containerRef = { current: container }, viewerRef = { current: viewer as never }, overviewRef = { current: overview }
    const hook = renderHook((props: { marks: RailMarks; active?: boolean }) => useEvidenceOverlays({
      containerRef, viewerRef, parsedDocument, attempt: { extractionId: 'run' }, active: props.active ?? true, marks: props.marks, overviewRef,
    }), { initialProps: { marks } as { marks: RailMarks; active?: boolean } })
    return { ...hook, marks, container, listeners, overview, values: () => container.querySelectorAll<HTMLElement>('.parsed-evidence-value') }
  }

  it('draws one inert element per box for the selected value, beside its block mark, and repaints on a page render', () => {
    const second = { ...inside, y0: bbox.y0 + 9, y1: bbox.y0 + 16 }
    const { container, values, listeners } = paint([inside, second])
    expect(values()).toHaveLength(2)
    expect(container.querySelectorAll('button.evidence-mark.valued').length).toBeGreaterThan(0)
    values().forEach((mark) => {
      expect(mark!.classList.contains('selected')).toBe(true)
      expect(mark.tagName).toBe('DIV')
      expect(mark.getAttribute('aria-hidden')).toBe('true')
    })
    expect(container.querySelectorAll('button.evidence-mark')).toHaveLength(anchor.producer_observations.length)
    container.querySelector('.page')!.querySelectorAll('.parsed-evidence-value').forEach((mark) => mark.remove())
    act(() => listeners.get('pagerendered')!())
    expect(values()).toHaveLength(2)
  })

  it('draws an unselected value too, quieter, and lights it with its hovered value', () => {
    const { rerender, marks, values, container } = paint([inside], 'segment', null)
    expect(values()).toHaveLength(1)
    expect(values()[0]!.classList.contains('selected')).toBe(false)
    rerender({ marks: { ...marks, hovered: [key] } })
    expect(values()[0]!.classList.contains('hovered')).toBe(true)
    expect(container.querySelector('.evidence-mark.valued')).not.toBeNull()
  })

  it('picks its one value in Results on a click, lights only that value, and stays the same element as it repaints', () => {
    const { rerender, marks, values } = paint([inside], 'segment', null)
    const onHover = vi.fn(), hoverable = { ...marks, onHover }
    rerender({ marks: hoverable })
    const mark = values()[0]!
    expect(mark.style.pointerEvents).toBe('auto')
    expect(mark.title).toBe('')
    mark.click()
    expect(marks.onSelect).toHaveBeenCalledWith([key], mark)
    mark.dispatchEvent(new MouseEvent('mousemove'))
    expect(onHover).toHaveBeenLastCalledWith([key])
    expect(mark.parentElement!.querySelector('.evidence-mark-name')!.textContent).toBe('title')
    // Picking the value takes its name tag away: Results now shows it.
    mark.click()
    expect(mark.parentElement!.querySelector('.evidence-mark-name')).toBeNull()
    rerender({ marks: { ...hoverable, hovered: [key] } })
    expect(values()[0]).toBe(mark)
    // A value the rail does not name has nothing to pick.
    rerender({ marks: { ...hoverable, describe: new Map() } })
    expect(values()[0]!.style.pointerEvents).toBe('none')
    expect(values()[0]!.title).toBe('')
  })

  it('carries its own link in its underline, thinner once decided, and leaves its block without one', () => {
    const { rerender, marks, values, container } = paint([inside], 'segment', null)
    expect([...values()[0]!.classList]).toContain('link')
    rerender({ marks: { ...marks, describe: new Map([[key, { ...marks.describe.get(key)!, style: 'doubtful', word: 'Approved' }]]) } })
    expect([...values()[0]!.classList]).toEqual(expect.arrayContaining(['doubtful', 'decided']))
    const block = container.querySelector<HTMLElement>('button.evidence-mark')!
    expect(block.classList.contains('valued')).toBe(true)
    expect(block.getAttribute('aria-label')).toBe('title: Alpha, uncertain, Approved')
  })

  it('keeps the block underline for a value with no mark of its own, and gives a block of several fields a neutral colour', () => {
    const { rerender, marks, values, container } = paint([inside], 'segment', null)
    const other = JSON.stringify(['records', 0, 'subtitle'])
    rerender({ marks: { ...marks,
      describe: new Map([[key, { ...marks.describe.get(key)!, color: '#e15759' }], [other, { name: 'subtitle', value: 'Beta', word: null, style: 'rule', anchorId: anchor.anchor_id, color: '#59a14f' }]]),
      savedLinks: [...marks.savedLinks!, { key: other, link: { resultPath: ['records', 0, 'subtitle'], evidenceAnchorId: anchor.anchor_id, precision: 'segment' } }] } })
    const block = container.querySelector<HTMLElement>('button.evidence-mark')!
    expect(block.classList.contains('valued')).toBe(false)
    expect(block.classList.contains('rule')).toBe(true)
    expect(block.style.getPropertyValue('--color-ev')).toBe('var(--color-ink-faint)')
    expect(values()[0]!.style.getPropertyValue('--color-ev')).toBe('#e15759')
  })

  it('ticks each block mark in the overview, the selected one marked, and clears them when the rail goes inactive', () => {
    const { rerender, marks, overview, container } = paint([inside])
    const blocks = container.querySelectorAll('.parsed-evidence-highlight').length
    expect(overview.querySelectorAll('.evidence-tick')).toHaveLength(blocks)
    expect(overview.querySelectorAll('.evidence-tick.selected').length).toBeGreaterThan(0)
    rerender({ marks: { ...marks, selected: null } })
    expect(overview.querySelectorAll('.evidence-tick.selected')).toHaveLength(0)
    rerender({ marks, active: false })
    expect(overview.children).toHaveLength(0)
  })

  it('draws nothing for page-only precision, or when a box lies outside its anchor', () => {
    expect(paint([inside], 'input').values()).toHaveLength(0)
    expect(paint(undefined).container.querySelector('.evidence-mark.valued')).toBeNull()
    expect(paint([inside, { ...inside, x1: bbox.x1 + 3 }]).values()).toHaveLength(0)
    expect(paint([{ ...inside, y0: bbox.y0 - 3 }]).values()).toHaveLength(0)
    // A box within 2pt of the anchor's edge still counts.
    expect(paint([{ ...inside, x1: bbox.x1 + 2 }]).values()).toHaveLength(1)
  })

  it('keeps the value mark, unselected, when the selection changes; removes it when the rail goes inactive or the hook unmounts', () => {
    const { rerender, marks, values, unmount, container } = paint([inside])
    rerender({ marks: { ...marks, selected: 'other' } })
    expect(values()).toHaveLength(1)
    expect(values()[0]!.classList.contains('selected')).toBe(false)
    rerender({ marks })
    expect(values()).toHaveLength(1)
    expect(values()[0]!.classList.contains('selected')).toBe(true)
    rerender({ marks, active: false })
    expect(values()).toHaveLength(0)
    rerender({ marks })
    unmount()
    expect(container.querySelectorAll('.parsed-evidence-value')).toHaveLength(0)
  })

  it('scrolls to the value mark when the rail navigates to its link, and to the block otherwise', () => {
    const { result, marks, values, container } = paint([inside])
    container.scrollTo = vi.fn()
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('parsed-evidence-value') ? new DOMRect(10, 900, 20, 10)
        : this.classList.contains('parsed-evidence-focus') ? new DOMRect(10, 3000, 100, 40) : new DOMRect(0, 0, 500, 600)
    })
    act(() => result.current(anchor, marks.savedLinks![0]!.link))
    expect(values()).toHaveLength(1)
    expect(container.scrollTo).toHaveBeenCalledTimes(1)
    const valueTop = (vi.mocked(container.scrollTo).mock.calls[0]![0] as ScrollToOptions).top
    vi.mocked(container.scrollTo).mockClear()
    act(() => result.current(anchor))
    expect((vi.mocked(container.scrollTo).mock.calls[0]![0] as ScrollToOptions).top).not.toBe(valueTop)
    rect.mockRestore()
  })
})
