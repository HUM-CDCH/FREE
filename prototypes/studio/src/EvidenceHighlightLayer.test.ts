import { describe, expect, it } from 'vitest'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import {
  canUseScopedHintPageTextFallback,
} from './EvidenceHighlightLayer'
import { isTableEvidence } from './tableEvidence'
import {
  buildHighlights,
  coalescePaintRects,
  resolvedInTraversalOrder,
  type CachedHighlightEntry,
  type Highlight,
} from './evidenceHighlights'
import {
  findValueRects,
  rectsForQuery,
  searchValueAnchoredBySnippet,
  type PageTextData,
} from './evidenceTextSearch'

// The default vitest environment (node) has no DOMRect global; the module
// under test constructs DOMRects for on-page positions, so tests need a
// minimal stand-in with the x/y/width/height shape the tests assert on.
class TestDOMRect {
  x: number
  y: number
  width: number
  height: number
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x
    this.y = y
    this.width = width
    this.height = height
  }
}
;(globalThis as unknown as { DOMRect: typeof TestDOMRect }).DOMRect ??= TestDOMRect

// One text item per word, laid out left-to-right with a fixed 10-unit
// advance per word — enough to distinguish occurrences by `.x` without
// needing real PDF geometry.
function makePageTextData(words: readonly string[]): PageTextData {
  const items = words.map((str, i) => ({
    str,
    transform: [1, 0, 0, 1, i * 10, 100],
    width: str.length * 5,
    height: 10,
  }))
  return {
    items,
    normStrs: [...words],
    fullText: words.join(' '),
    viewportScale: 1,
    viewportHeight: 200,
  }
}

function fakePdfViewer(pages: Record<number, readonly string[]>): PDFViewer {
  const numPages = Math.max(...Object.keys(pages).map(Number))
  return {
    currentScale: 1,
    pdfDocument: {
      numPages,
      async getPage(pageNumber: number) {
        const words = pages[pageNumber] ?? []
        return {
          async getTextContent() {
            return {
              items: words.map((str, i) => ({
                str,
                transform: [1, 0, 0, 1, i * 10, 100],
                width: str.length * 5,
                height: 10,
              })),
            }
          },
          getViewport({ scale }: { scale: number }) {
            return { scale, height: 200, width: 1000 }
          },
        }
      },
    },
  } as unknown as PDFViewer
}

