import { useEffect, useRef } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { Evidence } from './api'
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
    if (key === '_evidence') continue
    map[key] = PALETTE[i % PALETTE.length]
    i++
  }
  return map
}

function topLevelColor(fieldKey: string, colorMap: Record<string, string>): string {
  return colorMap[fieldKey] ?? PALETTE[0]
}

type Highlight = {
  page: number
  snippet: string
  color: string
}

function buildHighlights(evidence: Evidence, colorMap: Record<string, string>): Highlight[] {
  return Object.entries(evidence)
    .filter(([, item]) => item.snippet && item.page > 0)
    .map(([key, item]) => ({
      page: item.page,
      snippet: item.snippet.trim(),
      color: topLevelColor(key, colorMap),
    }))
}

type PageRects = { pageNumber: number; rects: DOMRect[] }

async function searchSnippetInPage(
  pdfViewer: PDFViewer,
  pageNumber: number,
  normalised: string,
): Promise<DOMRect[]> {
  const pdfPage = await pdfViewer.pdfDocument?.getPage(pageNumber)
  if (!pdfPage) return []

  const textContent = await pdfPage.getTextContent()
  const viewport = pdfPage.getViewport({ scale: pdfViewer.currentScale })

  const items = textContent.items.filter(
    (item): item is typeof item & { str: string; transform: number[]; width: number; height: number } =>
      'str' in item,
  )
  const fullText = items.map((i) => i.str).join(' ')
  const idx = fullText.toLowerCase().indexOf(normalised.toLowerCase())
  if (idx === -1) return []

  const rects: DOMRect[] = []
  let cursor = 0
  for (const item of items) {
    const itemEnd = cursor + item.str.length + 1
    const snippetEnd = idx + normalised.length
    if (itemEnd > idx && cursor < snippetEnd) {
      const [, , , , tx, ty] = item.transform
      const x = tx * viewport.scale
      const y = viewport.height - (ty + item.height) * viewport.scale
      const w = item.width * viewport.scale
      const h = item.height * viewport.scale
      rects.push(new DOMRect(x, y, w, h))
    }
    cursor += item.str.length + 1
  }
  return rects
}

// Search all pages for the snippet; the model's page hint is unreliable
// (it reads printed page numbers, not PDF page indices).
async function findSnippetRects(
  pdfViewer: PDFViewer,
  snippet: string,
): Promise<PageRects | null> {
  const pageCount = pdfViewer.pdfDocument?.numPages ?? 0
  const normalised = snippet.replace(/\s+/g, ' ').trim()
  for (let p = 1; p <= pageCount; p++) {
    const rects = await searchSnippetInPage(pdfViewer, p, normalised)
    if (rects.length > 0) return { pageNumber: p, rects }
  }
  return null
}

type Props = {
  pdfViewer: PDFViewer | null
  evidence: Evidence | null
  containerEl: HTMLDivElement | null
  schema: unknown
}

export default function EvidenceHighlightLayer({ pdfViewer, evidence, containerEl, schema }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    if (!pdfViewer || !evidence || !containerEl) return

    const colorMap = buildTopLevelColorMap(schema)
    const highlights = buildHighlights(evidence, colorMap)
    if (highlights.length === 0) return

    let cancelled = false

    async function render() {
      const canvas = canvasRef.current
      if (!canvas || !pdfViewer || !containerEl) return

      // Size canvas to match the scrollable viewer content
      const viewer = containerEl.querySelector('.pdfViewer') as HTMLElement | null
      if (!viewer) return
      const { scrollWidth, scrollHeight } = containerEl
      canvas.width = scrollWidth
      canvas.height = scrollHeight

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      for (const h of highlights) {
        if (cancelled) return

        const found = await findSnippetRects(pdfViewer, h.snippet)
        if (!found) continue

        const pageEl = containerEl.querySelector(
          `.page[data-page-number="${found.pageNumber}"]`
        ) as HTMLElement | null
        if (!pageEl) continue

        const pageOffsetTop = pageEl.offsetTop
        const pageOffsetLeft = pageEl.offsetLeft

        for (const rect of found.rects) {
          if (cancelled) return
          ctx.fillStyle = h.color
          ctx.fillRect(
            pageOffsetLeft + rect.x,
            pageOffsetTop + rect.y,
            rect.width,
            rect.height,
          )
        }
      }
    }

    void render()
    return () => { cancelled = true }
  }, [pdfViewer, evidence, containerEl, schema])

  if (!evidence) return null

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute top-0 left-0 z-10"
      aria-hidden="true"
    />
  )
}
