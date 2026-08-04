import type { BoundingBox, EvidenceAnchor } from './parsedDocument'
import type { CanonicalSpan, EvidenceSourceScope } from './evidenceHighlights'

export type AnchorFragment = { page: number; bbox: BoundingBox }
export type AnchorMatch = { fragments: AnchorFragment[] }

const DASH_VARIANTS_RE = /[‐‑‒–—―−]/g
const COMBINING_MARKS_RE = /\p{M}/gu
const TOKEN_RE = /[\p{L}\p{N}%-]+/gu
const MIN_CANDIDATE_CHARS = 18
const MIN_CANDIDATE_TOKENS = 3

type TokenSpan = { token: string; start: number; end: number }
type RawRange = { start: number; end: number }

function anchorsFullyContainedInScope(
  anchors: readonly EvidenceAnchor[],
  scopeStart: number,
  scopeEnd: number,
): EvidenceAnchor[] {
  return anchors.filter(
    (anchor) =>
      anchor.markdownStart >= scopeStart &&
      anchor.markdownEnd <= scopeEnd,
  )
}

export function normalizeTolerantText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS_RE, '')
    .replace(DASH_VARIANTS_RE, '-')
    .replace(/[^\p{L}\p{N}%-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenizeWithRawSpans(text: string, offset = 0): TokenSpan[] {
  const tokens: TokenSpan[] = []
  for (const match of text.matchAll(TOKEN_RE)) {
    const raw = match[0]
    const token = normalizeTolerantText(raw)
    if (!token) continue
    tokens.push({
      token,
      start: offset + (match.index ?? 0),
      end: offset + (match.index ?? 0) + raw.length,
    })
  }
  return tokens
}

function tokenSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return 1 - previous[b.length] / maxLen
}

function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) return true
  if (a.replace(/o/g, '0') === b.replace(/o/g, '0')) return true
  if (Math.min(a.length, b.length) >= 4 && tokenSimilarity(a, b) >= 0.7) return true
  return false
}

function usefulCandidate(value: string): string | null {
  const normalized = normalizeTolerantText(value)
  if (!normalized) return null
  const tokenCount = normalized.split(' ').filter(Boolean).length
  if (normalized.length < MIN_CANDIDATE_CHARS || tokenCount < MIN_CANDIDATE_TOKENS) return null
  return value.trim()
}

export function candidateFragments(snippet: string | null, value: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()

  function add(candidate: string | null | undefined): void {
    if (!candidate) return
    const useful = usefulCandidate(candidate)
    if (!useful) return
    const key = normalizeTolerantText(useful)
    if (seen.has(key)) return
    seen.add(key)
    out.push(useful)
  }

  const source = snippet?.trim() ?? ''
  if (!source || source.startsWith('|')) return []

  add(source)

  const label = source.match(/^[^.!?\n|:]{2,40}:\s+(.+)$/u)
  if (label) add(label[1])

  if (source.includes('...')) {
    for (const part of source.split(/\s*\.\.\.\s*/u)) add(part)
  }

  for (const sentence of source.split(/(?<=[.!?;])\s+/u)) add(sentence)

  if (value) {
    const valueNorm = normalizeTolerantText(value)
    const sourceNorm = normalizeTolerantText(source)
    const valueIndex = valueNorm ? sourceNorm.indexOf(valueNorm) : -1
    if (valueIndex !== -1) {
      add(value)
      const words = source.split(/\s+/u)
      for (let i = 0; i < words.length; i++) {
        for (let j = i + MIN_CANDIDATE_TOKENS; j <= words.length; j++) {
          const fragment = words.slice(i, j).join(' ')
          if (normalizeTolerantText(fragment).includes(valueNorm)) add(fragment)
        }
      }
    }
  }

  return out
}

export function findUniqueTolerantScopedRange(
  markdown: string,
  candidate: string,
  scope: EvidenceSourceScope,
): RawRange | null {
  const scopeStart = Math.max(0, scope.markdownStart)
  const scopeEnd = Math.min(markdown.length, scope.markdownEnd)
  const scopeTokens = tokenizeWithRawSpans(markdown.slice(scopeStart, scopeEnd), scopeStart)
  const candidateTokens = tokenizeWithRawSpans(candidate)
  if (candidateTokens.length < MIN_CANDIDATE_TOKENS) return null

  const ranges: RawRange[] = []
  for (let i = 0; i <= scopeTokens.length - candidateTokens.length; i++) {
    let matched = true
    for (let j = 0; j < candidateTokens.length; j++) {
      if (!tokensMatch(scopeTokens[i + j].token, candidateTokens[j].token)) {
        matched = false
        break
      }
    }
    if (matched) {
      ranges.push({
        start: scopeTokens[i].start,
        end: scopeTokens[i + candidateTokens.length - 1].end,
      })
      if (ranges.length > 1) return null
    }
  }
  return ranges[0] ?? null
}

export function findTolerantScopedMarkdownAnchorMatch(
  markdown: string,
  anchors: EvidenceAnchor[],
  value: string | null,
  snippet: string | null,
  sourceScope: EvidenceSourceScope,
): AnchorMatch | null {
  const scopeStart = Math.max(0, sourceScope.markdownStart)
  const scopeEnd = Math.min(markdown.length, sourceScope.markdownEnd)
  const scopedAnchors = anchorsFullyContainedInScope(anchors, scopeStart, scopeEnd)

  for (const candidate of candidateFragments(snippet, value)) {
    const range = findUniqueTolerantScopedRange(markdown, candidate, sourceScope)
    if (!range) continue
    const match = resolveOccurrence(scopedAnchors, range.start, range.end)
    if (match) return match
  }
  return null
}

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

export function findCanonicalSpanAnchorMatch(
  markdown: string,
  anchors: EvidenceAnchor[],
  canonicalSpan: CanonicalSpan | null,
  sourceScope: EvidenceSourceScope,
): AnchorMatch | null {
  if (!canonicalSpan || anchors.length === 0) return null
  const scopeStart = Math.max(0, sourceScope.markdownStart)
  const scopeEnd = Math.min(markdown.length, sourceScope.markdownEnd)
  const { markdownStart, markdownEnd } = canonicalSpan
  if (
    markdownStart < scopeStart ||
    markdownEnd > scopeEnd ||
    markdownEnd <= markdownStart ||
    markdownEnd > markdown.length
  ) return null

  const scopedAnchors = anchorsFullyContainedInScope(anchors, scopeStart, scopeEnd)
  return resolveOccurrence(scopedAnchors, markdownStart, markdownEnd)
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
    ? anchorsFullyContainedInScope(anchors, scopeStart, scopeEnd)
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
  tolerantValue: string | null = primaryTerm,
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
  if (fallbackSnippet && fallbackSnippet !== primaryTerm) {
    const fallback = findMarkdownAnchorMatch(
      markdown,
      anchors,
      fallbackSnippet,
      null,
      null,
      sourceScope,
    )
    if (fallback) return fallback
  }

  return findTolerantScopedMarkdownAnchorMatch(
    markdown,
    anchors,
    tolerantValue,
    fallbackSnippet ?? primaryTerm,
    sourceScope,
  )
}
