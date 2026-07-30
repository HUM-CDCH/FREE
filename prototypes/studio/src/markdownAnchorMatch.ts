import type { BoundingBox, EvidenceAnchor } from './parsedDocument'

export type AnchorMatch = { page: number; bbox: BoundingBox }

// Anchor-based lookup tier (see design.md / evidence-anchor-index spec): finds
// a field's snippet in the canonical Markdown already fetched for the open
// document, then resolves the anchor(s) covering that character range. Only
// `snippet` is ever searched for here — `value` is looked up by the later PDF
// text-search fallback, never by this tier (see spec scenario "Anchor lookup
// never uses the field's value directly").
export function findMarkdownAnchorMatch(
  markdown: string,
  anchors: EvidenceAnchor[],
  snippet: string | null,
): AnchorMatch | null {
  if (!snippet || anchors.length === 0) return null
  const start = markdown.indexOf(snippet)
  if (start === -1) return null
  const end = start + snippet.length

  const covering = anchors.filter((a) => a.markdownStart < end && a.markdownEnd > start)
  if (covering.length === 0) return null

  // A snippet straddling a page boundary has no single coherent bbox.
  const page = covering[0].page
  if (!covering.every((a) => a.page === page)) return null

  const bbox = covering.reduce<BoundingBox>(
    (acc, a) => ({
      x0: Math.min(acc.x0, a.bbox.x0),
      y0: Math.min(acc.y0, a.bbox.y0),
      x1: Math.max(acc.x1, a.bbox.x1),
      y1: Math.max(acc.y1, a.bbox.y1),
    }),
    covering[0].bbox,
  )

  return { page, bbox }
}
