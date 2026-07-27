import { useEffect, useRef, useState } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { buildHighlights, PALETTE } from './evidenceHighlights'
import type { Highlight } from './evidenceHighlights'
import { isRecord } from './template'
import type { BoundingBox, ParsedTable } from './parsedDocument'
import { findTableCellMatch, computeOccurrenceIndices } from './tableCellMatch'

// ── text-layer helpers ────────────────────────────────────────────────────────

type HasStr = { str: string; transform: number[]; width: number; height: number }

type PageTextData = {
  items: HasStr[]
  normStrs: string[]
  fullText: string
  viewportScale: number
  viewportHeight: number
}

async function getPageTextData(pdfViewer: PDFViewer, pageNumber: number): Promise<PageTextData | null> {
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

// ── table-cell coordinate lookup ────────────────────────────────────────────────

type PageViewportScale = { scale: number; width: number; height: number }

// Cheaper than getPageTextData when only the scale factor is needed (no text content).
async function getPageViewportScale(pdfViewer: PDFViewer, pageNumber: number): Promise<PageViewportScale | null> {
  const pageCount = pdfViewer.pdfDocument?.numPages ?? 0
  if (pageNumber < 1 || pageNumber > pageCount) return null
  const pdfPage = await pdfViewer.pdfDocument?.getPage(pageNumber)
  if (!pdfPage) return null

  const CSS_UNITS = 96.0 / 72.0
  const viewport = pdfPage.getViewport({ scale: pdfViewer.currentScale * CSS_UNITS })
  return { scale: viewport.scale, width: viewport.width, height: viewport.height }
}

// BoundingBox is PDF points, top-left origin, in the same displayed/post-rotation
// page space pdf.js's viewport renders into — a straight scale, no y-flip
// (unlike raw text-item transforms, which are bottom-origin; see design.md decision 7).
function bboxToRect(bbox: BoundingBox, viewportScale: number): DOMRect {
  return new DOMRect(
    bbox.x0 * viewportScale,
    bbox.y0 * viewportScale,
    (bbox.x1 - bbox.x0) * viewportScale,
    (bbox.y1 - bbox.y0) * viewportScale,
  )
}

// Defensive guard (design.md risk: unverified rotation/origin assumption) — a
// converted rect that falls outside the rendered page is treated as no match.
function rectWithinPage(rect: DOMRect, viewport: PageViewportScale): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x >= -1 &&
    rect.y >= -1 &&
    rect.x + rect.width <= viewport.width + 1 &&
    rect.y + rect.height <= viewport.height + 1
  )
}

function rectsForQuery(data: PageTextData, query: string, searchFrom = 0): DOMRect[] {
  const idx = data.fullText.toLowerCase().indexOf(query.toLowerCase(), searchFrom)
  if (idx === -1) return []

  const rects: DOMRect[] = []
  let cursor = 0
  const end = idx + query.length
  for (let i = 0; i < data.items.length; i++) {
    const normLen = data.normStrs[i].length
    const itemEnd = cursor + normLen
    if (itemEnd > idx && cursor < end) {
      const [, , , , tx, ty] = data.items[i].transform
      const x = tx * data.viewportScale
      const y = data.viewportHeight - (ty + data.items[i].height) * data.viewportScale
      rects.push(new DOMRect(x, y, data.items[i].width * data.viewportScale, data.items[i].height * data.viewportScale))
    }
    cursor += normLen + 1
  }
  return rects
}

// Find `value` within the region where `snippet` appears on a page.
// Falls back to searching value across the whole page if snippet isn't found.
function searchValueAnchoredBySnippet(data: PageTextData, snippet: string, value: string): DOMRect[] {
  const snippetNorm = snippet.replace(/\s+/g, ' ').trim()
  const snippetIdx = data.fullText.toLowerCase().indexOf(snippetNorm.toLowerCase())

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
      const subData: PageTextData = {
        items: data.items.slice(subStart, subEnd + 1),
        normStrs: data.normStrs.slice(subStart, subEnd + 1),
        fullText: data.normStrs.slice(subStart, subEnd + 1).join(' '),
        viewportScale: data.viewportScale,
        viewportHeight: data.viewportHeight,
      }
      const valueNorm = value.replace(/\s+/g, ' ').trim()
      const rects = rectsForQuery(subData, valueNorm)
      if (rects.length > 0) return rects
    }
  }

  // Snippet not found or value not in snippet — search value across whole page
  const valueNorm = value.replace(/\s+/g, ' ').trim()
  return rectsForQuery(data, valueNorm)
}

