import { isRecord } from './template'

// Paul Tol's Muted palette — sky blue, olive, rose, teal
// Distinguishable across deuteranopia, protanopia, and tritanopia.
export const PALETTE: string[] = [
  'rgba(148, 203, 236, 0.55)',
  'rgba(220, 205, 125, 0.55)',
  'rgba(194, 106, 119, 0.45)',
  'rgba(93, 168, 153, 0.45)',
]

export type EvidenceSourceScope = {
  segmentId: string
  markdownStart: number
  markdownEnd: number
  startPage: number
  endPage: number
}

export type CanonicalSpan = {
  markdownStart: number
  markdownEnd: number
}

export type MatchStrategy = 'result-primary' | 'snippet-primary'

export type Highlight = {
  value: string
  snippet: string | null
  hintPage: number | null
  rowHeader: string | null
  columnHeader: string | null
  sourceScope: EvidenceSourceScope | null
  canonicalSpan: CanonicalSpan | null
  matchStrategy: MatchStrategy
  color: string
  path: string[]
}

export type CachedHighlightEntry = {
  highlight: Highlight
  pageNumber: number
  rects: DOMRect[]
  pageTop: number
  pageLeft: number
}

export type PaintRect = {
  entry: CachedHighlightEntry
  rect: DOMRect
}

function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

function paintRectKey(entry: CachedHighlightEntry, rect: DOMRect): string {
  return [
    entry.pageNumber,
    entry.highlight.color,
    entry.pageLeft + rect.x - 1,
    entry.pageTop + rect.y - 2,
    rect.width + 2,
    rect.height + 2,
  ].join(':')
}

export function coalescePaintRects(
  entries: readonly CachedHighlightEntry[],
  focusPath: string[] | null,
): PaintRect[] {
  const byKey = new Map<string, PaintRect>()
  for (const entry of entries) {
    for (const rect of entry.rects) {
      const key = paintRectKey(entry, rect)
      const existing = byKey.get(key)
      const isActive = focusPath !== null && pathsEqual(entry.highlight.path, focusPath)
      const existingIsActive =
        existing !== undefined &&
        focusPath !== null &&
        pathsEqual(existing.entry.highlight.path, focusPath)
      if (!existing || (isActive && !existingIsActive)) {
        byKey.set(key, { entry, rect })
      }
    }
  }
  return [...byKey.values()]
}

export function resolvedInTraversalOrder<T>(
  highlights: readonly T[],
  resolved: ReadonlyMap<T, unknown | null>,
): T[] {
  return highlights.filter((highlight) => resolved.get(highlight) != null)
}

function sourceScopeFromEvidence(node: Record<string, unknown>): EvidenceSourceScope | null {
  const scope = node.source_scope
  if (!isRecord(scope)) return null
  const { segment_id, markdown_start, markdown_end, start_page, end_page } = scope
  if (
    typeof segment_id !== 'string' ||
    !segment_id ||
    typeof markdown_start !== 'number' ||
    typeof markdown_end !== 'number' ||
    typeof start_page !== 'number' ||
    typeof end_page !== 'number' ||
    markdown_start < 0 ||
    markdown_end < markdown_start ||
    start_page < 1 ||
    end_page < start_page
  ) return null
  return {
    segmentId: segment_id,
    markdownStart: markdown_start,
    markdownEnd: markdown_end,
    startPage: start_page,
    endPage: end_page,
  }
}

function primitiveText(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim()
    return text || null
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return null
}

function findUniqueScopedSpan(
  markdown: string | null | undefined,
  term: string | null,
  scope: EvidenceSourceScope,
): CanonicalSpan | null {
  if (!markdown || !term) return null
  const scopeStart = Math.max(0, scope.markdownStart)
  const scopeEnd = Math.min(markdown.length, scope.markdownEnd)
  const spans: CanonicalSpan[] = []
  let from = scopeStart
  for (;;) {
    const start = markdown.indexOf(term, from)
    const end = start + term.length
    if (start === -1 || end > scopeEnd) break
    spans.push({ markdownStart: start, markdownEnd: end })
    if (spans.length > 1) return null
    from = end
  }
  return spans[0] ?? null
}

function canonicalSpanFromEvidence(
  markdown: string | null | undefined,
  value: string,
  snippet: string,
  matchStrategy: MatchStrategy,
  scope: EvidenceSourceScope,
): CanonicalSpan | null {
  const primaryTerm = matchStrategy === 'result-primary' ? value : snippet
  const primary = findUniqueScopedSpan(markdown, primaryTerm, scope)
  if (primary) return primary

  const secondaryTerm = primaryTerm === value ? snippet : value
  if (secondaryTerm === primaryTerm) return null
  return findUniqueScopedSpan(markdown, secondaryTerm, scope)
}

