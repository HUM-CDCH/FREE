// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { plannedRecords } from 'extraction/durable-contract'
import type { ParsedDocument } from 'extraction/parsed-document'
import DocumentMarkdown from './DocumentMarkdown'
import { recordBlocks, recordPieces, recordSpans, type RecordBlock } from './recordBlocks'
import { createSelectionChannel } from './selectionChannel'
import { useEvidenceOverlays } from './useEvidenceOverlays'

afterEach(() => { cleanup(); document.body.replaceChildren() })

type Corners = [number, number, number, number]
const box = ([x0, y0, x1, y1]: Corners) => ({ x0, y0, x1, y1 })
/** A one-page source as Studio parses it: each segment's block, anchor and Markdown, a table's cells with theirs. */
function source(segments: { segment: string; kind: 'heading' | 'paragraph' | 'list' | 'table'; text: string; at: Corners
  cells?: { id: string; row: number; column: number; text: string; at: Corners }[] }[]) {
  const encoder = new TextEncoder(), content_stream: unknown[] = [], anchors: unknown[] = [], tables: unknown[] = []
  let markdown = ''
  for (const { segment, kind, text, at, cells } of segments) {
    if (markdown) markdown += '\n\n'
    const start = encoder.encode(markdown).length
    markdown += kind === 'heading' ? `# ${text}` : kind === 'list' ? text.split('\n').map(item => `- ${item}`).join('\n') : text
    const markdown_span = { start, end: encoder.encode(markdown).length }, placed = (id: string, bbox: Corners) => [{ occurrence_id: id, page_number: 1, bbox: box(bbox) }]
    content_stream.push({ block_id: `b_${segment}`, page_number: 1, bbox: box(at), markdown_span, kind,
      ...(kind === 'heading' ? { text, level: 1 } : kind === 'list' ? { items: text.split('\n'), ordered: false } : kind === 'table' ? { table_id: `t_${segment}` } : { text }) })
    anchors.push({ kind: 'text', anchor_id: `a_${segment}`, block_id: `b_${segment}`, markdown_span, producer_observations: placed(`o_${segment}`, at) })
    if (!cells) continue
    tables.push({ table_id: `t_${segment}`, cells: cells.map(cell => ({ cell_id: cell.id, row: cell.row, column: cell.column, text: cell.text, bbox: box(cell.at), evidence_anchor_id: `a_${segment}_${cell.id}` })) })
    anchors.push(...cells.map(cell => ({ kind: 'table_cell', anchor_id: `a_${segment}_${cell.id}`, producer_observations: placed(`o_${segment}_${cell.id}`, cell.at) })))
  }
  return { document: { content_stream, tables, evidence_index: { anchors }, pages: [{ page_number: 1, width_pt: 600, height_pt: 800 }] } as unknown as ParsedDocument,
    markdown, bytes: encoder.encode(markdown) }
}
const line = (segment: string, start: number, end: number) => ({ segment, start, end })
const closed = (ordinal: number, ...ranges: ReturnType<typeof line>[]): RecordBlock =>
  ({ key: `record:${ordinal}`, state: 'closed', label: `Record ${ordinal + 1}`, segment: ranges[0]!.segment, ranges })
const preview = (label: string, segment: string, ...ranges: ReturnType<typeof line>[]): RecordBlock => ({ key: `preview:${label}`, state: 'preview', label: `Preview · ${label}`, segment, ranges })

// Two entries in one paragraph, the first with a character outside the Basic Multilingual Plane (two UTF-16 units,
// four UTF-8 bytes, one code point for the worker), under a heading and before a list and a second column.
const entries = '1 Vase 𝔸 réd\n2 Bowl blue'
const page = () => source([
  { segment: 'p1_s0', kind: 'heading', text: 'Catalogue', at: [40, 40, 280, 60] },
  { segment: 'p1_s1', kind: 'paragraph', text: entries, at: [40, 70, 280, 110] },
  { segment: 'p1_s2', kind: 'paragraph', text: 'found at the north wall', at: [40, 120, 280, 140] },
  { segment: 'p1_s3', kind: 'paragraph', text: 'and kept in the store', at: [320, 40, 560, 60] },
  { segment: 'p1_s4', kind: 'list', text: 'one\ntwo', at: [320, 70, 560, 110] },
  { segment: 'p1_s5', kind: 'table', text: '3\tJug\n4\tCup\n5\tLid', at: [320, 200, 560, 260], cells: [
    { id: 'r0_c0', row: 0, column: 0, text: '3', at: [320, 200, 360, 220] }, { id: 'r0_c1', row: 0, column: 1, text: 'Jug', at: [360, 200, 560, 220] },
    { id: 'r1_c0', row: 1, column: 0, text: '4', at: [320, 220, 360, 240] }, { id: 'r1_c1', row: 1, column: 1, text: 'Cup', at: [360, 220, 560, 240] },
    { id: 'r2_c0', row: 2, column: 0, text: '5', at: [320, 240, 360, 260] }, { id: 'r2_c1', row: 2, column: 1, text: 'Lid', at: [360, 240, 560, 260] }] },
])

