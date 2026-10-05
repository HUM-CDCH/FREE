import type { DurablePage } from 'extraction/durable-types'
import type { ParsedDocument } from 'extraction/parsed-document'
import { linkOrigin } from './linkOrigin'
import { evidenceCheck, type RailModel, type RailRow } from './reviewVocabulary'

export type RetainedValue = DurablePage['values'][number]

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
  const source = value.grounding === 'provisional' ? 'Model Evidence checking is incomplete'
    : !link ? 'No model Evidence linked · manual review is available'
    : value.node.type === 'array' || value.node.type === 'object' ? 'Model Evidence links constituent values; the whole value is not verified'
    : origin === 'rule' ? 'Linked by rule; no verifier checked it' : 'Verifier-supported'
  return {
    key: value.id, resultPath: value.path, name: value.node.name,
    value: action === 'EDITED' ? correction.value : value.modelValue, extracted: value.modelValue,
    kind, link, decision: value.processing === 'saved' ? {
      resultPath: value.path, evidenceAnchorId: link?.evidenceAnchorId ?? null, reviewedOccurrenceIds: [],
      action: action && action !== 'PENDING' ? action : 'APPROVED',
      reviewedValue: action === 'EDITED' ? correction.value : null,
    } : null,
    chip: {text: value.grounding === 'provisional' ? 'provisional' : !link ? 'no model evidence' : `${page === null ? 'linked' : `p.${page}`}${origin === 'rule' ? ' · rule' : ''}${doubt ? ' · doubtful' : ''}`,
      style: doubt ? 'doubtful' : origin === 'rule' ? 'rule' : link ? 'link' : 'neutral'},
    evidence: !link ? {label: value.processing === 'absent' ? 'No value' : value.processing === 'saved' ? 'No model Evidence linked' : 'Not yet saved',
      detail: value.processing === 'saved' ? 'You can approve, correct or reject this typed value. Evidence for a correction is optional.' : 'Manual decisions become available when a structurally valid value is saved.'} : null,
    doubt, changed: false, page,
    retained: {reviewable: value.processing === 'saved', source,
      attribution: `Producing schema ${value.schemaRevisionId.slice(0,8)} · ${value.node.type} · input selection ${value.selectionId.slice(0,8)}${value.historicalCorrection ? ' · an incompatible historical correction remains saved' : ''}`},
  }
}

export function durableRailModel(page: DurablePage, document: ParsedDocument | null): RailModel {
  const groups = new Map<string, RailModel['records'][number]>()
  const documentRows: RailRow[] = []
  for (const value of page.values) {
    const row = durableRailRow(value, document)
    if (value.node.valueSource) { documentRows.push(row); continue }
    let record = groups.get(value.recordId)
    if (!record) {
      record = {key: value.recordId,retained:true, index: groups.size, label: `Record ${groups.size+1}`, page: row.page,
        state: 'finished', rows: [], toCheck: 0}
      groups.set(value.recordId, record)
    }
    record.rows.push(row)
    if (row.kind === 'to-check') record.toCheck++
  }
  const rows = [...documentRows, ...[...groups.values()].flatMap(record => record.rows)]
  const count = (kind: RailRow['kind']) => rows.filter(row => row.kind === kind).length
  return {document: documentRows, records: [...groups.values()], counts: {
    toCheck: count('to-check'), approved: count('approved'), edited: count('edited'), rejected: count('rejected'),
    required: rows.filter(row => row.retained?.reviewable).length,
    doubtful: rows.filter(row => row.doubt).length, notReviewable: rows.filter(row => !row.retained?.reviewable).length,
  }}
}
