import { useEffect, useRef, useState } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { buildHighlights, PALETTE } from './evidenceHighlights'
import type { Highlight } from './evidenceHighlights'
import { isRecord } from './template'
import type { BoundingBox, EvidenceAnchor, ParsedTable } from './parsedDocument'
import { resolveTableCellMatches, computeOccurrenceIndices } from './tableCellMatch'
import type { TableCellMatch } from './tableCellMatch'
import { findMarkdownAnchorMatch } from './markdownAnchorMatch'
import type { PageRects } from './evidenceTextSearch'

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

// Table-cell coordinate lookup. The match itself is resolved up front for every
// highlight at once (see
// resolveTableCellMatches) rather than per-field here, so that a record's
// fields can be kept on the same source table when disambiguation is
// otherwise inconclusive.
async function findTableCellRects(
  pdfViewer: PDFViewer,
  match: TableCellMatch | null,
): Promise<PageRects | null> {
  if (!match) return null

  const viewport = await getPageViewportScale(pdfViewer, match.pageNumber)
  if (!viewport) return null

  const rect = bboxToRect(match.bbox, viewport.scale)
  if (!rectWithinPage(rect, viewport)) return null

  return { pageNumber: match.pageNumber, rects: [rect] }
}

// Anchor-based lookup, tried after the table-cell tier. A missing anchor is an
// unverifiable location, so no highlight is drawn.
async function findAnchorRects(
  pdfViewer: PDFViewer,
  markdown: string | null,
  anchors: EvidenceAnchor[],
  highlight: Highlight,
  occurrenceIndex: number | null,
): Promise<PageRects | null> {
  if (!markdown || anchors.length === 0) return null

  const match = findMarkdownAnchorMatch(markdown, anchors, highlight.snippet, highlight.hintPage, occurrenceIndex)
  if (!match) return null

  const viewport = await getPageViewportScale(pdfViewer, match.page)
  if (!viewport) return null

  const rect = bboxToRect(match.bbox, viewport.scale)
  if (!rectWithinPage(rect, viewport)) return null

  return { pageNumber: match.page, rects: [rect] }
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
  markdown?: string | null
  anchors?: EvidenceAnchor[]
}

export default function EvidenceHighlightLayer({
  pdfViewer,
  result,
  evidence,
  schemaTemplate,
  containerEl,
  focusPath,
  tables = [],
  markdown = null,
  anchors = [],
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

  // Main effect: resolve verified coordinates for each highlight, build position
  // cache, and draw progressively.
  useEffect(() => {
    if (!pdfViewer || !result || !containerEl || !isRecord(result)) return

    const schemaKeys = isRecord(schemaTemplateRef.current) ? Object.keys(schemaTemplateRef.current) : []
    const fieldColorMap: Record<string, string> = {}
    schemaKeys.forEach((k, i) => { fieldColorMap[k] = PALETTE[i % PALETTE.length] })
    const highlights = buildHighlights(result, evidence, fieldColorMap)
    if (highlights.length === 0) return
    const occurrenceIndices = computeOccurrenceIndices(highlights)
    const tableMatches = resolveTableCellMatches(tables, highlights, occurrenceIndices)

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
          (await findTableCellRects(pdfViewer, tableMatches.get(h) ?? null)) ??
          (await findAnchorRects(pdfViewer, markdown, anchors, h, occurrenceIndex))
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
  }, [pdfViewer, result, evidence, containerEl, scale, containerVersion, tables, markdown, anchors])

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
