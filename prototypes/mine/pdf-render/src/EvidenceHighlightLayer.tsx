import { useEffect, useRef } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import { isRecord } from './template'

const PALETTE: string[] = [
  'rgba(255, 220, 0, 0.35)',   // yellow
  'rgba(59, 130, 246, 0.30)',  // blue
  'rgba(34, 197, 94, 0.30)',   // green
  'rgba(239, 68, 68, 0.25)',   // red
]

function buildTopLevelColorMap(schema: unknown): Record<string, string> {
  if (!isRecord(schema)) return {}
  const map: Record<string, string> = {}
  let i = 0
  for (const key of Object.keys(schema)) {
    map[key] = PALETTE[i % PALETTE.length]
    i++
  }
  return map
}

// A highlight carries value (what to mark) + snippet (where to anchor) + hint page
type Highlight = { value: string; snippet: string | null; hintPage: number | null; color: string }

// Collect {value, snippet, page} leaves from the evidence tree
function collectEvidenceLeaves(node: unknown, color: string, out: Highlight[]): void {
  if (
    isRecord(node) &&
    typeof node.value === 'string' &&
    typeof node.snippet === 'string'
  ) {
    const v = node.value.trim()
    const s = node.snippet.trim()
    if (v && s) {
      out.push({ value: v, snippet: s, hintPage: typeof node.page === 'number' ? node.page : null, color })
    }
  } else if (Array.isArray(node)) {
    for (const item of node) collectEvidenceLeaves(item, color, out)
  } else if (isRecord(node)) {
    for (const sub of Object.values(node)) collectEvidenceLeaves(sub, color, out)
  }
}

// Fallback: collect string leaves from result (no snippet, no hint)
function collectResultLeaves(node: unknown, color: string, out: Highlight[]): void {
  if (typeof node === 'string') {
    const v = node.trim()
    if (v) out.push({ value: v, snippet: null, hintPage: null, color })
  } else if (Array.isArray(node)) {
    for (const item of node) collectResultLeaves(item, color, out)
  } else if (isRecord(node)) {
    for (const sub of Object.values(node)) collectResultLeaves(sub, color, out)
  }
}

function buildHighlights(
  result: Record<string, unknown>,
  evidence: unknown,
  colorMap: Record<string, string>,
): Highlight[] {
  const out: Highlight[] = []
  if (isRecord(evidence)) {
    // Evidence available: collect snippet-anchored highlights
    for (const [key, sub] of Object.entries(evidence)) {
      collectEvidenceLeaves(sub, colorMap[key] ?? PALETTE[0], out)
    }
  } else {
    // No evidence: fall back to direct result search
    for (const [key, value] of Object.entries(result)) {
      collectResultLeaves(value, colorMap[key] ?? PALETTE[0], out)
    }
  }
  return out
}

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

// ── component ─────────────────────────────────────────────────────────────────

type Props = {
  pdfViewer: PDFViewer | null
  result: unknown
  evidence: unknown
  containerEl: HTMLDivElement | null
  schema: unknown
}

export default function EvidenceHighlightLayer({ pdfViewer, result, evidence, containerEl, schema }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!pdfViewer || !result || !containerEl || !isRecord(result)) return

    const colorMap = buildTopLevelColorMap(schema)
    const highlights = buildHighlights(result, evidence, colorMap)
    if (highlights.length === 0) return

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

        const found = await findValueRects(pdfViewer, h.value, h.snippet, h.hintPage)
        if (!found) continue

        const pageEl = containerEl.querySelector(
          `.page[data-page-number="${found.pageNumber}"]`
        ) as HTMLElement | null
        if (!pageEl) continue

        const pageRect = pageEl.getBoundingClientRect()
        const pageTop = pageRect.top - containerRect.top + containerEl.scrollTop + pageEl.clientTop
        const pageLeft = pageRect.left - containerRect.left + containerEl.scrollLeft + pageEl.clientLeft

        for (const rect of found.rects) {
          if (cancelled) return
          ctx.fillStyle = h.color
          ctx.fillRect(pageLeft + rect.x, pageTop + rect.y, rect.width, rect.height)
        }
      }
    }

    void render()
    return () => { cancelled = true }
  }, [pdfViewer, result, evidence, containerEl, schema])

  if (!result) return null

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 left-0 z-10"
      aria-hidden="true"
    />
  )
}
