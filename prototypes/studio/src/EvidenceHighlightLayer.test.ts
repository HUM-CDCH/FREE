import { describe, expect, it } from 'vitest'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { buildHighlights } from './evidenceHighlights'
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
  it('falls back to direct result search for leaves without evidence', () => {
    const result = {
      title: 'Anchored title',
      author: 'Searchable author',
    }
    const evidence = {
      title: { value: 'Anchored title', snippet: 'Anchored title appears here', page: 2 },
    }

    expect(buildHighlights(result, evidence, { title: 'yellow', author: 'blue' })).toEqual([
      {
        value: 'Anchored title',
        snippet: 'Anchored title appears here',
        hintPage: 2,
        rowHeader: null,
        columnHeader: null,
        color: 'yellow',
        path: ['title'],
      },
      {
        value: 'Searchable author',
        snippet: null,
        hintPage: null,
        rowHeader: null,
        columnHeader: null,
        color: 'blue',
        path: ['author'],
      },
    ])
  })

  it('carries row_header/column_header hints into the highlight', () => {
    const result = { records: [{ count: '5' }] }
    const evidence = {
      records: [{ count: { value: '5', snippet: '5', page: 1, row_header: 'Grave 1', column_header: 'Count' } }],
    }

    expect(buildHighlights(result, evidence, { count: 'yellow' })).toEqual([
      {
        value: '5',
        snippet: '5',
        hintPage: 1,
        rowHeader: 'Grave 1',
        columnHeader: 'Count',
        color: 'yellow',
        path: ['records', '0', 'count'],
      },
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