// ── main search ───────────────────────────────────────────────────────────────

type PageRects = { pageNumber: number; rects: DOMRect[] }

async function findValueRects(
  pdfViewer: PDFViewer,
  value: string,
  snippet: string | null,
  hintPage: number | null,
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
      const rects = searchValueAnchoredBySnippet(data, snippet, valueNorm)
      if (rects.length > 0) return { pageNumber: p, rects }
    }
  }

  // Direct search with progressive shortening (no snippet, or snippet search failed)
  for (const query of queries) {
    for (const p of pages) {
      const data = await getPageTextData(pdfViewer, p)
      if (!data) continue
      const rects = rectsForQuery(data, query)
      if (rects.length > 0) return { pageNumber: p, rects }
    }
  }

  return null
}

// Table-cell coordinate lookup, tried before the text search above (see
// design.md decision 6 and evidence-highlight-layer spec). Returns null on any
// inconclusive step so the caller falls back to findValueRects unchanged.
async function findTableCellRects(
  pdfViewer: PDFViewer,
  tables: ParsedTable[],
  highlight: Highlight,
  occurrenceIndex: number | null,
): Promise<PageRects | null> {
  if (tables.length === 0) return null

  const match = findTableCellMatch(
    tables,
    highlight.value,
    highlight.rowHeader,
    highlight.columnHeader,
    highlight.hintPage,
    occurrenceIndex,
  )
  if (!match) return null

  const viewport = await getPageViewportScale(pdfViewer, match.pageNumber)
  if (!viewport) return null

  const rect = bboxToRect(match.bbox, viewport.scale)
  if (!rectWithinPage(rect, viewport)) return null

  return { pageNumber: match.pageNumber, rects: [rect] }
}

// ── component ─────────────────────────────────────────────────────────────────

type CachedEntry = {
  highlight: Highlight
  pageNumber: number
  rects: DOMRect[]
  pageTop: number
  pageLeft: number
}

function pathsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

type Props = {
  pdfViewer: PDFViewer | null
  result: unknown
  evidence: unknown
  schemaTemplate: unknown
  containerEl: HTMLDivElement | null
  focusPath: string[] | null
  tables?: ParsedTable[]
}

