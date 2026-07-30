import type { BoundingBox, ParsedTable, TableCell } from './parsedDocument'

export type TableCellMatch = { pageNumber: number; bbox: BoundingBox }

type Candidate = { table: ParsedTable; cell: TableCell }

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

// Dash-variant characters commonly produced by PDF text extraction in place
// of a plain hyphen (en dash, em dash, minus sign, non-breaking hyphen, etc).
const DASH_VARIANTS_RE = /[‐‑‒–—―−]/g
const PUNCTUATION_RE = /[.,;:!?'"()[\]{}/\\]/g

function normalizeTolerant(text: string): string {
  return normalize(text.replace(DASH_VARIANTS_RE, '-').replace(PUNCTUATION_RE, ''))
}

// Borrowed from this project's own prior, never-merged table-matching attempt
// (`_table_evidence.ts`'s `textsMatch`) rather than a hand-rolled
// word-boundary regex: exact equality always matches; otherwise containment
// is only accepted when the shorter string is at least 4 characters, so short
// numeric values can't spuriously match inside an unrelated longer number.
function textsMatchTolerant(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  return Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))
}

// Ranks each highlight by its 0-based occurrence order among OTHER highlights that
// share its exact (field key, normalized value, hint page) triple, in the order
// `highlights` is given (i.e. document/traversal order). This is deliberately NOT
// the highlight's absolute index within a `records` array: when `records` spans
// multiple unrelated tables (e.g. one table per grave, flattened into one array),
// most records don't share the ambiguous value at all, so the absolute array index
// overcounts — see design.md's "positional fallback" risk, confirmed by a real
// extraction where record indices 1 and 2 shared a value but the correct table
// cells were the 1st and 2nd occurrences of that value, not indices 1 and 2 into
// the candidate list. Grouping by hint page too (rather than globally) matches how
// findTableCellMatch narrows candidates to a single page before indexing into them
// — otherwise a second duplicate pair on a later page would compute an occurrence
// index that falls outside that page's narrowed candidate range.
export function computeOccurrenceIndices<T extends { path: readonly string[]; value: string; hintPage: number | null }>(
  highlights: readonly T[],
): Map<T, number> {
  const seen = new Map<string, number>()
  const indices = new Map<T, number>()
  for (const highlight of highlights) {
    const key = `${highlight.path.at(-1) ?? ''}::${normalize(highlight.value)}::${highlight.hintPage ?? ''}`
    const occurrence = seen.get(key) ?? 0
    indices.set(highlight, occurrence)
    seen.set(key, occurrence + 1)
  }
  return indices
}

// Exact tier first, per table; only a table with zero exact matches falls
// back to the tolerant tier (dash/whitespace/punctuation normalization plus
// length-gated substring containment), so behavior is unchanged wherever
// exact matching already succeeds for a given table.
function collectCandidates(tables: readonly ParsedTable[], value: string): Candidate[] {
  const target = normalize(value)
  if (!target) return []
  const tolerantTarget = normalizeTolerant(value)
  const candidates: Candidate[] = []
  for (const table of tables) {
    const exact = table.cells.filter((cell) => normalize(cell.text) === target)
    if (exact.length > 0) {
      candidates.push(...exact.map((cell) => ({ table, cell })))
      continue
    }
    for (const cell of table.cells) {
      if (textsMatchTolerant(tolerantTarget, normalizeTolerant(cell.text))) {
        candidates.push({ table, cell })
      }
    }
  }
  return candidates
}

function rowHeaderText(table: ParsedTable, row: number): string | null {
  const cell = table.cells.find((c) => c.row === row && (c.role === 'row_header' || c.role === 'row_header_hint'))
  return cell ? cell.text : null
}

function columnHeaderText(table: ParsedTable, col: number): string | null {
  const cell = table.cells.find((c) => c.col === col && (c.role === 'header' || c.role === 'column_header'))
  return cell ? cell.text : null
}

function filterByHeaderHints(
  candidates: readonly Candidate[],
  rowHeader: string | null,
  columnHeader: string | null,
): Candidate[] {
  const wantRow = rowHeader && rowHeader.trim() ? normalize(rowHeader) : null
  const wantColumn = columnHeader && columnHeader.trim() ? normalize(columnHeader) : null
  if (wantRow === null && wantColumn === null) {
    return []
  }

  return candidates.filter(({ table, cell }) => {
    const rowMatches = wantRow === null || normalize(rowHeaderText(table, cell.row) ?? '') === wantRow
    const columnMatches = wantColumn === null || normalize(columnHeaderText(table, cell.col) ?? '') === wantColumn
    return rowMatches && columnMatches
  })
}

function sortReadingOrder(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if (a.table.pageNumber !== b.table.pageNumber) return a.table.pageNumber - b.table.pageNumber
    const ay = a.cell.bbox?.y0 ?? Number.POSITIVE_INFINITY
    const by = b.cell.bbox?.y0 ?? Number.POSITIVE_INFINITY
    if (ay !== by) return ay - by
    const ax = a.cell.bbox?.x0 ?? Number.POSITIVE_INFINITY
    const bx = b.cell.bbox?.x0 ?? Number.POSITIVE_INFINITY
    return ax - bx
  })
}

function toMatch(candidate: Candidate | undefined): TableCellMatch | null {
  if (!candidate || !candidate.cell.bbox) return null
  return { pageNumber: candidate.table.pageNumber, bbox: candidate.cell.bbox }
}

// Three-tier resolution (see design.md decision 6): exact text match -> row/column
// header-hint disambiguation -> reading-order positional fallback by occurrence
// index (see computeOccurrenceIndices — NOT a `records[]` array index).
// Never throws; returns null whenever resolution is inconclusive so callers can
// fall back to the pre-existing PDF text search.
export function findTableCellMatch(
  tables: readonly ParsedTable[],
  value: string,
  rowHeader: string | null,
  columnHeader: string | null,
  hintPage: number | null,
  occurrenceIndex: number | null,
): TableCellMatch | null {
  let candidates = collectCandidates(tables, value)
  if (candidates.length === 0) {
    return null
  }
  if (candidates.length === 1) {
    return toMatch(candidates[0])
  }

  if (hintPage != null) {
    const onHintPage = candidates.filter((c) => c.table.pageNumber === hintPage)
    if (onHintPage.length > 0) {
      candidates = onHintPage
    }
  }
  if (candidates.length === 1) {
    return toMatch(candidates[0])
  }

  const narrowed = filterByHeaderHints(candidates, rowHeader, columnHeader)
  if (narrowed.length === 1) {
    return toMatch(narrowed[0])
  }

  if (occurrenceIndex === null) {
    return null
  }
  const remaining = narrowed.length > 0 ? narrowed : candidates
  const sorted = sortReadingOrder(remaining)
  if (occurrenceIndex < 0 || occurrenceIndex >= sorted.length) {
    return null
  }
  return toMatch(sorted[occurrenceIndex])
}
