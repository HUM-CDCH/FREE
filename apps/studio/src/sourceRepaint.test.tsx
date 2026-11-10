// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import parsedFixture from './assets/parsed_document.v2.json'
import { useEvidenceOverlays, type RailMarkState } from './useEvidenceOverlays'
import DocumentMarkdown from './DocumentMarkdown'
import { createSelectionChannel } from './selectionChannel'
import ReviewList from './ReviewList'
import type { RailModel, RailRow } from './reviewVocabulary'

afterEach(() => { cleanup(); vi.restoreAllMocks(); document.body.replaceChildren() })

/** 150 values on page one, plus a second page whose overlays must survive a page-one render. */
function source() {
  const parsedDocument = decodeParsedDocument(parsedFixture)
  const template = parsedDocument.evidence_index.anchors[0]!
  if (template.kind !== 'text') throw new Error('The synthetic fixture needs a text anchor')
  const markdown = Array.from({ length: 152 }, (_, i) => `Value ${String(i).padStart(3, '0')}\n`).join('')
  parsedDocument.evidence_index.anchors = Array.from({ length: 152 }, (_, i) => ({ ...template,
    anchor_id: `a${i}`, markdown_span: { start: i * 10, end: i * 10 + 9 },
    producer_observations: [{ ...template.producer_observations[0]!, occurrence_id: `o${i}`, page_number: i < 150 ? 1 : 2 }],
  }))
  const marks: RailMarkState = { selected: 'v0',
    describe: new Map(parsedDocument.evidence_index.anchors.map((_, i) => [`v${i}`, {
      name: 'field', value: String(i), word: null, style: 'link',
    }])),
    savedLinks: parsedDocument.evidence_index.anchors.map((anchor, i) => ({ key: `v${i}`, link: {
      resultPath: ['records', i, 'field'], evidenceAnchorId: anchor.anchor_id, precision: 'segment',
      valueBoxes: [{ x0: 40, y0: 40, x1: 60, y1: 48 }],
    } })),
  }
  return { parsedDocument, markdown, marks }
}

const pageDivs = '<div class="page" data-page-number="1" style="position:relative"></div><div class="page" data-page-number="2" style="position:relative"></div>'
function overlays(deferredPages = false) {
  const { parsedDocument, marks } = source()
  const container = document.createElement('div'), overview = document.createElement('div')
  if (!deferredPages) container.innerHTML = pageDivs
  document.body.append(container, overview)
  Object.defineProperty(container, 'scrollHeight', { value: 2000 })
  const listeners = new Set<(event: { pageNumber: number; cssTransform?: boolean }) => void>(), scales = new Set<() => void>(), initializers = new Set<() => void>()
  const viewer = { scrollPageIntoView: vi.fn(), eventBus: {
    on: (event: string, paint: (event: { pageNumber: number }) => void) => event === 'pagerendered' ? listeners.add(paint) : (event === 'pagesinit' ? initializers : scales).add(paint as () => void),
    off: (event: string, paint: (event: { pageNumber: number }) => void) => event === 'pagerendered' ? listeners.delete(paint) : (event === 'pagesinit' ? initializers : scales).delete(paint as () => void),
  } }
  const containerRef = { current: container }, viewerRef = { current: viewer as never }, overviewRef = { current: overview }
  const hoverChannel = createSelectionChannel()
  hoverChannel.publish({ marks: { ...marks, extractionId: 'repaint' }, dim: marks.savedLinks[0]!.link })
  const hook = renderHook(() => useEvidenceOverlays({ containerRef, viewer: viewerRef.current, overviewRef, parsedDocument,
    extractionId: 'repaint', active: true, onSelect: vi.fn(), selection: hoverChannel }))
  return { ...hook, container, overview, listeners, scales, initializers, parsedDocument, hoverChannel }
}

it('seeds off-screen marks and ticks when page divs arrive after the saved values', async () => {
  const { container, overview, initializers } = overlays(true)
  expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(0)
  container.innerHTML = pageDivs
  act(() => initializers.forEach(initialize => initialize()))
  expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(152)
  expect(overview.children).toHaveLength(152)
})