it('a closed record takes over the preview it settles; a preview with nothing left of its own is not shown', () => {
  expect(recordBlocks({ records: [{ ordinal: 0, segment: 'p1_s1', page: 1, ranges: [line('p1_s1', 0, 12)] }, { ordinal: 1, segment: 'p1_s3', page: 1 }],
    discovery: { found: [
      { segment: 'p1_s1', label: '1', ranges: [line('p1_s1', 0, 12)] },
      // Its start is free; its end runs into the closed record's text, which wins.
      { segment: 'p1_s0', label: null, ranges: [line('p1_s0', 0, 9), line('p1_s1', 0, 5)] },
      // Start-only blocks cannot be told apart inside a segment: the closed one stands for it.
      { segment: 'p1_s1', label: '2' }, { segment: 'p1_s3', label: '3', ranges: [line('p1_s3', 0, 4)] },
      { segment: 'p1_s2', label: '4' }] } })).toEqual([
    closed(0, line('p1_s1', 0, 12)), { key: 'record:1', state: 'closed', label: 'Record 2', segment: 'p1_s3', ranges: [] },
    { key: 'preview:1', state: 'preview', label: 'Preview', segment: 'p1_s0', ranges: [line('p1_s0', 0, 9)] },
    { key: 'preview:4', state: 'preview', label: 'Preview · 4', segment: 'p1_s2', ranges: [] }])
})

it('finds each record\'s own lines in the Markdown by code points, and only the whole block where the Markdown rewrites the text', () => {
  const { document, bytes } = page()
  const text = (span: { from: number; to: number }) => new TextDecoder().decode(bytes.subarray(span.from, span.to))
  const spans = recordSpans(document, bytes, [
    closed(0, line('p1_s0', 0, 9), line('p1_s1', 0, 12)), closed(1, line('p1_s1', 13, 24), line('p1_s2', 0, 5)),
    preview('8', 'p1_s4', line('p1_s4', 0, 3)), preview('9', 'p1_s4', line('p1_s4', 4, 7)), preview('old', 'p1_s3')])
  expect(spans.map(span => [text(span), span.state, span.labels, span.exact, span.first])).toEqual([
    ['Catalogue', 'closed', ['Record 1'], true, true], ['1 Vase 𝔸 réd', 'closed', ['Record 1'], true, false],
    ['2 Bowl blue', 'closed', ['Record 2'], true, true], ['found', 'closed', ['Record 2'], true, false],
    // An earlier worker's start: its block.
    ['and kept in the store', 'preview', ['Preview · old'], false, true],
    // A list is written anew in Markdown: both records keep the block, named together.
    ['- one\n- two', 'preview', ['Preview · 8', 'Preview · 9'], false, true]])
})

it('outlines every block of a record as one region down a column, and gives a record its own rows of a table', () => {
  const { document, bytes } = page()
  const blocks = [closed(0, line('p1_s0', 0, 9), line('p1_s1', 0, 12)), closed(1, line('p1_s1', 13, 24), line('p1_s2', 0, 23), line('p1_s3', 0, 21)),
    closed(2, line('p1_s5', 0, 5)), closed(3, line('p1_s5', 6, 17)), preview('1', 'p1_s1', line('p1_s1', 0, 12))]
  const pieces = recordPieces(document, bytes, blocks)
  expect(pieces.map(piece => [piece.state, piece.tag, Object.values(piece.box), piece.start, piece.end])).toEqual([
    // The heading and the paragraph under it: one region.
    ['closed', ['Record 1'], [40, 40, 280, 110], true, true],
    // The paragraph two records share is placed whole, so the second record's region (it and the next block) names it
    // alone; its last block, in the next column, is another region of the same outline, with no tag of its own.
    ['closed', ['Record 2'], [40, 70, 280, 140], true, false], ['closed', [], [320, 40, 560, 60], false, true],
    ['closed', ['Record 3'], [320, 200, 560, 220], true, true], ['closed', ['Record 4'], [320, 220, 560, 260], true, true],
    ['preview', ['Preview · 1'], [40, 70, 280, 110], true, true]])
  // Records that own no more than one shared block share its region; without the Markdown a table is one block too.
  // Regions beginning at one corner are named on one tag, never one tag over another.
  expect(recordPieces(document, null, [closed(0, line('p1_s1', 0, 12)), closed(1, line('p1_s1', 13, 24)), closed(4, line('p1_s1', 13, 24), line('p1_s2', 0, 5)),
    closed(2, line('p1_s5', 0, 5)), closed(3, line('p1_s5', 6, 17))])
    .map(piece => [piece.labels, piece.tag, Object.values(piece.box)])).toEqual([
    [['Record 1', 'Record 2'], ['Record 1', 'Record 2', 'Record 5'], [40, 70, 280, 110]], [['Record 5'], [], [40, 70, 280, 140]],
    [['Record 3', 'Record 4'], ['Record 3', 'Record 4'], [320, 200, 560, 260]]])
})

