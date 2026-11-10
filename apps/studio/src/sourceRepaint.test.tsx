// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import parsedFixture from './assets/parsed_document.v2.json'
import { useEvidenceOverlays, type RailMarks } from './useEvidenceOverlays'
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
  const marks: RailMarks = { selected: 'v0', onSelect: vi.fn(),
    describe: new Map(parsedDocument.evidence_index.anchors.map((anchor, i) => [`v${i}`, {
      name: 'field', value: String(i), word: null, style: 'link', anchorId: anchor.anchor_id,
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
  const hook = renderHook(() => useEvidenceOverlays({ containerRef, viewerRef, overviewRef, parsedDocument,
    attempt: { extractionId: 'repaint' }, active: true, marks, dimLink: marks.savedLinks![0]!.link, hoverChannel }))
  return { ...hook, container, overview, listeners, scales, initializers, parsedDocument, hoverChannel }
}

it('seeds off-screen marks and ticks when page divs arrive after the saved values', () => {
  const { container, overview, initializers } = overlays(true)
  expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(0)
  container.innerHTML = pageDivs
  act(() => initializers.forEach(initialize => initialize()))
  expect(container.querySelectorAll('.parsed-evidence-highlight')).toHaveLength(152)
  expect(overview.children).toHaveLength(152)
})

it('lights only affected marks and ticks on hover without layout reads or repainting', () => {
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

it('paints 150 values without per-mark page queries or computed-style reads', () => {
  const computed = vi.spyOn(window, 'getComputedStyle')
  const query = vi.spyOn(Element.prototype, 'querySelector')
  const { container } = overlays()
  expect(container.querySelectorAll('.parsed-evidence-value')).toHaveLength(152)
  const lookups = query.mock.calls.filter(([selector]) => selector.startsWith('.page[')).length
  expect(lookups).toBeLessThanOrEqual(2)
  expect(computed).not.toHaveBeenCalled()
})

it('repaints only the rendered page, retaining other marks, focus, dimming and overview ticks', () => {
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

it('ignores CSS-transform-only page render events for marks, dimming and focus', () => {
  const { container, overview, listeners, result, parsedDocument } = overlays()
  act(() => result.current(parsedDocument.evidence_index.anchors[0]!))
  const before = container.innerHTML, tick = overview.firstChild
  const computed = vi.spyOn(window, 'getComputedStyle')
  act(() => listeners.forEach(paint => paint({ pageNumber: 1, cssTransform: true })))
  expect(container.innerHTML === before).toBe(true)
  expect(overview.firstChild).toBe(tick)
  expect(computed).not.toHaveBeenCalled()
})

it('keeps off-screen overview ticks through a zoom that resets their page before it renders', () => {
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

it('retains Markdown encoding and spans through selection and parent renders', () => {
  const { markdown, parsedDocument, marks } = source()
  const encode = vi.spyOn(TextEncoder.prototype, 'encode')
  const { rerender } = render(<DocumentMarkdown markdown={markdown} document={parsedDocument} marks={marks} />)
  encode.mockClear()
  rerender(<DocumentMarkdown markdown={markdown} document={parsedDocument} marks={{ ...marks, selected: 'v1' }} />)
  rerender(<DocumentMarkdown markdown={markdown} document={parsedDocument} marks={{ ...marks, selected: 'v2' }} />)
  expect(encode.mock.calls.length).toBe(0)
})

it('lights Results rows and collapsed headers directly, including a hovered part, without rendering rows', () => {
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
  expect(container.querySelector('[data-result-key="v1"]')?.getAttribute('data-evidence-hovered')).toBe('true')
  expect(renderRow.mock.calls.length).toBe(0)
  rerender(<ReviewList {...props} isOpen={() => false} />)
  expect(container.querySelector('[aria-expanded="false"]')?.getAttribute('data-evidence-hovered')).toBe('true')
  act(() => selection.hover(null))
  expect(container.querySelector('[data-evidence-hovered]')).toBeNull()
})