it('lights only affected marks and ticks on hover without layout reads or repainting', async () => {
  const { container, overview, hoverChannel } = overlays()
  const tick = overview.firstChild
  const computed = vi.spyOn(window, 'getComputedStyle'), rect = vi.spyOn(Element.prototype, 'getBoundingClientRect')
  act(() => hoverChannel.hover(['v0']))
  const observer = new MutationObserver(() => {})
  observer.observe(container, { subtree: true, attributes: true, childList: true })
  observer.observe(overview, { subtree: true, attributes: true, childList: true })
  act(() => hoverChannel.hover(['v1']))
  const changes = observer.takeRecords(); observer.disconnect()
  expect(changes.length).toBe(6) // the old and new block, value and overview tick, once each
  expect(changes.every(change => change.type === 'attributes' && change.attributeName === 'class')).toBe(true)
  expect(container.querySelectorAll('.evidence-mark.hovered')).toHaveLength(1)
  expect(container.querySelectorAll('.evidence-value-mark.hovered')).toHaveLength(1)
  expect(overview.querySelectorAll('.hovered')).toHaveLength(1)
  expect(overview.firstChild).toBe(tick)
  expect(computed).not.toHaveBeenCalled()
  expect(rect).not.toHaveBeenCalled()
})

it('paints 150 values without per-mark page queries or computed-style reads', async () => {
  const computed = vi.spyOn(window, 'getComputedStyle')
  const query = vi.spyOn(Element.prototype, 'querySelector')
  const { container } = overlays()
  expect(container.querySelectorAll('.parsed-evidence-value')).toHaveLength(152)
  const lookups = query.mock.calls.filter(([selector]) => selector.startsWith('.page[')).length
  expect(lookups).toBeLessThanOrEqual(2)
  expect(computed).not.toHaveBeenCalled()
})

it('repaints only the rendered page, retaining other marks, focus, dimming and overview ticks', async () => {
  const { container, overview, listeners, result, parsedDocument } = overlays()
  act(() => result.current(parsedDocument.evidence_index.anchors[0]!))
  const page2 = container.querySelector('[data-page-number="2"]')!
  const mark = page2.querySelector('.parsed-evidence-highlight')!
  const tick = overview.lastChild
  const changes: MutationRecord[] = []
  const observer = new MutationObserver(records => changes.push(...records))
  observer.observe(page2, { subtree: true, attributes: true, childList: true })
  act(() => listeners.forEach(paint => paint({ pageNumber: 1 })))
  changes.push(...observer.takeRecords()); observer.disconnect()
  expect(changes).toHaveLength(0)
  expect(page2.querySelector('.parsed-evidence-highlight')).toBe(mark)
  expect(overview.lastChild).toBe(tick)
})

it('ignores CSS-transform-only page render events for marks, dimming and focus', async () => {
  const { container, overview, listeners, result, parsedDocument } = overlays()
  act(() => result.current(parsedDocument.evidence_index.anchors[0]!))
  const before = container.innerHTML, tick = overview.firstChild
  const computed = vi.spyOn(window, 'getComputedStyle')
  act(() => listeners.forEach(paint => paint({ pageNumber: 1, cssTransform: true })))
  expect(container.innerHTML === before).toBe(true)
  expect(overview.firstChild).toBe(tick)
  expect(computed).not.toHaveBeenCalled()
})

it('keeps off-screen overview ticks through a zoom that resets their page before it renders', async () => {
  const { container, overview, scales, listeners } = overlays()
  const ticks = [...overview.children]
  container.querySelector('[data-page-number="2"]')!.replaceChildren()
  act(() => scales.forEach(scale => scale()))
  expect([...overview.children]).toEqual(ticks)
  act(() => listeners.forEach(paint => paint({ pageNumber: 1 })))
  expect([...overview.children]).toEqual(ticks)
  act(() => listeners.forEach(paint => paint({ pageNumber: 2 })))
  expect([...overview.children]).toEqual(ticks)
  expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(152)
})

it('retains Markdown encoding through Results publications with fresh descriptions and links', async () => {
  const { markdown, parsedDocument, marks } = source()
  const encode = vi.spyOn(TextEncoder.prototype, 'encode')
  const selection = createSelectionChannel(), onSelect = vi.fn()
  selection.publish({ marks: { ...marks, extractionId: 'markdown' } })
  const { rerender } = render(<DocumentMarkdown markdown={markdown} document={parsedDocument} selection={selection} extractionId="markdown" onSelect={onSelect} />)
  encode.mockClear()
  await act(async () => selection.publish({ marks: { ...marks, describe: new Map(marks.describe), savedLinks: [...marks.savedLinks], extractionId: 'markdown', selected: 'v1' } }))
  await act(async () => selection.publish({ marks: { ...marks, describe: new Map(marks.describe), savedLinks: [...marks.savedLinks], extractionId: 'markdown', selected: 'v2' } }))
  rerender(<DocumentMarkdown markdown={markdown} document={parsedDocument} selection={selection} extractionId="markdown" onSelect={onSelect} />)
  expect(encode.mock.calls.length).toBe(0)
})