describe('buildHighlights', () => {
  it('keeps resolved highlights in result traversal order after out-of-order completion', () => {
    const first = { path: ['records', '0', 'name'] }
    const second = { path: ['records', '1', 'name'] }
    const resolved = new Map([[second, { pageNumber: 2 }], [first, { pageNumber: 1 }]])

    expect(resolvedInTraversalOrder([first, second], resolved)).toEqual([first, second])
  })

  it('selects result-primary for non-table strings and snippet-primary for primitives', () => {
    const result = {
      title: 'Anchored title',
      summary: 'Normalized title',
      count: 5,
      published: true,
      missing: 'Searchable author',
    }
    const evidence = {
      title: { value: 'Anchored title', snippet: 'Anchored title appears here', page: 2, source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: 40, start_page: 2, end_page: 2 } },
      summary: { value: 'Normalized title', snippet: 'Original heading wording', page: 2, source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: 40, start_page: 2, end_page: 2 } },
      count: { value: 5, snippet: 'There were 5 finds', page: 2, source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: 40, start_page: 2, end_page: 2 } },
      published: { value: true, snippet: 'Published: yes', page: 2, source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: 40, start_page: 2, end_page: 2 } },
    }

    expect(buildHighlights(
      result,
      evidence,
      { title: 'yellow', summary: 'blue', count: 'green', published: 'red', missing: 'gray' },
      { title: 'verbatim-string', summary: 'string', count: 'number', published: 'boolean', missing: 'verbatim-string' },
    )).toMatchObject([
      { value: 'Anchored title', matchStrategy: 'result-primary', path: ['title'] },
      { value: 'Normalized title', matchStrategy: 'result-primary', path: ['summary'] },
      { value: '5', matchStrategy: 'snippet-primary', path: ['count'] },
      { value: 'true', matchStrategy: 'snippet-primary', path: ['published'] },
    ])
  })

  it('keeps table-like string evidence snippet-primary', () => {
    const result = { records: [{ material: 'jernspænde' }] }
    const evidence = {
      records: [{
        material: {
          value: 'jernspænde',
          snippet: '| 8-2 | Jern | jernspænde |',
          page: 1,
          row_header: '8-2',
          column_header: 'Beskrivelse',
          source_scope: { segment_id: 'catalog:0', markdown_start: 0, markdown_end: 20, start_page: 1, end_page: 1 },
        },
      }],
    }

    expect(buildHighlights(
      result,
      evidence,
      { material: 'yellow' },
      { records: [{ material: 'string' }] },
    )).toMatchObject([
      { value: 'jernspænde', matchStrategy: 'snippet-primary', path: ['records', '0', 'material'] },
    ])
  })

  it('carries row_header/column_header hints into the highlight', () => {
    const result = { records: [{ count: '5' }] }
    const evidence = {
      records: [{
        count: {
          value: '5',
          snippet: '5',
          page: 1,
          row_header: 'Grave 1',
          column_header: 'Count',
          source_scope: { segment_id: 'catalog:0', markdown_start: 0, markdown_end: 10, start_page: 1, end_page: 1 },
        },
      }],
    }

    expect(buildHighlights(result, evidence, { count: 'yellow' }, { records: [{ count: 'number' }] })).toMatchObject([
      {
        value: '5',
        snippet: '5',
        hintPage: 1,
        rowHeader: 'Grave 1',
        columnHeader: 'Count',
        sourceScope: { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: 10, startPage: 1, endPage: 1 },
        matchStrategy: 'snippet-primary',
        color: 'yellow',
        path: ['records', '0', 'count'],
      },
    ])
  })

  it('adds canonicalSpan when the primary term occurs exactly once inside sourceScope', () => {
    const markdown = 'Intro. Anchored title appears here. Tail.'
    const start = markdown.indexOf('Anchored title')
    const result = { title: 'Anchored title' }
    const evidence = {
      title: {
        value: 'Anchored title',
        snippet: 'Anchored title appears here',
        page: 1,
        source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: markdown.length, start_page: 1, end_page: 1 },
      },
    }

    expect(buildHighlights(result, evidence, { title: 'yellow' }, { title: 'verbatim-string' }, markdown)).toMatchObject([
      {
        canonicalSpan: { markdownStart: start, markdownEnd: start + 'Anchored title'.length },
      },
    ])
  })

  it('leaves canonicalSpan null when the scoped occurrence is ambiguous', () => {
    const markdown = 'Repeated phrase. Repeated phrase.'
    const result = { title: 'Repeated phrase' }
    const evidence = {
      title: {
        value: 'Repeated phrase',
        snippet: 'Repeated phrase',
        page: 1,
        source_scope: { segment_id: 'article:0', markdown_start: 0, markdown_end: markdown.length, start_page: 1, end_page: 1 },
      },
    }

    expect(buildHighlights(result, evidence, { title: 'yellow' }, { title: 'verbatim-string' }, markdown)).toMatchObject([
      { canonicalSpan: null },
    ])
  })

  it('omits malformed source scopes', () => {
    expect(buildHighlights(
      { title: 'Report' },
      { title: { value: 'Report', snippet: 'Report', page: 1, source_scope: { markdown_start: -1 } } },
      { title: 'yellow' },
      { title: 'verbatim-string' },
    )).toEqual([])
  })
})

function testHighlight(path: string[], color = 'yellow'): Highlight {
  return {
    value: 'value', snippet: 'snippet', hintPage: 1, rowHeader: null, columnHeader: null,
    sourceScope: { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: 10, startPage: 1, endPage: 1 },
    canonicalSpan: null,
    matchStrategy: 'result-primary', color, path,
  }
}

describe('scoped hint-page text fallback guard', () => {
  it('refuses to run without a hint page', () => {
    expect(canUseScopedHintPageTextFallback({
      ...testHighlight(['description']),
      hintPage: null,
    })).toBe(false)
  })

  it('refuses table-like evidence', () => {
    expect(canUseScopedHintPageTextFallback({
      ...testHighlight(['finds', '0', 'description']),
      snippet: '| 26-15 | Keramik | Niv. 6 |',
    })).toBe(false)
    expect(canUseScopedHintPageTextFallback({
      ...testHighlight(['finds', '0', 'description']),
      rowHeader: '26-15',
      columnHeader: 'Beskrivelse',
    })).toBe(false)
  })
})

