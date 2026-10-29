// @vitest-environment jsdom

import { act, cleanup, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import type { EvidenceLink } from '../shared/groundedExtraction'
import parsedFixture from './assets/parsed_document.v2.json'
import { useEvidenceOverlays } from './useEvidenceOverlays'
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

  it.each([[false, 1], [true, 0]])('shows the focus again once the text layer narrows it, unless the researcher scrolled since (scrolled: %s)', (scrolled, scrolls) => {
    const block = 'Alpha Beta Gamma'
    const parsedDocument = decodeParsedDocument(JSON.parse(JSON.stringify(parsedFixture).replaceAll('"bundled-anchor"', '"a_s1"').replace('"Unit 7"', JSON.stringify(block))))
    const anchor = parsedDocument.evidence_index.anchors[0]!
    const occurrence = anchor.producer_observations[0]!, bbox = verifiedEvidenceBbox(parsedDocument, occurrence)!
    const page = parsedDocument.pages.find((each) => each.page_number === occurrence.page_number)!
    const link = { resultPath: ['records', 0, 'gamma'], evidenceAnchorId: anchor.anchor_id, precision: 'segment',
      grounding: { textSpans: [{ segment: 's1', start: 11, end: 16 }] } } as EvidenceLink
    const container = document.createElement('div')
    container.innerHTML = `<div class="page" data-page-number="${occurrence.page_number}"></div>`
    container.scrollTo = vi.fn()
    document.body.append(container)
    const listeners = new Map<string, () => void>()
    const viewer = { scrollPageIntoView: vi.fn(), eventBus: {
      on: (event: string, paint: () => void) => listeners.set(event, paint), off: (event: string) => listeners.delete(event) } }
    // The block's focus shows in the pane; the quote's box, once the text layer has drawn, lies below it.
    let focusRect = new DOMRect(10, 100, 200, 60)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('parsed-evidence-focus') ? focusRect
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
    expect(container.scrollTo).not.toHaveBeenCalled()
    if (scrolled) fireEvent.wheel(container)
    container.querySelector('.page')!.insertAdjacentHTML('afterbegin', `<div class="textLayer"><span>${block}</span></div>`)
    focusRect = new DOMRect(10, 900, 40, 12)
    act(() => listeners.get('textlayerrendered')!())
    expect(container.scrollTo).toHaveBeenCalledTimes(scrolls)
    // Later renders that leave the focus as it is never scroll the source again.
    act(() => listeners.get('pagerendered')!())
    expect(container.scrollTo).toHaveBeenCalledTimes(scrolls)
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
    expect(mark.getAttribute('aria-label')).toBe('title: Alpha, Approved; subtitle: Beta')
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
    mark.dispatchEvent(new MouseEvent('mouseenter'))
    expect(onHover).toHaveBeenLastCalledWith([key])
    mark.dispatchEvent(new MouseEvent('mouseleave'))
    expect(onHover).toHaveBeenLastCalledWith(null)
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
  it('a value\'s parts in one passage share its mark in their field\'s colour, and each boxes its own quote on a text layer', () => {
    // The fixture's one passage, renamed as a segment's anchor and holding two values' quotes; spans count code points.
    const block = '𝛼 Alpha Beta Gamma'
    const parsedDocument = decodeParsedDocument(JSON.parse(JSON.stringify(parsedFixture).replaceAll('"bundled-anchor"', '"a_s1"').replace('"Unit 7"', JSON.stringify(block))))
    const anchor = parsedDocument.evidence_index.anchors[0]!
    const occurrence = anchor.producer_observations[0]!, bbox = verifiedEvidenceBbox(parsedDocument, occurrence)!
    const page = parsedDocument.pages.find((each) => each.page_number === occurrence.page_number)!
    const part = (name: string, start: number) => ({ key: `v#["${name}"]`, link: { resultPath: ['records', 0, 's', name], evidenceAnchorId: anchor.anchor_id,
      precision: 'segment', grounding: { textSpans: [{ segment: anchor.anchor_id.slice(2), start, end: start + 3 }] } } as EvidenceLink })
    const parts = [part('a', 2), part('b', [...block].length - 3)]
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
    // No text layer (a scanned page): one block mark naming both parts, selected with its value.
    const [shared, ...rest] = render('')
    expect(rest).toHaveLength(0)
    expect(shared!.getAttribute('aria-label')).toBe('v#["a"]: v#["a"]; v#["b"]: v#["b"]')
    expect(shared!.getAttribute('aria-current')).toBe('true')
    expect(shared!.style.getPropertyValue('--color-ev')).toBe('#e15759')
    // A text layer in page points: the block's text in one span over its box; a range's rect spans its characters.
    let runReads = 0
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.tagName === 'SPAN') runReads++
      return this.classList.contains('textLayer') ? new DOMRect(0, 0, page.width_pt, page.height_pt)
        : new DOMRect(bbox.x0, bbox.y0, bbox.x1 - bbox.x0, bbox.y1 - bbox.y0)
    })
    let range = [0, 0]
    vi.spyOn(document, 'createRange').mockImplementation(() => ({
      setStart: (_: Node, at: number) => { range = [at, range[1]!] }, setEnd: (_: Node, at: number) => { range = [range[0]!, at] },
      getClientRects: () => [new DOMRect(bbox.x0 + range[0]!, bbox.y0, range[1]! - range[0]!, 10)],
    }) as unknown as Range)
    const narrowed = render(`<div class="textLayer"><span>${block}</span></div>`)
    expect(narrowed.map((mark) => mark.getAttribute('aria-label'))).toEqual(['v#["a"]: v#["a"]', 'v#["b"]: v#["b"]'])
    // The paint reads the layer's runs once, not once per link: per link, a long document's paint froze the page.
    expect(runReads).toBe(1)
    // A range's offsets are UTF-16 units: "Alp" starts at 3, "mma" 3 before the end.
    expect(parseFloat(narrowed[0]!.style.left)).toBeCloseTo(((bbox.x0 + 3 - 1) / page.width_pt) * 100)
    expect(parseFloat(narrowed[1]!.style.left)).toBeCloseTo(((bbox.x0 + block.length - 3 - 1) / page.width_pt) * 100)
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