function schemaArrayItem(schema: unknown): unknown {
  return Array.isArray(schema) ? schema[0] : undefined
}

function collectEvidenceLeaf(
  resultValue: unknown,
  node: unknown,
  schema: unknown,
  color: string,
  path: string[],
  out: Highlight[],
  markdown?: string | null,
): boolean {
  if (
    isRecord(node) &&
    typeof node.snippet === 'string'
  ) {
    const v = primitiveText(resultValue)
    const s = node.snippet.trim()
    const sourceScope = sourceScopeFromEvidence(node)
    if (v && s && sourceScope) {
      const matchStrategy =
        typeof resultValue === 'string' && schema === 'verbatim-string'
          ? 'result-primary'
          : 'snippet-primary'
      out.push({
        value: v,
        snippet: s,
        hintPage: typeof node.page === 'number' ? node.page : null,
        rowHeader: typeof node.row_header === 'string' && node.row_header.trim() ? node.row_header : null,
        columnHeader: typeof node.column_header === 'string' && node.column_header.trim() ? node.column_header : null,
        sourceScope,
        canonicalSpan: canonicalSpanFromEvidence(markdown, v, s, matchStrategy, sourceScope),
        matchStrategy,
        color,
        path,
      })
    }
    return true
  }
  return false
}

function collectHighlightLeaves(
  resultNode: unknown,
  evidenceNode: unknown,
  schemaNode: unknown,
  color: string,
  path: string[],
  out: Highlight[],
  markdown?: string | null,
): void {
  if (collectEvidenceLeaf(resultNode, evidenceNode, schemaNode, color, path, out, markdown)) return

  if (Array.isArray(resultNode)) {
    const evidenceItems = Array.isArray(evidenceNode) ? evidenceNode : []
    const itemSchema = schemaArrayItem(schemaNode)
    for (let i = 0; i < resultNode.length; i++) {
      collectHighlightLeaves(resultNode[i], evidenceItems[i], itemSchema, color, [...path, String(i)], out, markdown)
    }
  } else if (isRecord(resultNode)) {
    const evidenceRecord = isRecord(evidenceNode) ? evidenceNode : {}
    const schemaRecord = isRecord(schemaNode) ? schemaNode : {}
    for (const [key, value] of Object.entries(resultNode)) {
      collectHighlightLeaves(value, evidenceRecord[key], schemaRecord[key], color, [...path, key], out, markdown)
    }
  }
}

export function buildHighlights(
  result: Record<string, unknown>,
  evidence: unknown,
  fieldColorMap?: Record<string, string>,
  schemaTemplate?: unknown,
  markdown?: string | null,
): Highlight[] {
  const out: Highlight[] = []

  // Unwrap array-wrapped results: { records: [{field1, field2, ...}, ...] }
  // Color is assigned per schema field name, consistent across all records.
  if (Array.isArray(result.records)) {
    const evidenceRecords = isRecord(evidence) && Array.isArray(evidence.records)
      ? evidence.records : []
    const recordSchema =
      isRecord(schemaTemplate) && Array.isArray(schemaTemplate.records)
        ? schemaTemplate.records[0]
        : undefined
    for (let r = 0; r < result.records.length; r++) {
      const rec = result.records[r]
      if (!isRecord(rec)) continue
      const evidenceRec = isRecord(evidenceRecords[r]) ? evidenceRecords[r] : {}
      let i = 0
      for (const [key, value] of Object.entries(rec)) {
        const color = fieldColorMap?.[key] ?? PALETTE[i % PALETTE.length]
        const fieldSchema = isRecord(recordSchema) ? recordSchema[key] : undefined
        collectHighlightLeaves(value, (evidenceRec as Record<string, unknown>)[key], fieldSchema, color, ['records', String(r), key], out, markdown)
        i++
      }
    }
    return out
  }

  // Non-wrapped: assign color per top-level key
  const evidenceRecord = isRecord(evidence) ? evidence : {}
  let i = 0
  for (const [key, value] of Object.entries(result)) {
    const color = fieldColorMap?.[key] ?? PALETTE[i % PALETTE.length]
    const fieldSchema = isRecord(schemaTemplate) ? schemaTemplate[key] : undefined
    collectHighlightLeaves(value, evidenceRecord[key], fieldSchema, color, [key], out, markdown)
    i++
  }
  return out
}
