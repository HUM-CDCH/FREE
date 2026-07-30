import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'

// ── text-layer helpers ────────────────────────────────────────────────────────

// Dash-variant characters commonly produced by PDF text extraction in place
// of a plain hyphen (en dash, em dash, minus sign, non-breaking hyphen, etc).
// Each maps to exactly one output character, so this is length-preserving —
// existing character-offset bookkeeping (rectsForRange indexing into
// fullText) stays valid after normalization.
const DASH_VARIANTS_RE = /[‐‑‒–—―−]/g

export function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(DASH_VARIANTS_RE, '-')
}

type HasStr = { str: string; transform: number[]; width: number; height: number }

export type PageTextData = {
  items: HasStr[]
  normStrs: string[]
  fullText: string
  viewportScale: number
  viewportHeight: number
}

export async function getPageTextData(pdfViewer: PDFViewer, pageNumber: number): Promise<PageTextData | null> {
  const pageCount = pdfViewer.pdfDocument?.numPages ?? 0
  if (pageNumber < 1 || pageNumber > pageCount) return null
  const pdfPage = await pdfViewer.pdfDocument?.getPage(pageNumber)
  if (!pdfPage) return null

  const textContent = await pdfPage.getTextContent()
  const CSS_UNITS = 96.0 / 72.0
  const viewport = pdfPage.getViewport({ scale: pdfViewer.currentScale * CSS_UNITS })

  const items: HasStr[] = []
  const normStrs: string[] = []
  for (const raw of textContent.items) {
    if (!('str' in raw)) continue
    const item = raw as HasStr
    const norm = item.str.replace(/\s+/g, ' ').trim()
    if (norm) { items.push(item); normStrs.push(norm) }
  }

  return {
    items,
    normStrs,
    fullText: normStrs.join(' '),
    viewportScale: viewport.scale,
    viewportHeight: viewport.height,
  }
}

// Converts a slice of text items directly into their viewport rects (each
// item independently, no char-offset range needed) — used both by
// rectsForRange below and as the snippet-location fallback in
// searchValueAnchoredBySnippet when the value can't be pinpointed at all.
function rectsForItems(items: readonly HasStr[], viewportScale: number, viewportHeight: number): DOMRect[] {
  return items.map((item) => {
    const [, , , , tx, ty] = item.transform
    const x = tx * viewportScale
    const y = viewportHeight - (ty + item.height) * viewportScale
    return new DOMRect(x, y, item.width * viewportScale, item.height * viewportScale)
  })
}

// Converts a [start, end) character-offset range in data.fullText into the
// rects of every text item overlapping that range.
function rectsForRange(data: PageTextData, start: number, end: number): DOMRect[] {
  const items: HasStr[] = []
  let cursor = 0
  for (let i = 0; i < data.items.length; i++) {
    const normLen = data.normStrs[i].length
    const itemEnd = cursor + normLen
    if (itemEnd > start && cursor < end) {
      items.push(data.items[i])
    }
    cursor += normLen + 1
  }
  return rectsForItems(items, data.viewportScale, data.viewportHeight)
}

// Every non-overlapping occurrence of `query` in `data.fullText`, in reading
// order (the order data.items/fullText are built in), each mapped to its rects.
export function allOccurrenceRects(data: PageTextData, query: string): DOMRect[][] {
  const q = normalizeForMatch(query)
  if (!q) return []
  const haystack = normalizeForMatch(data.fullText)
  const occurrences: DOMRect[][] = []
  let from = 0
  for (;;) {
    const idx = haystack.indexOf(q, from)
    if (idx === -1) break
    occurrences.push(rectsForRange(data, idx, idx + query.length))
    from = idx + query.length
  }
  return occurrences
}

// Locates `query` on a page. When it matches more than once, prefers the
// occurrence at `occurrenceIndex` (see computeOccurrenceIndices — ranks a
// highlight among other highlights sharing the same field key/value/hint
// page) instead of always taking the first match — mirroring how
// findTableCellMatch already disambiguates repeated table-cell values. Falls
// back to the first occurrence when occurrenceIndex is absent or out of
// range, so this only ever narrows an existing match, never turns one into a
// non-match.
export function rectsForQuery(data: PageTextData, query: string, occurrenceIndex: number | null): DOMRect[] {
  const all = allOccurrenceRects(data, query)
  if (all.length === 0) return []
  if (occurrenceIndex !== null && occurrenceIndex >= 0 && occurrenceIndex < all.length) {
    return all[occurrenceIndex]
  }
  return all[0]
}