describe('isTableEvidence', () => {
  const scope = (markdown: string) => ({
    segmentId: 'catalog:0',
    markdownStart: 0,
    markdownEnd: markdown.length,
    startPage: 1,
    endPage: 1,
  })

  it('keeps explicit header and pipe-prefixed evidence in the table tier', () => {
    const markdown = '# Grav 8\n\n| Fundnr | Beskrivelse | Bemærkninger |\n| --- | --- | --- |\n| 8-2 | Jern | jernspænde |\n'

    expect(isTableEvidence(
      { ...testHighlight(['records', '0', 'notes']), rowHeader: '8-2', columnHeader: 'Bemærkninger', sourceScope: scope(markdown) },
      markdown,
    )).toBe(true)
    expect(isTableEvidence(
      { ...testHighlight(['records', '0', 'notes']), snippet: '| 8-2 | Jern | jernspænde |', sourceScope: scope(markdown) },
      markdown,
    )).toBe(true)
  })

  it('refuses prose evidence whose value also recurs in a table', () => {
    const markdown = [
      '# Grav 31',
      '',
      '| Fundnr | Beskrivelse | Bemærkninger |',
      '| --- | --- | --- |',
      '| 31-7 | Tandemalje | Dårligt bevaret |',
      '',
      'Fundet blev beskrevet som 31-7 i rapporten.',
    ].join('\n')

    expect(isTableEvidence(
      {
        ...testHighlight(['records', '6', 'notes']),
        snippet: 'Fundet blev beskrevet som 31-7 i rapporten.',
        sourceScope: scope(markdown),
      },
      markdown,
    )).toBe(false)
  })

  it('classifies a bare continuation-table cell as table evidence via its snippet location', () => {
    const markdown = [
      '# Grav 13',
      '',
      '| Fundnr | Beskrivelse | Bemærkninger |',
      '| --- | --- | --- |',
      '| 13-1 | Del af lårben | Meget fragmenteret |',
    ].join('\n')

    expect(isTableEvidence(
      {
        ...testHighlight(['records', '1', 'notes']),
        snippet: 'Meget fragmenteret',
        rowHeader: null,
        columnHeader: null,
        sourceScope: scope(markdown),
      },
      markdown,
    )).toBe(true)
  })

  it('refuses a snippet that occurs both on a table row and in prose', () => {
    const markdown = [
      '# Grav 31',
      '',
      '| Fundnr | Beskrivelse | Bemærkninger |',
      '| --- | --- | --- |',
      '| 31-7 | Tandemalje | Dårligt bevaret |',
      '',
      'Dårligt bevaret materiale blev noteret.',
    ].join('\n')

    expect(isTableEvidence(
      {
        ...testHighlight(['records', '6', 'notes']),
        snippet: 'Dårligt bevaret',
        rowHeader: null,
        columnHeader: null,
        sourceScope: scope(markdown),
      },
      markdown,
    )).toBe(false)
  })
})

function cachedEntry(path: string[], color = 'yellow'): CachedHighlightEntry {
  return {
    highlight: testHighlight(path, color),
    pageNumber: 1,
    rects: [new DOMRect(10, 20, 30, 40)],
    pageTop: 100,
    pageLeft: 50,
  }
}

describe('coalescePaintRects', () => {
  it('paints coincident same-color geometry once', () => {
    const first = cachedEntry(['records', '0', 'name'])
    const duplicate = cachedEntry(['records', '1', 'name'])

    expect(coalescePaintRects([first, duplicate], null)).toEqual([
      { entry: first, rect: first.rects[0] },
    ])
  })

  it('keeps the focused logical entry when it shares geometry', () => {
    const first = cachedEntry(['records', '0', 'name'])
    const focused = cachedEntry(['records', '1', 'name'])

    expect(coalescePaintRects([first, focused], focused.highlight.path)).toEqual([
      { entry: focused, rect: focused.rects[0] },
    ])
  })
})

describe('rectsForQuery occurrence-index disambiguation', () => {
  it('resolves to the occurrence at occurrenceIndex when a value repeats', () => {
    const data = makePageTextData(['Grave', '8', 'contained', 'pottery', 'Grave', '8', 'again'])

    expect(rectsForQuery(data, '8', 0)[0].x).toBe(10)
    expect(rectsForQuery(data, '8', 1)[0].x).toBe(50)
  })

  it('falls back to the first occurrence when occurrenceIndex is null or out of range', () => {
    const data = makePageTextData(['Grave', '8', 'contained', 'pottery', 'Grave', '8', 'again'])

    expect(rectsForQuery(data, '8', null)[0].x).toBe(10)
    expect(rectsForQuery(data, '8', 5)[0].x).toBe(10)
  })

  it('is unaffected when the query matches only once', () => {
    const data = makePageTextData(['Unique', 'Value', 'Here'])

    expect(rectsForQuery(data, 'Value', 0)[0].x).toBe(10)
    expect(rectsForQuery(data, 'Value', 5)[0].x).toBe(10)
  })

  it('returns no rects when the query does not match at all', () => {
    const data = makePageTextData(['Nothing', 'here', 'matches'])

    expect(rectsForQuery(data, 'absent', 0)).toEqual([])
  })
})

