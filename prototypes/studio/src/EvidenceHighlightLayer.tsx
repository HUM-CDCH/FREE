import { useEffect, useRef, useState } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { buildHighlights, coalescePaintRects, PALETTE, resolvedInTraversalOrder } from './evidenceHighlights'
import type { CachedHighlightEntry, EvidenceSourceScope, Highlight } from './evidenceHighlights'
import { isRecord } from './template'
import type { BoundingBox, EvidenceAnchor, ParsedTable } from './parsedDocument'
import { buildSegmentGeometryIndex } from './segmentGeometry'
import { resolveTableCellMatches, computeOccurrenceIndices } from './tableCellMatch'
import type { TableCellMatch } from './tableCellMatch'
import { findScopedMarkdownAnchorMatch } from './markdownAnchorMatch'
import type { PageRects } from './evidenceTextSearch'

// ── table-cell coordinate lookup ────────────────────────────────────────────────

type PageViewportScale = { scale: number; width: number; height: number }
type ViewportCache = Map<number, Promise<PageViewportScale | null>>

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

function getCachedViewport(
  pdfViewer: PDFViewer,
  pageNumber: number,
  cache: ViewportCache,
): Promise<PageViewportScale | null> {
  const existing = cache.get(pageNumber)
  if (existing) return existing
  const pending = getPageViewportScale(pdfViewer, pageNumber)
  cache.set(pageNumber, pending)
  return pending
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
  viewportCache: ViewportCache,
): Promise<PageRects[] | null> {
  if (!match) return null

  const viewport = await getCachedViewport(pdfViewer, match.pageNumber, viewportCache)
  if (!viewport) return null

  const rect = bboxToRect(match.bbox, viewport.scale)
  if (!rectWithinPage(rect, viewport)) return null

  return [{ pageNumber: match.pageNumber, rects: [rect] }]
}

// Anchor-based lookup, tried after the table-cell tier. A missing anchor is an
// unverifiable location, so no highlight is drawn.
async function findAnchorRects(
  pdfViewer: PDFViewer,
  markdown: string | null,
  anchors: EvidenceAnchor[],
  highlight: Highlight,
  viewportCache: ViewportCache,
): Promise<PageRects[] | null> {
  if (!markdown || anchors.length === 0) return null

  if (!highlight.sourceScope) return null
  const primaryTerm =
    highlight.matchStrategy === 'result-primary' ? highlight.value : highlight.snippet
  const fallbackSnippet =
    highlight.matchStrategy === 'result-primary' ? highlight.snippet : null
  const match = findScopedMarkdownAnchorMatch(
    markdown,
    anchors,
    primaryTerm,
    fallbackSnippet,
    highlight.sourceScope,
  )
  if (!match) return null

  const fragments = await Promise.all(match.fragments.map(async (fragment) => {
    const viewport = await getCachedViewport(pdfViewer, fragment.page, viewportCache)
    if (!viewport) return null
    const rect = bboxToRect(fragment.bbox, viewport.scale)
    return rectWithinPage(rect, viewport) ? { pageNumber: fragment.page, rects: [rect] } : null
  }))
  const found = fragments.filter((fragment): fragment is PageRects => fragment !== null)
  return found.length > 0 ? found : null
}

// ── component ─────────────────────────────────────────────────────────────────

type CachedEntry = CachedHighlightEntry

function drawCachedEntries(
  ctx: CanvasRenderingContext2D,
  entries: readonly CachedEntry[],
  focusPath: string[] | null,
): void {
  for (const { entry, rect } of coalescePaintRects(entries, focusPath)) {
    const isActive = focusPath !== null && pathsEqual(entry.highlight.path, focusPath)
    const dimmed = focusPath !== null && !isActive
    ctx.save()
    ctx.globalAlpha = isActive ? 0.75 : dimmed ? 0.15 : 0.4
    ctx.fillStyle = entry.highlight.color
    ctx.fillRect(entry.pageLeft + rect.x - 1, entry.pageTop + rect.y - 2, rect.width + 2, rect.height + 2)
    ctx.restore()
  }
}

function pathsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

function scopeKey(scope: EvidenceSourceScope): string {
  return scope.segmentId
}

async function resolveWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  resolve: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      await resolve(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
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

  // Main effect: resolve each source scope independently, then cache and draw
  // in result order so asynchronous completion cannot reorder highlights.
  useEffect(() => {
    if (!pdfViewer || !result || !containerEl || !isRecord(result)) return

    const schemaKeys = isRecord(schemaTemplateRef.current) ? Object.keys(schemaTemplateRef.current) : []
    const fieldColorMap: Record<string, string> = {}
    schemaKeys.forEach((k, i) => { fieldColorMap[k] = PALETTE[i % PALETTE.length] })
    const highlights = buildHighlights(result, evidence, fieldColorMap, schemaTemplateRef.current).filter(
      (highlight): highlight is Highlight & { sourceScope: EvidenceSourceScope } => highlight.sourceScope !== null,
    )
    if (highlights.length === 0) return
    const occurrenceIndices = computeOccurrenceIndices(highlights)

    cachedEntriesRef.current = []
    let cancelled = false

    async function render() {
      const viewer = pdfViewer
      if (!viewer) return
      const viewportCache: ViewportCache = new Map()
      const foundByHighlight = new Map<Highlight, PageRects[] | null>()
      const tableMatches = new Map<Highlight, TableCellMatch | null>()
      const groups = new Map<string, Array<Highlight & { sourceScope: EvidenceSourceScope }>>()
      for (const highlight of highlights) {
        const key = scopeKey(highlight.sourceScope)
        const group = groups.get(key) ?? []
        group.push(highlight)
        groups.set(key, group)
      }
      const geometryIndex = buildSegmentGeometryIndex(
        anchors,
        tables,
        [...groups.values()].map((group) => group[0].sourceScope),
      )

      await resolveWithConcurrency([...groups.values()], 6, async (group) => {
        const geometry = geometryIndex.get(group[0].sourceScope.segmentId)
        if (!geometry) return
        const scopedMatches = resolveTableCellMatches(
          geometry.tables,
          group,
          occurrenceIndices,
        )
        for (const highlight of group) {
          tableMatches.set(highlight, scopedMatches.get(highlight) ?? null)
        }
        await Promise.all(group.map(async (highlight) => {
          const found =
            (await findTableCellRects(viewer, tableMatches.get(highlight) ?? null, viewportCache)) ??
            (await findAnchorRects(viewer, markdown, geometry.anchors, highlight, viewportCache))
          foundByHighlight.set(highlight, found)
        }))
      })
      if (cancelled) return

      const canvas = canvasRef.current
      if (!canvas || !containerEl) return
      const { scrollWidth, scrollHeight } = containerEl
      canvas.width = scrollWidth
      canvas.height = scrollHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const containerRect = containerEl.getBoundingClientRect()
      const entries: CachedEntry[] = []

      for (const h of resolvedInTraversalOrder(highlights, foundByHighlight)) {
        const found = foundByHighlight.get(h)
        if (!found) continue
        for (const fragment of found) {
          const pageEl = containerEl.querySelector(
            `.page[data-page-number="${fragment.pageNumber}"]`
          ) as HTMLElement | null
          if (!pageEl) continue
          const pageRect = pageEl.getBoundingClientRect()
          const pageTop = pageRect.top - containerRect.top + containerEl.scrollTop + pageEl.clientTop
          const pageLeft = pageRect.left - containerRect.left + containerEl.scrollLeft + pageEl.clientLeft
          entries.push({ highlight: h, pageNumber: fragment.pageNumber, rects: fragment.rects, pageTop, pageLeft })
        }
      }

      if (cancelled) return
      cachedEntriesRef.current = entries
      drawCachedEntries(ctx, entries, focusPathRef.current)
      setCacheVersion((v: number) => v + 1)
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
    drawCachedEntries(ctx, entries, focusPath)
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
