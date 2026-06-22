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

type Highlight = {
  value: string
  color: string
}

function collectLeaves(node: unknown, color: string, out: Highlight[]): void {
  if (typeof node === 'string') {
    const v = node.trim()
    if (v) out.push({ value: v, color })
  } else if (Array.isArray(node)) {
    for (const item of node) collectLeaves(item, color, out)
  } else if (isRecord(node)) {
    for (const sub of Object.values(node)) collectLeaves(sub, color, out)
  }
  // numbers, booleans, null → skip (not reliably searchable as text)
}

function buildHighlights(result: Record<string, unknown>, colorMap: Record<string, string>): Highlight[] {
  const out: Highlight[] = []
  for (const [key, value] of Object.entries(result)) {
    collectLeaves(value, colorMap[key] ?? PALETTE[0], out)
  }
  return out
}

type PageRects = { pageNumber: number; rects: DOMRect[] }

async function searchValueInPage(
  pdfViewer: PDFViewer,
  pageNumber: number,
  query: string,
): Promise<DOMRect[]> {
  const pdfPage = await pdfViewer.pdfDocument?.getPage(pageNumber)
  if (!pdfPage) return []

  const textContent = await pdfPage.getTextContent()
  // PDF.js renders pages at currentScale × CSS_UNITS (96/72) to convert PDF
  // points to CSS pixels. We must apply the same factor when computing rects.
  const CSS_UNITS = 96.0 / 72.0
  const viewport = pdfPage.getViewport({ scale: pdfViewer.currentScale * CSS_UNITS })

  type HasStr = { str: string; transform: number[]; width: number; height: number }
  const rawItems = textContent.items.filter(
    (item): item is typeof item & HasStr => 'str' in item,
  )
  const items: typeof rawItems = []
  const normStrs: string[] = []
  for (const item of rawItems) {
    const norm = item.str.replace(/\s+/g, ' ').trim()
    if (norm) { items.push(item); normStrs.push(norm) }
  }

  const fullText = normStrs.join(' ')
  const idx = fullText.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return []

  const rects: DOMRect[] = []
  let cursor = 0
  const end = idx + query.length
  for (let i = 0; i < items.length; i++) {
    const normLen = normStrs[i].length
    const itemEnd = cursor + normLen
    if (itemEnd > idx && cursor < end) {
      const [, , , , tx, ty] = items[i].transform
      const x = tx * viewport.scale
      const y = viewport.height - (ty + items[i].height) * viewport.scale
      rects.push(new DOMRect(x, y, items[i].width * viewport.scale, items[i].height * viewport.scale))
    }
    cursor += normLen + 1
  }
  return rects
}

async function findValueRects(
  pdfViewer: PDFViewer,
  value: string,
): Promise<PageRects | null> {
  const pageCount = pdfViewer.pdfDocument?.numPages ?? 0
  const base = value.replace(/\s+/g, ' ').trim()
  if (!base) return null

  // Try progressively shorter prefixes to tolerate OCR/formatting differences
  const words = base.split(' ')
  const seen = new Set<string>()
  const queries: string[] = []
  const add = (q: string) => { const t = q.trim(); if (t && !seen.has(t)) { seen.add(t); queries.push(t) } }
  add(base)
  if (words.length > 4) add(words.slice(0, 5).join(' '))
  if (words.length > 2) add(words.slice(0, 3).join(' '))

  for (const query of queries) {
    for (let p = 1; p <= pageCount; p++) {
      const rects = await searchValueInPage(pdfViewer, p, query)
      if (rects.length > 0) return { pageNumber: p, rects }
    }
  }
  return null
}

type Props = {
  pdfViewer: PDFViewer | null
  result: unknown
  containerEl: HTMLDivElement | null
  schema: unknown
}

export default function EvidenceHighlightLayer({ pdfViewer, result, containerEl, schema }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!pdfViewer || !result || !containerEl || !isRecord(result)) return

    const colorMap = buildTopLevelColorMap(schema)
    const highlights = buildHighlights(result, colorMap)
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

        const found = await findValueRects(pdfViewer, h.value)
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
  }, [pdfViewer, result, containerEl, schema])

  if (!result) return null

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 left-0 z-10"
      aria-hidden="true"
    />
  )
}