it('lights Results rows and collapsed headers directly, including a hovered part, without rendering rows', async () => {
  const rows: RailRow[] = Array.from({ length: 150 }, (_, i) => ({ key: `v${i}`, name: 'field', value: i, extracted: i,
    resultPath: ['records', 0, 'field'], kind: 'to-check', link: null, decision: null, chip: null, evidence: null, doubt: null, changed: false, page: 1 }))
  const model: RailModel = { document: [], records: [{ index: 0, key: 'record', label: 'Record 1', state: 'finished', page: 1, rows, toCheck: 150 }],
    counts: { toCheck: 150, doubtful: 0, notReviewable: 0, required: 150, approved: 0, edited: 0, rejected: 0 } }
  const selection = createSelectionChannel(), renderRow = vi.fn((row: RailRow) => <span>{row.key}</span>)
  const props = { model, article: false, finding: false, filter: 'all' as const, selectedKey: null,
    linkedKeys: new Set<string>(), selection, onToggle: vi.fn(), renderRow }
  const { container, rerender } = render(<ReviewList {...props} isOpen={() => true} />)
  renderRow.mockClear()
  act(() => selection.hover(['v1#["part"]']))
  expect(container.querySelector('[data-result-key="v1"]')?.classList.contains('hovered')).toBe(true)
  expect(renderRow.mock.calls.length).toBe(0)
  rerender(<ReviewList {...props} isOpen={() => false} />)
  expect(container.querySelector('[aria-expanded="false"]')?.classList.contains('hovered')).toBe(true)
  act(() => selection.hover(null))
  expect(container.querySelector('.hovered')).toBeNull()
})


it('updates saved marks and dimming through the channel without rendering their workspace owner', async () => {
  const { parsedDocument, marks } = source()
  const container = document.createElement('div'), overview = document.createElement('div')
  container.innerHTML = pageDivs
  document.body.append(container, overview)
  const selection = createSelectionChannel(), renders = vi.fn(), onSelect = vi.fn()
  const refs = { containerRef: { current: container }, viewer: null, overviewRef: { current: overview } }
  function Workspace() {
    renders()
    useEvidenceOverlays({ ...refs, parsedDocument, extractionId: 'source', active: true, selection, onSelect })
    return null
  }
  render(<Workspace />)
  renders.mockClear()
  await act(async () => selection.publish({ marks: { ...marks, extractionId: 'source' } }))
  const selected = container.querySelector('.evidence-mark.selected')!
  await act(async () => selection.publish({ marks: { ...marks, selected: 'v1', extractionId: 'source' }, dim: marks.savedLinks[1]!.link }))
  expect(renders).not.toHaveBeenCalled()
  expect(selected.classList.contains('selected')).toBe(false)
  expect(container.querySelectorAll('.evidence-mark.selected')).toHaveLength(1)
  expect(container.querySelectorAll('.evidence-dim').length).toBeGreaterThan(0)
})

it('honors an initial Evidence navigation from a child effect before the source presenter subscribes', async () => {
  const { parsedDocument } = source()
  const container = document.createElement('div')
  container.innerHTML = pageDivs
  document.body.append(container)
  const selection = createSelectionChannel(), onSelect = vi.fn()
  const refs = { containerRef: { current: container }, viewer: { scrollPageIntoView: vi.fn() } as never }
  function InitialNavigation({ locate }: { locate: ReturnType<typeof useEvidenceOverlays> }) {
    useEffect(() => locate(parsedDocument.evidence_index.anchors[0]!), [locate])
    return null
  }
  function Workspace() {
    const locate = useEvidenceOverlays({ ...refs, parsedDocument, extractionId: 'source', active: true, selection, onSelect })
    return <InitialNavigation locate={locate} />
  }
  render(<Workspace />)
  expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
})


it('combines one-by-one marks, dimming and navigation into one source paint', async () => {
  const { container, hoverChannel: selection, result, parsedDocument } = overlays()
  const marks = selection.snapshot().marks!, link = marks.savedLinks[1]!.link
  const query = vi.spyOn(container, 'querySelectorAll')
  await act(async () => {
    selection.publish({ marks: { ...marks, selected: 'v1' } })
    selection.publish({ dim: link })
    result.current(parsedDocument.evidence_index.anchors[1]!, link)
  })
  expect(query.mock.calls.filter(([selector]) => selector === '.page')).toHaveLength(1)
  expect(container.querySelectorAll('.evidence-mark.selected')).toHaveLength(1)
  expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(0)
})

it('retires hover when layout moves a mark away from a stationary pointer', () => {
  const { container, hoverChannel: selection } = overlays()
  const mark = container.querySelector<HTMLElement>('.parsed-evidence-value')!
  mark.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  expect(selection.snapshot().hover).toEqual(['v0'])
  // Browsers send mouseout when scrolling changes the hit target, even though the pointer did not move.
  mark.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: mark.parentElement }))
  expect(selection.snapshot().hover).toBeNull()
  expect(container.querySelector('.evidence-mark-name')).toBeNull()
})

