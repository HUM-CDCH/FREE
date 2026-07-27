// Lightweight "catalog" document sectioning: split a document's canonical
// Markdown into record-aligned sections using the level-1 headings the
// parsing service already emits from Docling's <section_header_level_1>/
// <title> doctags (see doctags_to_markdown.py), and locate each section's
// absolute page from the same `\n\n---\n\n` page-break sentinel the parsing
// service inserts between pages. No model call is involved in either step —
// this stands in for the boundary-detection LLM pass the historical FREE
// Catalog pipeline used, using structure the parser already computed.

const PAGE_BREAK = '\n\n---\n\n'
const LEVEL_1_HEADING = /^# (.+)$/gm
// GitHub-flavored-Markdown table header-separator row, e.g. "| --- | --- |" or
// "|---|:---:|" — the canonical LLM Markdown the parsing service emits renders
// every table with this exact pipe syntax, so its presence in a section's body
// reliably means that section contains at least one table.
const MARKDOWN_TABLE_SEPARATOR_ROW = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/m

export type MarkdownSection = {
  readonly headingText: string
  readonly body: string
  readonly startOffset: number
}

// The template's one repeated-array field, when it's the template's only
// extraction target (aside from top-level `_description` guidance). Mirrors
// the historical schema_infer.py's `_is_array_of_objects` check, adapted to
// this codebase's template shape (a singleton array whose element is itself
// a field template, the same convention `_model_output.ts`'s
// `valueSchemaFromTemplate` already relies on).
export function findPrimaryArrayKey(template: unknown): string | null {
  if (!isRecord(template)) return null
  const keys = Object.keys(template).filter((key) => key !== '_description')
  if (keys.length !== 1) return null
  const [key] = keys
  const value = template[key]
  if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0])) return null
  return key
}

// Not every level-1 heading is a record boundary: Docling sometimes emits a
// spurious <section_header_level_1> mid-record (e.g. a sentence fragment
// mis-detected as a heading). Splitting on *every* "# " line would fragment
// those records. Instead, detect which headings recur with a common shape
// ("Grav 8", "Grav 13", ... all share the shape "grav") and treat only that
// recurring pattern as record boundaries — a stand-in for what the
// historical LLM boundary-detection pass inferred semantically.
function headingShape(headingText: string): string {
  return headingText
    .toLowerCase()
    .replace(/\d+/g, '')
    .replace(/[^\p{L}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

// The most common heading shape, when it recurs at least twice; null when no
// shape recurs (every heading looks structurally distinct).
function dominantHeadingShape(headingTexts: readonly string[]): string | null {
  const counts = new Map<string, number>()
  for (const text of headingTexts) {
    const shape = headingShape(text)
    if (!shape) continue
    counts.set(shape, (counts.get(shape) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 1 // must recur (>= 2) to count as a pattern
  for (const [shape, count] of counts) {
    if (count > bestCount) {
      best = shape
      bestCount = count
    }
  }
  return best
}

// Splits on the recurring level-1 ("# ") heading pattern only — "## "/deeper
// headings are left untouched as they mark subsections within one record,
// and level-1 headings that don't match the dominant recurring shape are
// folded into whichever record section they fall inside, not split out on
// their own. Returns [] when there's no recurring level-1 heading pattern at
// all, signaling "not sectionable" (the caller falls back to a single
// whole-document pass).
export function splitMarkdownByHeadings(markdown: string): readonly MarkdownSection[] {
  const matches = [...markdown.matchAll(LEVEL_1_HEADING)]
  if (matches.length < 2) return []

  const shape = dominantHeadingShape(matches.map((match) => match[1]))
  if (!shape) return []

  const boundaries = matches.filter((match) => headingShape(match[1]) === shape)
  if (boundaries.length < 2) return []

  return boundaries.map((match, i) => {
    const start = match.index ?? 0
    const end = i + 1 < boundaries.length ? (boundaries[i + 1].index ?? markdown.length) : markdown.length
    return {
      headingText: match[1].trim(),
      body: markdown.slice(start, end).trim(),
      startOffset: start,
    }
  })
}

// Whether a single section's own Markdown body contains a table, independent
// of whether the document as a whole has any. Drives per-section evidence
// gating in runSectionedExtraction (_model.ts) — a section with no table gets
// no row_header/column_header prompt overhead, even when a sibling section does.
export function sectionContainsTable(body: string): boolean {
  return MARKDOWN_TABLE_SEPARATOR_ROW.test(body)
}

// 1-based page number for a Markdown character offset, counting preceding
// page-break sentinels — the same technique the historical
// `char_index_to_page` used for its identical `_PAGE_BREAK` constant.
export function pageForOffset(markdown: string, offset: number): number {
  if (offset <= 0) return 1
  const head = markdown.slice(0, offset)
  let count = 0
  let idx = head.indexOf(PAGE_BREAK)
  while (idx !== -1) {
    count++
    idx = head.indexOf(PAGE_BREAK, idx + PAGE_BREAK.length)
  }
  return count + 1
}

// A model scoped to one section's text has no way to know its absolute page
// in the full document, so its "page" evidence is section-relative — add
// each section's own starting page (minus 1) to every "page" leaf found,
// recursing through arbitrarily nested evidence.
export function offsetPageNumbers(node: unknown, offset: number): unknown {
  if (offset === 0) return node
  if (Array.isArray(node)) {
    return node.map((item) => offsetPageNumbers(item, offset))
  }
  if (isRecord(node)) {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(node)) {
      out[key] = key === 'page' && typeof value === 'number' ? value + offset : offsetPageNumbers(value, offset)
    }
    return out
  }
  return node
}

// True when every leaf in an extracted result is empty ("", null, [], or an
// object/array made up entirely of such) — used to drop sections that didn't
// actually describe a record instance (e.g. a document's introduction,
// rendered as its own level-1 heading but with nothing matching the schema).
export function isEmptyResult(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'string') return value.trim() === ''
  if (Array.isArray(value)) return value.every(isEmptyResult)
  if (isRecord(value)) return Object.values(value).every(isEmptyResult)
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
