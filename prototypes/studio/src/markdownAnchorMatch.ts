import type { BoundingBox, EvidenceAnchor } from './parsedDocument'

export type AnchorMatch = { page: number; bbox: BoundingBox }

// Resolves the anchor(s) covering one occurrence of the snippet (a character
// range in `markdown`) to a single page + unioned bbox, or null if that
// occurrence is inconclusive (no covering anchor, or the snippet straddles a
// page boundary and so has no single coherent bbox).
function resolveOccurrence(anchors: EvidenceAnchor[], start: number, end: number): AnchorMatch | null {
  const covering = anchors.filter((a) => a.markdownStart < end && a.markdownEnd > start)
  if (covering.length === 0) return null

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

// Anchor-based lookup tier (see design.md / evidence-anchor-index spec): finds
// a field's snippet in the canonical Markdown already fetched for the open
// document, then resolves the anchor(s) covering that character range. Only
// `snippet` is ever searched for here — `value` is looked up by the later PDF
// text-search fallback, never by this tier (see spec scenario "Anchor lookup
// never uses the field's value directly").
//
// The snippet's wording can recur (or closely resemble other text) earlier in
// the document than the evidence actually is — a plain first-`indexOf` would
// silently lock onto that earlier hit. So every occurrence is resolved, the
// hint page (when given) narrows to matches on that page, and `occurrenceIndex`
// (see computeOccurrenceIndices) picks among remaining ties — mirroring how
// `findTableCellMatch`/`rectsForQuery` already disambiguate repeated matches.
export function findMarkdownAnchorMatch(
  markdown: string,
  anchors: EvidenceAnchor[],
  snippet: string | null,
  hintPage: number | null = null,
  occurrenceIndex: number | null = null,
): AnchorMatch | null {
  if (!snippet || anchors.length === 0) return null

  const matches: AnchorMatch[] = []
  let from = 0
  for (;;) {
    const start = markdown.indexOf(snippet, from)
    if (start === -1) break
    const match = resolveOccurrence(anchors, start, start + snippet.length)
    if (match) matches.push(match)
    from = start + snippet.length
  }
  if (matches.length === 0) return null

  const onHintPage = hintPage != null ? matches.filter((m) => m.page === hintPage) : []
  const pool = onHintPage.length > 0 ? onHintPage : matches

  if (occurrenceIndex !== null && occurrenceIndex >= 0 && occurrenceIndex < pool.length) {
    return pool[occurrenceIndex]
  }
  return pool[0]
}