// Find `value` within the region where `snippet` appears on a page. When the
// snippet is found but `value` can't be pinpointed within it or elsewhere on
// the page, falls back to the snippet's own matched location rather than
// returning nothing (see evidence-highlight-layer spec — no highlight should
// be silently omitted just because the value isn't a verbatim substring).
// Falls back to searching value across the whole page if the snippet itself
// isn't found at all.
export function searchValueAnchoredBySnippet(
  data: PageTextData,
  snippet: string,
  value: string,
  occurrenceIndex: number | null,
): DOMRect[] {
  const snippetNorm = snippet.replace(/\s+/g, ' ').trim()
  const snippetIdx = normalizeForMatch(data.fullText).indexOf(normalizeForMatch(snippetNorm))

  if (snippetIdx !== -1) {
    // Build a sub-text covering the snippet's item range
    const snippetEnd = snippetIdx + snippetNorm.length
    let cursor = 0
    let subStart = -1
    let subEnd = 0
    for (let i = 0; i < data.items.length; i++) {
      const normLen = data.normStrs[i].length
      const itemEnd = cursor + normLen
      if (itemEnd > snippetIdx && subStart === -1) subStart = i
      if (cursor < snippetEnd) subEnd = i
      cursor += normLen + 1
    }

    if (subStart !== -1) {
      const subItems = data.items.slice(subStart, subEnd + 1)
      const subData: PageTextData = {
        items: subItems,
        normStrs: data.normStrs.slice(subStart, subEnd + 1),
        fullText: data.normStrs.slice(subStart, subEnd + 1).join(' '),
        viewportScale: data.viewportScale,
        viewportHeight: data.viewportHeight,
      }
      const valueNorm = value.replace(/\s+/g, ' ').trim()
      const rects = rectsForQuery(subData, valueNorm, occurrenceIndex)
      if (rects.length > 0) return rects

      const wholePageRects = rectsForQuery(data, valueNorm, occurrenceIndex)
      if (wholePageRects.length > 0) return wholePageRects

      // Value not pinpointable anywhere on the page — highlight the
      // snippet's own matched location instead of omitting this field.
      return rectsForItems(subItems, data.viewportScale, data.viewportHeight)
    }
  }

  // Snippet not found — search value across whole page
  const valueNorm = value.replace(/\s+/g, ' ').trim()
  return rectsForQuery(data, valueNorm, occurrenceIndex)
}

// ── main search ───────────────────────────────────────────────────────────────

export type PageRects = { pageNumber: number; rects: DOMRect[] }

export async function findValueRects(
  pdfViewer: PDFViewer,
  value: string,
  snippet: string | null,
  hintPage: number | null,
  occurrenceIndex: number | null,
): Promise<PageRects | null> {
  const pageCount = pdfViewer.pdfDocument?.numPages ?? 0
  const valueNorm = value.replace(/\s+/g, ' ').trim()
  if (!valueNorm) return null

  // Build query list with progressive shortening for direct fallback
  const words = valueNorm.split(' ')
  const queries: string[] = [valueNorm]
  if (words.length > 4) queries.push(words.slice(0, 5).join(' '))
  if (words.length > 2) queries.push(words.slice(0, 3).join(' '))

  // Page order: hint page first, then the rest
  const pages = hintPage != null
    ? [hintPage, ...Array.from({ length: pageCount }, (_, i) => i + 1).filter(p => p !== hintPage)]
    : Array.from({ length: pageCount }, (_, i) => i + 1)

  if (snippet) {
    // Snippet-anchored: search for value within snippet context
    for (const p of pages) {
      const data = await getPageTextData(pdfViewer, p)
      if (!data) continue
      const rects = searchValueAnchoredBySnippet(data, snippet, valueNorm, occurrenceIndex)
      if (rects.length > 0) return { pageNumber: p, rects }
    }
  }

  // Direct search with progressive shortening (no snippet, or snippet search
  // failed) — page-outer, query-inner: each page (hint page first) is tried at
  // every specificity tier (full value, then 5 words, then 3 words) before the
  // search widens to another page, so a looser-but-still-plausible match on
  // the page the evidence actually points at is preferred over an exact match
  // that only exists on an unrelated page.
  for (const p of pages) {
    const data = await getPageTextData(pdfViewer, p)
    if (!data) continue
    for (const query of queries) {
      const rects = rectsForQuery(data, query, occurrenceIndex)
      if (rects.length > 0) return { pageNumber: p, rects }
    }
  }

  return null
}
