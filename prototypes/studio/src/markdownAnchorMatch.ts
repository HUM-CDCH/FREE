import type { BoundingBox, EvidenceAnchor } from './parsedDocument'
import type { EvidenceSourceScope } from './evidenceHighlights'

export type AnchorFragment = { page: number; bbox: BoundingBox }
export type AnchorMatch = { fragments: AnchorFragment[] }

// Resolves the anchor(s) covering one occurrence of the snippet (a character
// range in `markdown`) to one unioned bbox per PDF page, or null when no
// anchor covers it. This keeps a cross-page source match deterministic.
function resolveOccurrence(anchors: EvidenceAnchor[], start: number, end: number): AnchorMatch | null {
  const covering = anchors.filter((a) => a.markdownStart < end && a.markdownEnd > start)
  if (covering.length === 0) return null
  const byPage = new Map<number, EvidenceAnchor[]>()
  for (const anchor of covering) {
    const group = byPage.get(anchor.page) ?? []
    group.push(anchor)
    byPage.set(anchor.page, group)
  }
  const fragments = [...byPage.entries()]
    .sort(([a], [b]) => a - b)
    .map(([page, pageAnchors]) => ({
      page,
      bbox: pageAnchors.reduce<BoundingBox>(
        (acc, anchor) => ({
          x0: Math.min(acc.x0, anchor.bbox.x0),
          y0: Math.min(acc.y0, anchor.bbox.y0),
          x1: Math.max(acc.x1, anchor.bbox.x1),
          y1: Math.max(acc.y1, anchor.bbox.y1),
        }),
        pageAnchors[0].bbox,
      ),
    }))
  return { fragments }
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
  sourceScope: EvidenceSourceScope | null = null,
): AnchorMatch | null {
  if (!snippet || anchors.length === 0) return null

  const matches: AnchorMatch[] = []
  const scopeStart = sourceScope ? Math.max(0, sourceScope.markdownStart) : 0
  const scopeEnd = sourceScope ? Math.min(markdown.length, sourceScope.markdownEnd) : markdown.length
  const scopedAnchors = sourceScope
    ? anchors.filter((anchor) => anchor.markdownStart >= scopeStart && anchor.markdownEnd <= scopeEnd)
    : anchors
  let from = scopeStart
  for (;;) {
    const start = markdown.indexOf(snippet, from)
    const end = start + snippet.length
    if (start === -1 || end > scopeEnd) break
    const match = resolveOccurrence(scopedAnchors, start, end)
    if (match) matches.push(match)
    from = end
  }
  if (matches.length === 0) return null
  if (sourceScope) return matches.length === 1 ? matches[0] : null

  const onHintPage = hintPage != null ? matches.filter((match) => match.fragments.some((fragment) => fragment.page === hintPage)) : []
  const pool = onHintPage.length > 0 ? onHintPage : matches
  if (occurrenceIndex !== null && occurrenceIndex >= 0 && occurrenceIndex < pool.length) return pool[occurrenceIndex]
  return pool[0]
}

// Production resolution is always scoped. A verbatim result may be searched
// first, with the evidence snippet serving only as an in-scope recovery path.
export function findScopedMarkdownAnchorMatch(
  markdown: string,
  anchors: EvidenceAnchor[],
  primaryTerm: string | null,
  fallbackSnippet: string | null,
  sourceScope: EvidenceSourceScope,
): AnchorMatch | null {
  const primary = findMarkdownAnchorMatch(
    markdown,
    anchors,
    primaryTerm,
    null,
    null,
    sourceScope,
  )
  if (primary) return primary
  if (!fallbackSnippet || fallbackSnippet === primaryTerm) return null
  return findMarkdownAnchorMatch(
    markdown,
    anchors,
    fallbackSnippet,
    null,
    null,
    sourceScope,
  )
}
