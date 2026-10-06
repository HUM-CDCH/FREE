import type { DurablePage } from 'extraction/durable-types'
import type { ParsedDocument } from 'extraction/parsed-document'
import { linkOrigin } from './linkOrigin'
import { evidenceCheck, type RailModel, type RailRecord, type RailRow } from './reviewVocabulary'

export type RetainedValue = DurablePage['values'][number]

/** What the run has planned: the Catalog records discovery found (by ordinal, with the page each starts on), those
 *  with a model call still unanswered, the record fields a record being read shows as placeholders, and the page the
 *  run started from (records are read nearest it first). */
export type RunProgress = {
  records: readonly { ordinal: number; page: number | null }[] | null
  reading: ReadonlySet<number>
  fields: readonly string[]
  startPage: number | null
}

/** Identity, producing types and model links come from the fixed saved page.
 * Display paths never identify a correction or transfer a decision. */
export function durableRailRow(value: RetainedValue, document: ParsedDocument | null): RailRow {
  const correction = value.correction?.decision
  const action = correction?.action
  const link = value.links[0] ?? null
  const anchor = document?.evidence_index.anchors.find(each => each.anchor_id === link?.evidenceAnchorId)
  const page = anchor?.producer_observations[0]?.page_number ?? null
  const kind = value.processing !== 'saved' ? value.processing === 'absent' ? 'missing' : 'not-reviewable'
    : action === 'APPROVED' ? 'approved' : action === 'EDITED' ? 'edited' : action === 'REJECTED' ? 'rejected' : 'to-check'
  const doubt = link ? evidenceCheck(link, action === 'PENDING' ? undefined : action) : null
  const origin = link ? linkOrigin(link) : null
  // A linked scalar keeps the shared row's own words ("p.{n} · Verifier-supported"), also while the run goes on.
  const source = link ? value.node.type === 'array' || value.node.type === 'object' ? 'Evidence links parts of this value' : undefined
    : value.grounding === 'provisional' ? 'Evidence is still being checked' : 'No Evidence linked'
  return {
    key: value.id, resultPath: value.path, name: value.node.name,
    value: action === 'EDITED' ? correction.value : value.modelValue, extracted: value.modelValue,
    kind, link, decision: value.processing === 'saved' ? {
      resultPath: value.path, evidenceAnchorId: link?.evidenceAnchorId ?? null, reviewedOccurrenceIds: [],
      action: action && action !== 'PENDING' ? action : 'APPROVED',
      reviewedValue: action === 'EDITED' ? correction.value : null,
    } : null,
    chip: {text: value.grounding === 'provisional' && !link ? 'checking' : !link ? 'no evidence' : `${page === null ? 'linked' : `p.${page}`}${origin === 'rule' ? ' · rule' : ''}${doubt ? ' · doubtful' : ''}`,
      style: doubt ? 'doubtful' : origin === 'rule' ? 'rule' : link ? 'link' : 'neutral'},
    evidence: !link ? {label: value.processing === 'absent' ? 'No value' : value.processing === 'saved' ? 'No Evidence linked' : 'Not read yet',
      detail: value.processing === 'saved' ? 'Check it against the source, then approve, edit or reject it.' : 'It can be reviewed once the run saves it.'} : null,
    doubt, changed: false, page,
    retained: {reviewable: value.processing === 'saved', source,
      attribution: value.historicalCorrection ? 'An earlier correction does not fit this value; it stays saved.' : undefined},
  }
}

/** A field of a record still being read: a placeholder, never a value. */
const placeholder = (ordinal: number, name: string): RailRow => ({
  key: `reading:${ordinal}:${name}`, resultPath: ['records', ordinal, name], name, value: null, extracted: null, kind: 'reading',
  link: null, decision: null, chip: null, evidence: null, doubt: null, changed: false, page: null,
})

export function durableRailModel(page: DurablePage, document: ParsedDocument | null, progress: RunProgress | null = null): RailModel {
  const planned = new Map(progress?.records?.map(record => [record.ordinal, record]) ?? [])
  const groups = new Map<string, RailRecord>()
  const documentRows: RailRow[] = []
  for (const value of page.values) {
    const row = durableRailRow(value, document)
    if (value.node.valueSource) { documentRows.push(row); continue }
    let record = groups.get(value.recordId)
    if (!record) {
      // A value's path names the record's ordinal among those discovery found; a carried record keeps its own.
      const ordinal = typeof value.path[1] === 'number' ? value.path[1] : planned.size + groups.size
      record = {key: value.recordId, retained: true, index: ordinal, label: `Record ${ordinal + 1}`,
        page: planned.get(ordinal)?.page ?? row.page, state: 'finished', rows: [], toCheck: 0}
      groups.set(value.recordId, record)
    }
    record.rows.push(row)
    if (row.kind === 'to-check') record.toCheck++
  }
  const read = new Set([...groups.values()].map(record => record.index))
  const waiting = [...planned.values()].filter(record => !read.has(record.ordinal)).map((record): RailRecord => {
    const reading = progress!.reading.has(record.ordinal)
    return {key: `planned:${record.ordinal}`, index: record.ordinal, label: `Record ${record.ordinal + 1}`, page: record.page,
      state: reading ? 'reading' : 'queued', toCheck: 0, rows: reading ? progress!.fields.map(name => placeholder(record.ordinal, name)) : []}
  })
  const start = progress?.startPage ?? null
  const distance = (record: RailRecord) => start === null || record.page === null ? 0 : Math.abs(record.page - start)
  const records = [...groups.values(), ...waiting].sort((a, b) => distance(a) - distance(b) || a.index - b.index)
  const rows = [...documentRows, ...[...groups.values()].flatMap(record => record.rows)]
  const count = (kind: RailRow['kind']) => rows.filter(row => row.kind === kind).length
  return {document: documentRows, records, counts: {
    toCheck: count('to-check'), approved: count('approved'), edited: count('edited'), rejected: count('rejected'),
    required: rows.filter(row => row.retained?.reviewable).length,
    doubtful: rows.filter(row => row.doubt).length, notReviewable: rows.filter(row => !row.retained?.reviewable).length,
  }}
}