export default function EvidenceHighlightLayer({
  pdfViewer,
  result,
  evidence,
  schemaTemplate,
  containerEl,
  focusPath,
  tables = [],
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const schemaTemplateRef = useRef(schemaTemplate)
  schemaTemplateRef.current = schemaTemplate
  const focusPathRef = useRef<string[] | null>(null)
  focusPathRef.current = focusPath
  const cachedEntriesRef = useRef<CachedEntry[]>([])
  const [scale, setScale] = useState(1)
  const [containerVersion, setContainerVersion] = useState(0)
  const [cacheVersion, setCacheVersion] = useState(0)

  // Re-render highlights when PDF zoom level changes.
  useEffect(() => {
    if (!pdfViewer) return
    function onScaleChange() { setScale(pdfViewer!.currentScale) }
    pdfViewer.eventBus.on('scalechanging', onScaleChange)
    return () => { pdfViewer.eventBus.off('scalechanging', onScaleChange) }
  }, [pdfViewer])

  // Re-render highlights when the container is resized (e.g. window resize).
  useEffect(() => {
    if (!containerEl) return
    const observer = new ResizeObserver(() => { setContainerVersion((v: number) => v + 1) })
    observer.observe(containerEl)
    return () => { observer.disconnect() }
  }, [containerEl])

  // Main effect: search PDF for each highlight, build position cache, draw progressively.
  useEffect(() => {
    if (!pdfViewer || !result || !containerEl || !isRecord(result)) return

    const schemaKeys = isRecord(schemaTemplateRef.current) ? Object.keys(schemaTemplateRef.current) : []
    const fieldColorMap: Record<string, string> = {}
    schemaKeys.forEach((k, i) => { fieldColorMap[k] = PALETTE[i % PALETTE.length] })
    const highlights = buildHighlights(result, evidence, fieldColorMap)
    if (highlights.length === 0) return
    const occurrenceIndices = computeOccurrenceIndices(highlights)

    cachedEntriesRef.current = []
    let cancelled = false

    async function render() {
      const canvas = canvasRef.current
      if (!canvas || !pdfViewer || !containerEl) return

      const { scrollWidth, scrollHeight } = containerEl
      canvas.width = scrollWidth
      canvas.height = scrollHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      const containerRect = containerEl.getBoundingClientRect()

      for (const h of highlights) {
        if (cancelled) return

        const occurrenceIndex = occurrenceIndices.get(h) ?? null
        const found =
          (await findTableCellRects(pdfViewer, tables, h, occurrenceIndex)) ??
          (await findValueRects(pdfViewer, h.value, h.snippet, h.hintPage))
        if (!found) continue

        const pageEl = containerEl.querySelector(
          `.page[data-page-number="${found.pageNumber}"]`
        ) as HTMLElement | null
        if (!pageEl) continue

        const pageRect = pageEl.getBoundingClientRect()
        const pageTop = pageRect.top - containerRect.top + containerEl.scrollTop + pageEl.clientTop
        const pageLeft = pageRect.left - containerRect.left + containerEl.scrollLeft + pageEl.clientLeft

        if (!cancelled) {
          cachedEntriesRef.current.push({ highlight: h, pageNumber: found.pageNumber, rects: found.rects, pageTop, pageLeft })
        }
        if (cancelled) return

        const activeFv = focusPathRef.current
        const isActive = activeFv !== null && pathsEqual(h.path, activeFv)
        const dimmed = activeFv !== null && !isActive

        ctx.save()
        ctx.globalAlpha = isActive ? 0.75 : dimmed ? 0.15 : 0.4
        ctx.fillStyle = h.color
        for (const rect of found.rects) {
          ctx.fillRect(pageLeft + rect.x - 1, pageTop + rect.y - 2, rect.width + 2, rect.height + 2)
        }
        ctx.restore()
      }

      if (!cancelled) setCacheVersion((v: number) => v + 1)
    }

    void render()
    return () => { cancelled = true }
  }, [pdfViewer, result, evidence, containerEl, scale, containerVersion, tables])

  // Focus effect: scroll to active value and redraw from cache (no PDF search).
  useEffect(() => {
    if (!containerEl) return
    const entries = cachedEntriesRef.current
    const canvas = canvasRef.current
    if (!canvas || entries.length === 0) return

    if (focusPath) {
      const entry = entries.find(e => pathsEqual(e.highlight.path, focusPath))
      if (entry?.rects[0]) {
        containerEl.scrollTo({
          top: Math.max(0, entry.pageTop + entry.rects[0].y - containerEl.clientHeight / 2 + entry.rects[0].height / 2),
          behavior: 'smooth',
        })
      }
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const entry of entries) {
      const isActive = focusPath !== null && pathsEqual(entry.highlight.path, focusPath)
      const dimmed = focusPath !== null && !isActive
      ctx.save()
      ctx.globalAlpha = isActive ? 0.75 : dimmed ? 0.15 : 0.4
      ctx.fillStyle = entry.highlight.color
      for (const rect of entry.rects) {
        ctx.fillRect(entry.pageLeft + rect.x - 1, entry.pageTop + rect.y - 2, rect.width + 2, rect.height + 2)
      }
      ctx.restore()
    }
  }, [focusPath, cacheVersion, containerEl])

  if (!result) return null

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 left-0 z-10"
      aria-hidden="true"
    />
  )
}
