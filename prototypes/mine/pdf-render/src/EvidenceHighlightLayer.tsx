import { useEffect, useRef } from 'react'
import type { PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs'
import type { Evidence, EvidenceItem } from './api'
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

type Highlight = {
  page: number
  snippet: string
  color: string
}

function isLeaf(v: unknown): v is EvidenceItem {
  return isRecord(v) && typeof (v as EvidenceItem).snippet === 'string' && typeof (v as EvidenceItem).page === 'number'
}

function collectLeaves(value: unknown, color: string, out: Highlight[]): void {
  if (isLeaf(value)) {
    if (value.snippet && value.page > 0)
      out.push({ page: value.page, snippet: value.snippet.trim(), color })
  } else if (Array.isArray(value)) {
    for (const item of value) collectLeaves(item, color, out)
  } else if (isRecord(value)) {
    for (const sub of Object.values(value)) collectLeaves(sub, color, out)
  }
}

function buildHighlights(evidence: Evidence, colorMap: Record<string, string>): Highlight[] {
  const highlights: Highlight[] = []
  for (const [key, value] of Object.entries(evidence)) {
    collectLeaves(value, colorMap[key] ?? PALETTE[0], highlights)
  }
  return highlights
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

  // Normalise each item's text and skip whitespace-only items so that cursor
  // positions in the joined search string stay in sync with the item list.
  type HasStr = { str: string; transform: number[]; width: number; height: number }
  const rawItems = textContent.items.filter(
    (item): item is typeof item & HasStr => 'str' in item,
  )
  const items: typeof rawItems = []
  const normStrs: string[] = []
  for (const item of rawItems) {
    const norm = item.str.replace(/\s+/g, ' ').trim()
    if (norm) {
      items.push(item)
      normStrs.push(norm)
    }
  }

  // Join normalised item strings with a single space — consistent with cursor tracking.
  const fullText = normStrs.join(' ')
  const idx = fullText.toLowerCase().indexOf(normalised.toLowerCase())
  if (idx === -1) return []

  const rects: DOMRect[] = []
  let cursor = 0
  const snippetEnd = idx + normalised.length
  for (let i = 0; i < items.length; i++) {
    const normLen = normStrs[i].length
    const itemEnd = cursor + normLen
    if (itemEnd > idx && cursor < snippetEnd) {
      const item = items[i]
      const [, , , , tx, ty] = item.transform
      const x = tx * viewport.scale
      const y = viewport.height - (ty + item.height) * viewport.scale
      const w = item.width * viewport.scale
      const h = item.height * viewport.scale
      rects.push(new DOMRect(x, y, w, h))
    }
    cursor += normLen + 1  // +1 for the single space separator from join
  }
  return rects
}

// Search all pages for the snippet. Because the model reads rasterised images,
// its snippets may contain minor OCR errors — especially near the end of the
// extracted text. Fall back to progressively shorter word-prefix queries so
// that a wrong last word doesn't block a valid match.
async function findSnippetRects(
  pdfViewer: PDFViewer,
  snippet: string,
): Promise<PageRects | null> {
  const pageCount = pdfViewer.pdfDocument?.numPages ?? 0
  const base = snippet.replace(/\s+/g, ' ').trim()
  const words = base.split(' ')

  const seen = new Set<string>()
  const queries: string[] = []
  const add = (q: string) => {
    const t = q.trim()
    if (t && !seen.has(t)) { seen.add(t); queries.push(t) }
  }

  add(base)
  // Shorter prefixes tolerate OCR errors in the last words of the snippet.
  if (words.length > 6) add(words.slice(0, Math.ceil(words.length * 0.6)).join(' '))
  if (words.length > 4) add(words.slice(0, 5).join(' '))
  if (words.length > 2) add(words.slice(0, 3).join(' '))

  for (const query of queries) {
    for (let p = 1; p <= pageCount; p++) {
      const rects = await searchSnippetInPage(pdfViewer, p, query)
      if (rects.length > 0) {
        if (query !== base) console.log('[highlight] matched on prefix:', JSON.stringify(query))
        return { pageNumber: p, rects }
      }
    }
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
    if (!pdfViewer || !evidence || !containerEl) {
      console.log('[highlight] skip — pdfViewer:', !!pdfViewer, 'evidence:', evidence, 'containerEl:', !!containerEl)
      return
    }

    const colorMap = buildTopLevelColorMap(schema)
    const highlights = buildHighlights(evidence, colorMap)
    console.log('[highlight] evidence keys:', Object.keys(evidence), '| built:', highlights.length, highlights)
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

      // Use getBoundingClientRect to correctly handle any intermediate positioned
      // ancestors (e.g. .pdfViewer with position:relative). Compensate for scroll
      // so highlight coordinates are in canvas (content) space, not viewport space.
      const containerRect = containerEl.getBoundingClientRect()

      for (const h of highlights) {
        if (cancelled) return

        const found = await findSnippetRects(pdfViewer, h.snippet)
        console.log('[highlight] snippet:', JSON.stringify(h.snippet.slice(0, 60)), '→', found ? `page ${found.pageNumber}, ${found.rects.length} rects` : 'NOT FOUND')
        if (!found) continue

        const pageEl = containerEl.querySelector(
          `.page[data-page-number="${found.pageNumber}"]`
        ) as HTMLElement | null
        if (!pageEl) continue

        const pageRect = pageEl.getBoundingClientRect()
        const pageTop = pageRect.top - containerRect.top + containerEl.scrollTop
        const pageLeft = pageRect.left - containerRect.left + containerEl.scrollLeft

        for (const rect of found.rects) {
          if (cancelled) return
          ctx.fillStyle = h.color
          ctx.fillRect(
            pageLeft + rect.x,
            pageTop + rect.y,
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
