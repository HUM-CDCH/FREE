import type { SchemaNode } from 'extraction/schema'
import type { PartialRecord, PartialResult, ReviewDecisionAction, ReviewDecisionInput } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { describeClaimStatus, linkOrigin, type ClaimStatus } from './claimStates'
import { orderResultFields, resultPathKey } from './reviewDecisions'

/** A row's state (results review redesign §1): the researcher's decision on a linked value, why another value is not
 *  reviewable, or, while the run reads, the value's progress. */
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
  decision: ReviewDecisionInput | null
  chip: { text: string; style: ChipStyle } | null
  /** A not reviewable value's label and detail (§1). */
  evidence: { label: string; detail: string } | null
  doubt: string | null
  /** The run-time decision was not kept at settlement (§5.3). */
  changed: boolean
  page: number | null
}

export type RailRecord = {
  index: number
  label: string
  page: number | null
  state: PartialRecord['state']
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

/** A value as a row shows it: "No value" for a missing or contested one, a list as comma-separated text. */
export const shownValue = (value: unknown) =>
  value === null || value === undefined || value === '' ? 'No value' : Array.isArray(value) ? value.map(String).join(', ') : String(value)

export const isDecidable = (kind: RowKind) => kind === 'to-check' || kind === 'approved' || kind === 'edited' || kind === 'rejected'
export const isNotReviewable = (kind: RowKind) => kind === 'not-reviewable' || kind === 'missing' || kind === 'contested'

/** The rail's value filters (§2.3). */
export type ValueFilter = 'check' | 'doubt' | 'notrev' | 'all'

export const passesFilter = (row: RailRow, filter: ValueFilter) =>
  filter === 'all' || (filter === 'check' ? row.kind === 'to-check' : filter === 'doubt' ? row.doubt !== null : isNotReviewable(row.kind))

/** A doubtful link (`evidenceCheck`'s two reasons); checks describe the extracted value, so none after an edit or a
 *  rejection. */
export function evidenceCheck(link: { verbatim?: boolean; lexicalHits?: number }, action?: ReviewDecisionAction): string | null {
  if (action === 'EDITED' || action === 'REJECTED') return null
  if (link.verbatim === false) return 'Value not found in the linked passage'
  const others = (link.lexicalHits ?? 1) - 1
  if (link.verbatim && others > 0) return `Value also appears in ${others} other passage${others === 1 ? '' : 's'}`
  return null
}

/** What tied a recipe or unified Catalog value to its field, in the researcher's words; it describes the extracted
 *  value, so none after an edit or a rejection. */
export function groundingDetail(link: EvidenceLink, action?: ReviewDecisionAction): string | null {
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

const NOT_IN_DOCUMENT = { label: 'Not reviewable', detail: 'Its Evidence is not in this document.' }
const NO_ACCOUNTING = { label: 'No evidence', detail: 'This run kept no claim accounting, so whether its checks finished is not known.' }
/** Departure (plan Ruling 6): §1 has no detail for a finished record's unlinked value while the run still reads. */
const NOT_LINKED_YET = { label: 'No evidence', detail: 'No Evidence links this value. Its check is named when the run finishes.' }
const DOCUMENT = { label: 'Document', detail: 'Read once for the whole document; not verified.' }
const MISSING = { label: 'Missing', detail: 'No value was extracted.' }

const empty = (value: unknown) => value === null || value === undefined || value === ''
const quoted = (candidates: readonly unknown[]) => candidates.map((each) => `“${String(each)}”`).join(' · ')
const neutral = (text: string) => ({ text, style: 'neutral' as const })

/** Every leaf of a record (an empty object or list has none), schema-ordered, with its record-relative path. */
function leaves(value: unknown, path: Path, linked: ReadonlySet<string>, prefix: Path): Array<{ path: Path; value: unknown }> {
  const key = resultPathKey([...prefix, ...path])
  if (Array.isArray(value) && !linked.has(key)) return value.flatMap((item, index) => leaves(item, [...path, index], linked, prefix))
  if (value !== null && typeof value === 'object' && !Array.isArray(value))
    return Object.entries(value).flatMap(([name, item]) => leaves(item, [...path, name], linked, prefix))
  return [{ path, value }]
}

const rowName = (path: Path) => path.map((step) => typeof step === 'number' ? String(step + 1) : step).join(' › ')

type Inputs = {
  schemaNodes: readonly SchemaNode[]
  decisions: readonly ReviewDecisionInput[]
  isTouched: (resultPath: (string | number)[]) => boolean
  evidencePages?: ReadonlyMap<string, number>
  changed?: ReadonlySet<string>
}

function linkedRow(base: Omit<RailRow, 'kind' | 'decision' | 'chip' | 'evidence' | 'doubt' | 'page' | 'value'>, link: EvidenceLink,
  decision: ReviewDecisionInput | undefined, inputs: Inputs): RailRow {
  const page = inputs.evidencePages?.get(link.evidenceAnchorId) ?? null
  if (!decision || decision.evidenceAnchorId === null)
    return { ...base, value: base.extracted, kind: 'not-reviewable', decision: null, chip: neutral('no evidence'), evidence: NOT_IN_DOCUMENT, doubt: null, page }
  const touched = inputs.isTouched(decision.resultPath)
  const action = touched ? decision.action : undefined
  const kind: RowKind = !touched ? 'to-check' : decision.action === 'APPROVED' ? 'approved' : decision.action === 'EDITED' ? 'edited' : 'rejected'
  const doubt = evidenceCheck(link, action)
  const where = page === null ? 'linked' : `p.${page}`
  return {
    ...base, kind, decision, page, doubt, evidence: null,
    value: kind === 'edited' ? decision.reviewedValue : base.extracted,
    chip: doubt ? { text: `${where} · doubtful`, style: 'doubtful' }
      : linkOrigin(link) === 'rule' ? { text: `${where} · rule`, style: 'rule' } : { text: where, style: 'link' },
  }
}

/** One record's rows, settled: each leaf in its §1 state from its link, its decision and its claim status. */
function settledRows(record: unknown, index: number | null, context: Inputs & {
  links: ReadonlyMap<string, EvidenceLink>; decisionMap: ReadonlyMap<string, ReviewDecisionInput>
  statuses: ReadonlyMap<string, ClaimStatus> | null; contested: ReadonlyMap<string, readonly unknown[]>
  documentFields: ReadonlySet<string>
}): RailRow[] {
  const prefix: Path = index === null ? [] : ['records', index]
  const ordered = orderResultFields(record, context.schemaNodes)
  return leaves(ordered, [], new Set([...context.links.keys(), ...context.decisionMap.keys()]), prefix).map(({ path, value }) => {
    const resultPath = [...prefix, ...path]
    const key = resultPathKey(resultPath)
    const base = { key, resultPath, name: rowName(path), extracted: value, link: null, changed: (context.changed?.has(key) ?? false) && !context.isTouched(resultPath) }
    const link = context.links.get(key)
    const decision = context.decisionMap.get(key)
    if (link) return { ...linkedRow({ ...base, link }, link, decision, context) }
    const rest = { ...base, value, decision: null, doubt: null, page: null }
    const candidates = context.contested.get(key)
    if (candidates && empty(value) && decision?.action !== 'REJECTED')
      return { ...rest, value: null, kind: 'contested', chip: neutral('contested'), evidence: { label: 'Contested', detail: `Sources disagreed: ${quoted(candidates)}.` } }
    if (empty(value)) return { ...rest, value: null, kind: 'missing', chip: neutral('missing'), evidence: MISSING }
    if (typeof path[0] === 'string' && context.documentFields.has(path[0]))
      return { ...rest, kind: 'not-reviewable', chip: neutral('document'), evidence: DOCUMENT }
    const status = context.statuses?.get(key)
    if (status && status.state !== 'supported') {
      const chip = status.state === 'not_completed' ? 'not completed' : status.state
      return { ...rest, kind: 'not-reviewable', chip: neutral(chip), evidence: describeClaimStatus(status) }
    }
    return { ...rest, kind: 'not-reviewable', chip: neutral('no evidence'), evidence: NO_ACCOUNTING }
  })
}

/** One record's rows while the run reads (§5.1, §5.2; Part B ledger Rulings 8, 10, 11). */
function partialRows(record: PartialRecord, context: Inputs & { decisionMap: ReadonlyMap<string, ReviewDecisionInput> }): RailRow[] {
  const prefix: Path = ['records', record.index]
  if (record.record === null) {
    // Placeholders from the pinned schema's record-level fields: a name, never a value.
    const kind: RowKind = record.state === 'reading' ? 'reading' : 'queued'
    return context.schemaNodes.filter((node) => !node.valueSource).map((node) => {
      const resultPath = [...prefix, node.name]
      return { key: resultPathKey(resultPath), resultPath, name: node.name, value: null, extracted: null, kind, link: null,
        decision: null, chip: null, evidence: null, doubt: null, changed: false, page: null }
    })
  }
  const links = new Map(record.evidenceLinks.map((link) => [resultPathKey(link.resultPath), link]))
  const finished = record.state === 'finished'
  const ordered = orderResultFields(record.record, context.schemaNodes)
  return leaves(ordered, [], new Set(links.keys()), prefix).map(({ path, value }) => {
    const resultPath = [...prefix, ...path]
    const key = resultPathKey(resultPath)
    const leaf = record.values[JSON.stringify(path.map(String))]
    const base = { key, resultPath, name: rowName(path), extracted: value, link: null, changed: false }
    const rest = { ...base, value, decision: null, doubt: null, page: null, chip: null, evidence: null }
    const link = links.get(key)
    if (!finished) return { ...rest, kind: empty(value) ? 'reading' : 'checking' }
    if (leaf?.state === 'grounded' && link) return linkedRow({ ...base, link }, link, context.decisionMap.get(key), context)
    if (leaf?.state === 'contested')
      return { ...rest, value: null, kind: 'contested', chip: neutral('contested'), evidence: { label: 'Contested', detail: `Sources disagreed: ${quoted(leaf.candidates ?? [])}.` } }
    if (leaf?.state === 'empty') return { ...rest, value: null, kind: 'missing', chip: neutral('missing'), evidence: MISSING }
    if (leaf?.state === 'reading' || !leaf) return { ...rest, kind: 'reading' }
    return { ...rest, kind: 'not-reviewable', chip: neutral('no evidence'), evidence: NOT_LINKED_YET }
  })
}

function firstString(rows: readonly RailRow[]): string | null {
  const row = rows.find((each) => typeof each.extracted === 'string' && each.extracted.trim() !== '')
  return row ? String(row.extracted) : null
}

function count(rows: readonly RailRow[], records: readonly RailRecord[]): RailCounts {
  const readable = [...rows, ...records.filter((record) => record.state === 'finished').flatMap((record) => record.rows)]
  const of = (kind: RowKind) => readable.filter((row) => row.kind === kind).length
  return {
    toCheck: of('to-check'), approved: of('approved'), edited: of('edited'), rejected: of('rejected'),
    doubtful: readable.filter((row) => row.doubt !== null).length,
    notReviewable: readable.filter((row) => isNotReviewable(row.kind)).length,
    required: readable.filter((row) => isDecidable(row.kind)).length,
  }
}

/** Document-level fields render once, above the records (§3.1): taken from the first record that has them. */
function splitDocument(records: RailRecord[], documentFields: ReadonlySet<string>) {
  const isDocument = (row: RailRow) => typeof row.resultPath[2] === 'string' && documentFields.has(row.resultPath[2])
  const source = records.find((record) => record.rows.some(isDocument))
  const document = source ? source.rows.filter(isDocument) : []
  for (const record of records) record.rows = record.rows.filter((row) => !isDocument(row))
  return document
}

function finish(records: RailRecord[], documentFields: ReadonlySet<string>): RailModel {
  const document = splitDocument(records, documentFields)
  for (const record of records) record.toCheck = record.rows.filter((row) => row.kind === 'to-check').length
  return { document, records, counts: count(document, records) }
}

/** The rail while the run reads: the partial's records in its order (the client never re-sorts). */
export function partialRailModel(partial: PartialResult, inputs: Inputs): RailModel {
  const decisionMap = new Map(inputs.decisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
  const documentFields = new Set(inputs.schemaNodes.filter((node) => node.valueSource === 'document').map((node) => node.name))
  const records = partial.records.map((record): RailRecord => {
    const rows = partialRows(record, { ...inputs, decisionMap })
    const firstLink = record.evidenceLinks[0]
    return {
      index: record.index, state: record.state, rows, toCheck: 0,
      label: record.label ?? firstString(rows) ?? `Record ${record.index + 1}`,
      page: record.page ?? (firstLink ? inputs.evidencePages?.get(firstLink.evidenceAnchorId) ?? null : null),
    }
  })
  return finish(records, documentFields)
}

/** The rail for a settled result: its records in the order kept from the run while open (else source order), named by
 *  kei's labels kept from the run, else their first string value. */
export function settledRailModel(result: unknown, inputs: Inputs & {
  links: readonly EvidenceLink[]
  statuses: ReadonlyMap<string, ClaimStatus> | null
  contested: readonly { resultPath: readonly (string | number)[]; candidates: readonly unknown[] }[]
  order?: readonly number[]
  labels?: ReadonlyMap<number, string>
}): RailModel {
  const context = {
    ...inputs,
    links: new Map(inputs.links.map((link) => [resultPathKey(link.resultPath), link])),
    decisionMap: new Map(inputs.decisions.map((decision) => [resultPathKey(decision.resultPath), decision])),
    contested: new Map(inputs.contested.map(({ resultPath, candidates }) => [resultPathKey(resultPath), candidates])),
    documentFields: new Set(inputs.schemaNodes.filter((node) => node.valueSource === 'document').map((node) => node.name)),
  }
  const list = result !== null && typeof result === 'object' && Array.isArray((result as { records?: unknown }).records)
    ? (result as { records: unknown[] }).records : [result]
  const indexes = list.map((_, index) => index)
  const kept = (inputs.order ?? []).filter((index) => index < list.length)
  const ordered = [...kept, ...indexes.filter((index) => !kept.includes(index))]
  const records = ordered.map((index): RailRecord => {
    const rows = settledRows(list[index], index, context)
    const firstLink = rows.find((row) => row.link)?.link
    return {
      index, state: 'finished', rows, toCheck: 0,
      label: inputs.labels?.get(index) ?? firstString(rows) ?? `Record ${index + 1}`,
      page: firstLink ? inputs.evidencePages?.get(firstLink.evidenceAnchorId) ?? null : null,
    }
  })
  return finish(records, context.documentFields)
}
