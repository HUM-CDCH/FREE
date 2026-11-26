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
/** What a value's support check says: the source text was judged not to support it, its verdicts disagree, the check
 *  failed (the checker unavailable), no verdict could be reached (no source text, too long an input), or it was judged
 *  supported. Only the first two move a value up the review order; a check that gave no verdict is no verdict against
 *  the value, and a supported value is checked like any other. */
export type ReviewPriority = 'unsupported' | 'uncertain' | 'failed' | 'to-verify' | 'supported'
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
  /** Why the extracted value asks to be checked first, in one line; the decision does not change it. */
  reason?: string | null
  /** The extracted value's support check, when the backend attempted one. */
  priority?: ReviewPriority | null
  /** This review has shown the value's reason to be noise, so it no longer comes first; the reason is still its own. */
  settled?: boolean
  /** Where the value is, said on its row when it is shown away from its record: among the values checked first. */
  place?: string
  /** Populated original scalars in document order; they share this row's saved value identity. */
  parts?: readonly RailRow[]
  /** The run-time decision was not kept at settlement. */
  changed: boolean
  /** A Value Disagreement's readings at each place, none of them chosen by FREE. */
  disagreement?: {part: string; path: string[]; alternatives: {value: unknown; pages: string | null}[]}[]
  page: number | null
  /** Retained values can be reviewed without a model Evidence link. */
  retained?: { reviewable: boolean; attribution?: string
    /** A value the model found nothing for: the researcher may fill it in (an edit), and undo that, but not decide it. */
    fillable?: boolean }
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

const filled = (value: unknown) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0)

/** One item of a list of objects: its filled values in its fields' order, e.g. "Anna Jensen · 1852". */
function itemText(children: readonly SchemaNode[] | undefined, item: Record<string, unknown>): string {
  const values = children ? children.map(child => item[child.name]) : Object.values(item)
  return values.filter(filled).map(value => Array.isArray(value) ? value.map(shownValue).join(', ') : shownValue(value)).join(' · ')
}

/** A composite value in one line, its contents first: a list's items ("Anna, Peter"; an object item its filled values),
 *  an object's fields with their values. The full value is in its expansion. */
export function reviewedValueSummary(node: SchemaNode | null, value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return shownValue(null)
    const objects = value.some(each => each !== null && typeof each === 'object' && !Array.isArray(each))
    return value.map(each => each !== null && typeof each === 'object' && !Array.isArray(each)
      ? itemText(node?.children, each as Record<string, unknown>) || shownValue(null) : shownValue(each)).join(objects ? '; ' : ', ')
  }
  if (node?.type === 'object' && value && typeof value === 'object') {
    const fields = value as Record<string, unknown>
    return node.children.filter(child => filled(fields[child.name]))
      .map(child => `${fieldWords(child.name)}: ${reviewedValueSummary(child, fields[child.name])}`).join(' · ') || shownValue(null)
  }
  return shownValue(value)
}

/** How many items a list holds, said beside its field's name; null for any other value. */
export const itemCount = (value: unknown) =>
  Array.isArray(value) && value.length > 0 ? `${value.length} ${value.length === 1 ? 'item' : 'items'}` : null

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
  filter === 'all' || (filter === 'check' ? row.kind === 'to-check' : filter === 'doubt' ? row.doubt !== null || Boolean(row.parts?.some(part => part.doubt)) : isNotReviewable(row.kind))

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

/** What the researcher reads of a support check in the open value's detail. It describes the extracted value, so none
 *  after an edit or a rejection; and none for a supported value, which is no approval. A check that gave no verdict is
 *  said here only: it moves nothing and marks no row, where "checked" is the researcher's own review. */
export function supportNote(row: Pick<RailRow, 'priority' | 'kind'>): { text: string } | null {
  if (row.kind === 'edited' || row.kind === 'rejected') return null
  if (row.priority === 'unsupported') return { text: 'An automatic check doubts the source text supports this value. Such a check is often wrong: please read the source' }
  if (row.priority === 'uncertain') return { text: 'The automatic checks disagree on whether the source text supports this value' }
  if (row.priority === 'failed') return { text: 'Its automatic support check was unavailable; that says nothing about the value' }
  if (row.priority === 'to-verify') return { text: 'Its support could not be checked automatically' }
  return null
}