describe('searchValueAnchoredBySnippet occurrence-index threading', () => {
  it('picks the value occurrence within the snippet range at occurrenceIndex', () => {
    const data = makePageTextData(['intro', 'Grave', '8', 'and', 'Grave', '8', 'again', 'tail'])
    // Snippet covers the "Grave 8 and Grave 8 again" range, which contains two "8"s.
    const snippet = 'Grave 8 and Grave 8 again'

    expect(searchValueAnchoredBySnippet(data, snippet, '8', 0)[0].x).toBe(20)
    expect(searchValueAnchoredBySnippet(data, snippet, '8', 1)[0].x).toBe(50)
  })

  it('falls back to the snippet\'s own matched location when the value is not pinpointable anywhere on the page', () => {
    const data = makePageTextData(['intro', 'Grave', '8', 'summary', 'tail'])
    const snippet = 'Grave 8 summary'

    const rects = searchValueAnchoredBySnippet(data, snippet, '999', null)

    // Snippet spans the 'Grave', '8', 'summary' items (x = 10, 20, 30) — the
    // value itself never appears anywhere, so no highlight is silently omitted.
    expect(rects.map((r) => r.x)).toEqual([10, 20, 30])
  })
})

describe('dash-variant tolerance', () => {
  it('rectsForQuery treats an en-dash in the source text as equivalent to a plain hyphen in the value', () => {
    const data = makePageTextData(['intro', '1234–05', 'tail'])

    expect(rectsForQuery(data, '1234-05', null)[0].x).toBe(10)
  })

  it('rectsForQuery treats a minus sign in the value as equivalent to a plain hyphen in the source text', () => {
    const data = makePageTextData(['intro', '1234-05', 'tail'])

    expect(rectsForQuery(data, '1234−05', null)[0].x).toBe(10)
  })

  it('searchValueAnchoredBySnippet tolerates a dash-variant difference in the snippet text', () => {
    const data = makePageTextData(['intro', 'Grave', '8–05', 'tail'])
    const snippet = 'Grave 8-05'

    expect(searchValueAnchoredBySnippet(data, snippet, '8-05', null)[0].x).toBe(20)
  })
})

describe('findValueRects page-anchored fallback', () => {
  it('prefers a shorter-tier match on the hint page over a full-length match on another page', async () => {
    const value = 'Grave 8 contained pottery and bone'
    const viewer = fakePdfViewer({
      1: ['Some', 'unrelated', 'wording', 'says', 'Grave', '8', 'contained', 'clearly', 'today'],
      2: ['Completely', 'different', 'context', 'Grave', '8', 'contained', 'pottery', 'and', 'bone', 'nearby'],
    })

    const found = await findValueRects(viewer, value, null, 1, null)

    expect(found?.pageNumber).toBe(1)
  })

  it('falls back to another page when the hint page has no match at any tier', async () => {
    const value = 'Grave 8 contained pottery and bone'
    const viewer = fakePdfViewer({
      1: ['Nothing', 'relevant', 'appears', 'on', 'this', 'page', 'at', 'all'],
      2: ['Completely', 'different', 'context', 'Grave', '8', 'contained', 'pottery', 'and', 'bone', 'nearby'],
    })

    const found = await findValueRects(viewer, value, null, 1, null)

    expect(found?.pageNumber).toBe(2)
  })

  it('does not lock onto an early page where the value merely recurs without its snippet', async () => {
    // Page 1 contains the bare value text as an unrelated coincidence (no
    // snippet context there at all); the real evidence — snippet AND value —
    // is on page 3. With no hint page, findValueRects must not settle for
    // page 1's snippet-less match just because it's encountered first.
    const value = '8'
    const snippet = 'Later Grave 8 contained pottery in situ'
    const viewer = fakePdfViewer({
      1: ['An', 'unrelated', 'count', 'of', '8', 'objects', 'were', 'catalogued'],
      2: ['Nothing', 'relevant', 'here'],
      3: ['Later', 'Grave', '8', 'contained', 'pottery', 'in', 'situ'],
    })

    const found = await findValueRects(viewer, value, snippet, null, null)

    expect(found?.pageNumber).toBe(3)
  })
})