it('the Markdown view outlines a record\'s lines inside the Evidence mark of their block, which still selects its value', () => {
  const { document, markdown } = page(), selection = createSelectionChannel(), onSelect = vi.fn()
  const marks = { extractionId: 'x', selected: null, describe: new Map([['value', { name: 'title', value: 'Bowl', word: null, style: 'link' as const }]]),
    savedLinks: [{ key: 'value', link: { resultPath: ['records', 1, 'title'], evidenceAnchorId: 'a_p1_s1' } }],
    records: [closed(0, line('p1_s1', 0, 12)), preview('2', 'p1_s1', line('p1_s1', 13, 24))] }
  act(() => selection.publish({ marks }))
  const { rerender } = render(<DocumentMarkdown markdown={markdown} document={document} selection={selection} extractionId="x" onSelect={onSelect} />)
  const mark = screen.getByRole('button', { name: 'title: Bowl' })
  const first = screen.getByRole('group', { name: 'Record 1' }), second = screen.getByRole('group', { name: 'Preview · 2: still being found, its limits can change' })
  expect(first).toHaveTextContent(/^1 Vase 𝔸 réd$/)
  expect(first).toHaveClass('record-block', 'closed')
  expect(first).toHaveAttribute('data-record-label', 'Record 1')
  expect(second).toHaveTextContent(/^2 Bowl blue$/)
  expect(second).toHaveClass('record-block', 'preview')
  expect(mark).toContainElement(first)
  expect(mark).toHaveTextContent('1 Vase 𝔸 réd 2 Bowl blue')
  // The outline is no mark: a click on it reaches the Evidence mark it lies in.
  fireEvent.click(second)
  expect(onSelect).toHaveBeenCalledWith(['value'], mark)
  expect(screen.getByLabelText('Parsed Markdown')).toHaveTextContent('# Catalogue 1 Vase 𝔸 réd 2 Bowl blue found at the north wall')
  // The "Evidence marks" switch clears the outlines with the marks.
  rerender(<DocumentMarkdown markdown={markdown} document={document} selection={selection} extractionId="x" marksShown={false} onSelect={onSelect} />)
  expect(screen.queryByRole('group')).toBeNull()
})

