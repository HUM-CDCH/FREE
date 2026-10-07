import type { EvidenceLink } from '../shared/groundedExtraction'

/** A researcher's decision on a value, as the rail shows it. */
export type ReviewAction = 'APPROVED' | 'EDITED' | 'REJECTED'
/** The saved durable correction a row carries, in the rail's shape (durableRailModel). */
export type RowDecision = Readonly<{
  resultPath: readonly (string | number)[]
  evidenceAnchorId: string | null
  reviewedOccurrenceIds: readonly string[]
  action: ReviewAction
  reviewedValue: unknown
  /** The correction's own Evidence: the passages selected from its source. */
  reviewedEvidence?: readonly Readonly<{ evidenceAnchorId: string; reviewedOccurrenceIds: readonly string[] }>[] | null
}>

/** A row's state (results review redesign §1): the researcher's decision on a saved value, or why another value is
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
  /** The decision a To check, approved, edited or rejected row carries. */
  decision: RowDecision | null
  chip: { text: string; style: ChipStyle } | null
  /** A not reviewable value's label and detail (§1). */
  evidence: { label: string; detail: string } | null
  doubt: string | null
  /** The run-time decision was not kept at settlement (§5.3). */
  changed: boolean
  page: number | null
  /** Retained values can be reviewed without a model Evidence link; `source` replaces a linked row's own words. */
  retained?: { reviewable: boolean; source?: string; attribution?: string }
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

export const DECISION_WORD = { APPROVED: 'Approved', EDITED: 'Edited', REJECTED: 'Rejected' } as const

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
    default: return row.evidence?.label ?? 'Not reviewable'
  }
}

/** Preserve the shape of typed composite values while showing absent values clearly. */
export const shownValue = (value: unknown) =>
  value === null || value === undefined || value === '' ? 'No value'
    : typeof value === 'object' ? JSON.stringify(value) : String(value)

export const isDecidable = (kind: RowKind) => kind === 'to-check' || kind === 'approved' || kind === 'edited' || kind === 'rejected'
export const isNotReviewable = (kind: RowKind) => kind === 'not-reviewable' || kind === 'missing' || kind === 'contested'

/** The rail's value filters (§2.3). */
export type ValueFilter = 'check' | 'doubt' | 'notrev' | 'all'

export const passesFilter = (row: RailRow, filter: ValueFilter) =>
  filter === 'all' || (filter === 'check' ? row.kind === 'to-check' : filter === 'doubt' ? row.doubt !== null : isNotReviewable(row.kind))

/** A doubtful link (`evidenceCheck`'s two reasons); checks describe the extracted value, so none after an edit or a
 *  rejection. */
export function evidenceCheck(link: { verbatim?: boolean; lexicalHits?: number }, action?: ReviewAction): string | null {
  if (action === 'EDITED' || action === 'REJECTED') return null
  if (link.verbatim === false) return 'Value not found in the linked passage'
  const others = (link.lexicalHits ?? 1) - 1
  if (link.verbatim && others > 0) return `Value also appears in ${others} other passage${others === 1 ? '' : 's'}`
  return null
}

/** What tied a recipe or unified Catalog value to its field, in the researcher's words; it describes the extracted
 *  value, so none after an edit or a rejection. */
export function groundingDetail(link: EvidenceLink, action?: ReviewAction): string | null {
  const grounding = link.grounding
  if (!grounding || action === 'EDITED' || action === 'REJECTED') return null
  const parts = [grounding.linkedBy === 'verification'
    ? (grounding.support === 'literal' ? 'Verifier-supported; the value is printed in the entry' : 'Verifier-supported from a supporting passage; the value is not printed as such')
    : grounding.linkedBy === 'key' ? 'Read after its printed key'
      : grounding.provenance === 'inherited' ? 'Inherited from the heading in force'
        : 'Entry number from the segmentation']
  const others = grounding.alternatives.length
  if (others > 0) parts.push(`${others} other match${others === 1 ? '' : 'es'} in the entry`)
  if (grounding.linkedBy !== 'verification' && grounding.normalized) parts.push(`glossary: ${grounding.normalized.value}`)
  return parts.join(' · ')
}