it('honors explicit Evidence navigation after a queued selection clear in the same turn', async () => {
  const { container, hoverChannel: selection, result, parsedDocument } = overlays()
  await act(async () => {
    selection.publish({ marks: { ...selection.snapshot().marks!, selected: null } })
    result.current(parsedDocument.evidence_index.anchors[0]!)
  })
  expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
  expect(container.querySelectorAll('.evidence-mark.selected')).toHaveLength(0)
})


it('retires the channel hover when a visible mark becomes decorative focus', async () => {
  const { parsedDocument, marks } = source()
  const container = document.createElement('div')
  container.innerHTML = pageDivs
  document.body.append(container)
  const selection = createSelectionChannel(), onSelect = vi.fn()
  selection.publish({ marks: { ...marks, selected: null, extractionId: 'source' } })
  const refs = { containerRef: { current: container }, viewer: null }
  const { result, rerender } = renderHook(({ marksShown }) => useEvidenceOverlays({
    ...refs, parsedDocument, extractionId: 'source', active: true, marksShown, selection, onSelect,
  }), { initialProps: { marksShown: true } })
  act(() => result.current(parsedDocument.evidence_index.anchors[0]!))
  const mark = container.querySelector<HTMLElement>('.parsed-evidence-focus')!
  mark.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  expect(selection.snapshot().hover).toEqual(['v0'])
  await act(async () => rerender({ marksShown: false }))
  expect(selection.snapshot().hover).toBeNull()
  expect(container.querySelector('.evidence-mark-name')).toBeNull()
  expect(container.querySelector('.parsed-evidence-focus')?.tagName).toBe('DIV')
})


it('keeps hover through zoom without scanning or reparsing hover targets', () => {
  const { container, overview, hoverChannel, scales } = overlays()
  act(() => hoverChannel.hover(['v1']))
  const query = vi.spyOn(container, 'querySelectorAll'), parse = vi.spyOn(JSON, 'parse')
  act(() => scales.forEach(scale => scale()))
  expect(query.mock.calls.some(([selector]) => selector === '[data-hover-keys]')).toBe(false)
  expect(parse).not.toHaveBeenCalled()
  expect(overview.querySelector('.hovered')?.getAttribute('data-occurrence-id')).toBe('o1')
})

it('moves page subscriptions and navigation to a replacement viewer without losing the located passage', () => {
  const { parsedDocument } = source()
  const container = document.createElement('div')
  container.innerHTML = pageDivs
  document.body.append(container)
  const createViewer = () => {
    const events = new Map<string, Set<(...args: never[]) => void>>()
    return { scrollPageIntoView: vi.fn(), eventBus: {
      on: (name: string, handler: (...args: never[]) => void) => {
        if (!events.has(name)) events.set(name, new Set())
        events.get(name)!.add(handler)
      },
      off: (name: string, handler: (...args: never[]) => void) => events.get(name)?.delete(handler),
      dispatch: (name: string) => events.get(name)?.forEach(handler => handler()),
    }, events }
  }
  const first = createViewer(), second = createViewer(), selection = createSelectionChannel()
  const containerRef = { current: container }, onSelect = vi.fn()
  const { result, rerender, unmount } = renderHook(({ viewer }) => useEvidenceOverlays({
    containerRef, viewer: viewer as never, parsedDocument, extractionId: 'replace', selection, onSelect, active: true,
  }), { initialProps: { viewer: first as typeof first | null } })
  const anchor = parsedDocument.evidence_index.anchors[0]!
  act(() => result.current(anchor, { evidenceAnchorId: anchor.anchor_id, resultPath: [], precision: 'input' }))
  expect(first.scrollPageIntoView).toHaveBeenCalledOnce()
  act(() => result.current(anchor))
  expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
  rerender({ viewer: null })
  expect([...first.events.values()].every(handlers => handlers.size === 0)).toBe(true)
  rerender({ viewer: second })
  container.innerHTML = pageDivs
  act(() => first.eventBus.dispatch('pagerendered'))
  expect(container.querySelector('.parsed-evidence-focus')).toBeNull()
  act(() => second.eventBus.dispatch('pagesinit'))
  expect(container.querySelectorAll('.parsed-evidence-focus')).toHaveLength(1)
  expect(second.scrollPageIntoView).not.toHaveBeenCalled()
  act(() => result.current(anchor, { evidenceAnchorId: anchor.anchor_id, resultPath: [], precision: 'input' }))
  expect(second.scrollPageIntoView).toHaveBeenCalledOnce()
  unmount()
  expect([...second.events.values()].every(handlers => handlers.size === 0)).toBe(true)
})