it('the page draws record blocks as outlines that are no marks, keeps them through a page reset and removes them with their run', async () => {
  const { document: parsed, markdown } = page(), selection = createSelectionChannel(), onSelect = vi.fn()
  const container = document.createElement('div')
  container.innerHTML = '<div class="page" data-page-number="1"></div>'
  document.body.append(container)
  const listeners = new Map<string, () => void>()
  const viewer = { scrollPageIntoView: vi.fn(), eventBus: { on: (event: string, paint: () => void) => listeners.set(event, paint), off: (event: string) => listeners.delete(event) } }
  const marks = { extractionId: 'x', selected: null, describe: new Map([['value', { name: 'title', value: 'Bowl', word: null, style: 'link' as const }]]),
    savedLinks: [{ key: 'value', link: { resultPath: ['records', 1, 'title'], evidenceAnchorId: 'a_p1_s1' } }],
    records: [closed(0, line('p1_s0', 0, 9), line('p1_s1', 0, 12)), closed(1, line('p1_s1', 13, 24), line('p1_s3', 0, 21)), preview('3', 'p1_s5', line('p1_s5', 0, 5))] }
  act(() => selection.publish({ marks }))
  renderHook(() => useEvidenceOverlays({ containerRef: { current: container }, viewer: viewer as never, parsedDocument: parsed, markdown,
    extractionId: 'x', active: true, selection, onSelect }))
  const outlines = () => [...container.querySelectorAll<HTMLElement>('.record-block')]
  const seen = () => outlines().map(outline => [outline.className, outline.getAttribute('aria-label'), outline.dataset.recordLabel, outline.style.top, outline.style.height])
  const expected = [
    ['record-block closed start end', 'Record 1', 'Record 1', '5%', '8.75%'],
    ['record-block closed start', 'Record 2', 'Record 2', '8.75%', '5%'], ['record-block closed end', 'Record 2', undefined, '5%', '2.5%'],
    ['record-block preview start end', 'Preview · 3: still being found, its limits can change', 'Preview · 3', '25%', '2.5%']]
  expect(seen()).toEqual(expected)
  // An outline is an image with a name: nothing to press, and a click on it selects nothing.
  for (const outline of outlines()) {
    expect(outline.tagName).toBe('DIV')
    expect(outline.getAttribute('role')).toBe('img')
    expect(outline.dataset.hoverKeys).toBeUndefined()
    outline.click()
  }
  expect(onSelect).not.toHaveBeenCalled()
  // The Evidence mark of the shared paragraph is still the one button, and still selects its value.
  const mark = container.querySelector<HTMLButtonElement>('button.evidence-mark')!
  expect(container.querySelectorAll('button')).toHaveLength(1)
  mark.click()
  expect(onSelect).toHaveBeenCalledWith(['value'], mark)
  // pdf.js empties a page it renders again.
  container.querySelector('.page')!.replaceChildren()
  act(() => listeners.get('pagerendered')!())
  expect(seen()).toEqual(expected)
  // A poll that changes only the values keeps the same outlines.
  const kept = outlines()
  await act(async () => selection.publish({ marks: { ...marks, selected: 'value' } }))
  expect(container.querySelector('button.evidence-mark')!.getAttribute('aria-current')).toBe('true')
  expect(outlines()).toEqual(kept)
  await act(async () => selection.publish({ marks: { ...marks, records: [] } }))
  expect(outlines()).toEqual([])
  expect(container.querySelectorAll('button.evidence-mark')).toHaveLength(1)
})


it('keeps parent table regions separate across a child row', () => {
  const { document, bytes } = source([{ segment: 'p1_s0', kind: 'table', text: 'Parent\nChild\nParent again', at: [40, 100, 280, 160],
    cells: ['Parent', 'Child', 'Parent again'].map((text, row) => ({ id: `c${row}`, row, column: 0, text,
      at: [40, 100 + row * 20, 280, 120 + row * 20] as Corners })) }])
  const blocks = [closed(0, line('p1_s0', 0, 6), line('p1_s0', 13, 25)), closed(1, line('p1_s0', 7, 12))]
  expect(recordPieces(document, bytes, blocks).map(piece => [piece.labels, piece.box.y0, piece.box.y1])).toEqual([
    [['Record 1'], 100, 120], [['Record 1'], 140, 160], [['Record 2'], 120, 140]])
  expect(recordSpans(document, bytes, blocks).map(span => new TextDecoder().decode(bytes.subarray(span.from, span.to))))
    .toEqual(['Parent', 'Child', 'Parent again'])
})


it('places a multi-page child start on its first canonical fragment', () => {
  const { document, bytes } = source([
    { segment: 'p1_s0', kind: 'paragraph', text: 'Parent', at: [40, 40, 280, 60] },
    { segment: 'p2_s0', kind: 'paragraph', text: 'Child starts', at: [40, 80, 280, 100] },
    { segment: 'p3_s0', kind: 'paragraph', text: 'Child ends Parent resumes', at: [40, 120, 280, 140] },
  ])
  const records = plannedRecords([
    { ordinal: 0, scope: [line('p1_s0', 0, 6), line('p3_s0', 11, 25)] },
    { ordinal: 1, scope: [line('p2_s0', 0, 12), line('p3_s0', 0, 10)] },
  ])
  const blocks = recordBlocks({ records })
  const childSpans = recordSpans(document, bytes, blocks).filter(span => span.labels.includes('Record 2'))
  expect(childSpans.map(span => [new TextDecoder().decode(bytes.subarray(span.from, span.to)), span.first]))
    .toEqual([['Child starts', true], ['Child ends', false]])
  expect(recordPieces(document, bytes, blocks).find(piece => piece.tag.includes('Record 2'))?.box.y0).toBe(80)
})
