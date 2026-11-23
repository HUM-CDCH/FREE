import type { EvidenceLink } from 'extraction/durable-types'
import type { SchemaNode } from 'extraction/schema'

/** A researcher's decision on a value, as the rail shows it. */
export type ReviewAction = 'APPROVED' | 'EDITED' | 'REJECTED'
/** A row's state: the researcher's decision on a saved value, or why another value is
 *  not reviewable. */
export type RowKind =
  | 'to-check' | 'approved' | 'edited' | 'rejected'
  | 'not-reviewable' | 'missing' | 'contested'
  | 'reading' | 'checking' | 'queued'
export type ChipStyle = 'link' | 'rule' | 'doubtful' | 'neutral'
type Path = (string | number)[]

export type RailRow = {
  key: string
  resultPath: Path
  /** The record-relative path joined by " › ", indexes 1-based. */
  name: string
  /** The value shown: the reviewed value when edited, else the extracted one (a candidate while checking). */
  value: unknown
  extracted: unknown
  kind: RowKind
  link: EvidenceLink | null
  chip: { text: string; style: ChipStyle } | null
  /** A not reviewable value's label and detail. */
  evidence: { label: string; detail: string } | null
  doubt: string | null
  /** The run-time decision was not kept at settlement. */
  changed: boolean
  /** A Value Disagreement's readings at each place, none of them chosen by FREE. */
  disagreement?: {part: string; path: string[]; alternatives: {value: unknown; pages: string | null}[]}[]
  page: number | null
  /** Retained values can be reviewed without a model Evidence link. */
  retained?: { reviewable: boolean; attribution?: string }
}

export type RailRecord = {
  key?: string
  retained?: true
  index: number
  label: string
  page: number | null
  state: 'queued' | 'reading' | 'checking' | 'finished'
  rows: RailRow[]
  toCheck: number
}

export type RailCounts = {
  toCheck: number; doubtful: number; notReviewable: number; required: number
  approved: number; edited: number; rejected: number
}

export type RailModel = { document: RailRow[]; records: RailRecord[]; counts: RailCounts }

/** The text equivalent of a row's glyph. */
export function stateLabel(row: Pick<RailRow, 'kind' | 'evidence'>): string {
  switch (row.kind) {
    case 'to-check': return 'To check'
    case 'approved': return 'Approved'
    case 'edited': return 'Edited'
    case 'rejected': return 'Rejected'
    case 'reading': return 'Reading'
    case 'checking': return 'Checking'
    case 'queued': return 'Queued'
    default: return row.evidence?.label ?? 'Can\'t be checked'
  }
}

/** A field's name as the researcher reads it in Results and on a mark: `site_name` and `siteName` as "site name" (its
 *  element capitalises the first letter). The Template keeps the name as written. */
export const fieldWords = (name: string) =>
  name.replace(/_+/g, ' ').replace(/([a-z\d])([A-Z])(?=[a-z])/g, (_, before: string, capital: string) => `${before} ${capital.toLowerCase()}`).trim()

/** Preserve the shape of typed composite values while showing absent values clearly. */
export const shownValue = (value: unknown) =>
  value === null || value === undefined || value === '' ? 'No value'
    : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** A compact label for a composite value, with the full value in its expansion. */
export function reviewedValueSummary(node: SchemaNode | null, value: unknown): string {
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? 'item' : 'items'}`
  if (node?.type === 'object' && value && typeof value === 'object') {
    const fields = value as Record<string, unknown>
    return node.children.map(child => `${child.name}: ${reviewedValueSummary(child, fields[child.name])}`).join(' · ')
  }
  return shownValue(value)
}

export function rowText(row: Pick<RailRow, 'value' | 'disagreement'>): string {
  const root = row.disagreement?.find(entry => entry.part === '')
  return root && (row.value === null || row.value === undefined)
    ? root.alternatives.map(alternative => shownValue(alternative.value)).join(' or ') : shownValue(row.value)
}

export const isDecidable = (kind: RowKind) => kind === 'to-check' || kind === 'approved' || kind === 'edited' || kind === 'rejected'
export const isNotReviewable = (kind: RowKind) => kind === 'not-reviewable' || kind === 'missing' || kind === 'contested'

/** The rail's value filters. */
export type ValueFilter = 'check' | 'doubt' | 'notrev' | 'all'

export const passesFilter = (row: RailRow, filter: ValueFilter) =>
  filter === 'all' || (filter === 'check' ? row.kind === 'to-check' : filter === 'doubt' ? row.doubt !== null : isNotReviewable(row.kind))

/** An uncertain passage: the extracted value is not printed word for word in its linked Evidence.
 *  This describes the extracted value, so none after an edit or a rejection. The code keeps the older
 *  name (`doubt`, `doubtful`); the researcher reads "Not an exact match, please double check". */
export function evidenceCheck(link: Pick<EvidenceLink, 'verbatim' | 'grounding' | 'location'>,
  action?: ReviewAction, value?: unknown, sourceText?: string): string | null {
  if (action === 'EDITED' || action === 'REJECTED') return null
  const text = link.location?.raw ?? link.grounding?.raw ?? sourceText ?? ''
  if (typeof value === 'boolean' && link.verbatim === false) {
    // Match Catalog's normalized source words, including PDF hyphenation and combining marks.
    const printed = text.replaceAll('\u00ad', '').normalize('NFKC')
      .replace(/-[^\S\n]*\n\s*(?=\p{Ll})/gu, '')
    const words = printed.match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
    if (words.some(word => (value ? /^true$/iu : /^false$/iu).test(word))) return null
  }
  if (link.verbatim === false) return 'Not an exact match, please double check'
  return null
}

