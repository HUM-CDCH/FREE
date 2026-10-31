import type { DurablePage } from 'extraction/durable-types'
import type { ParsedDocument } from 'extraction/parsed-document'
import type { SchemaNode } from 'extraction/schema'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { originPages, partName, reviewedValue } from 'extraction/value-disagreement'
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

/** One scalar part of an object or list value (a nested field, a table cell, a list entry) at its full result path, with
 *  the model link located to exactly that path. `key` names it among the marks: its value's id and its path. */
export type ValuePart = { key: string; path: readonly (string | number)[]; name: string; value: unknown; link: EvidenceLink | null }

export const partKey = (valueId: string, path: readonly (string | number)[]) => `${valueId}#${JSON.stringify(path)}`
/** The value a mark key names, itself or through one of its parts (value ids are digests, never with `#`). */
export const markValueId = (key: string) => key.split('#', 1)[0]!
/** Whether the mark keyed `key` is the selection `selected`'s: the value itself, or one of its parts. The value's
 *  correction Evidence (`{id}#correction`) is the whole decision's, so it lights with the value and with any of its parts. */
export const ownsMark = (selected: string, key: string) => key === selected || key.startsWith(`${selected}#`) || key === `${markValueId(selected)}#correction`

/** The parts of an object or list value as shown (an edit or the chosen readings, else the model's), in schema order; a
 *  scalar value has none. A part keeps the model's link to its path only where the model read the same there. In an
 *  edited list an index can name another item, so an item keeps its links only where the list keeps its length and the
 *  item reads once in the model's and once in the edit, at the same index; no insert, drop or reorder of equal items. */
export function valueParts(value: RetainedValue): ValuePart[] {
  const parts: ValuePart[] = []
  // Two readings are the same whatever their keys' order; an unedited value's parts are the model's own.
  // shortcut: an edited list's moved, resized or repeated items and a row with one edited cell lose their links; upgrade
  // when an edit carries each item's model index.
  const json = (at: unknown) => JSON.stringify(at, (_, each) => each && typeof each === 'object' && !Array.isArray(each)
    ? Object.fromEntries(Object.entries(each).sort(([a], [b]) => a < b ? -1 : 1)) : each)
  const same = (a: unknown, b: unknown) => a === b || json(a) === json(b)
  const part = (path: (string | number)[], name: string[], at: unknown, read: unknown, kept: boolean) => parts.push({key: partKey(value.id, path), path,
    name: name.join(' › '), value: at, link: kept && same(at, read) ? value.links.find(link => JSON.stringify(link.resultPath) === JSON.stringify(path)) ?? null : null})
  const walk = (node: SchemaNode, at: unknown, read: unknown, path: (string | number)[], name: string[], kept: boolean) => {
    const field = (from: unknown, child: string) => from && typeof from === 'object' ? (from as Record<string, unknown>)[child] : null
    if (node.type === 'object') for (const child of node.children) walk(child, field(at, child.name), field(read, child.name), [...path, child.name], [...name, child.name], kept)
    else if (node.type === 'array') {
      const items = Array.isArray(at) ? at : [], reads = Array.isArray(read) ? read : [], unchanged = same(items, read)
      items.forEach((item, index) => {
        const model = reads[index], once = (list: unknown[]) => list.filter(each => same(each, item)).length === 1
        const keep = kept && (unchanged || items.length === reads.length && same(item, model) && once(items) && once(reads))
        if (!node.children) part([...path, index], [...name, `#${index + 1}`], item, model, keep)
        else for (const child of node.children) walk(child, field(item, child.name), field(model, child.name), [...path, index, child.name], [...name, `#${index + 1}`, child.name], keep)
      })
    }
    else part(path, name, at, read, kept)
  }
  if (value.node.type === 'object' || value.node.type === 'array') walk(value.node, reviewedValue(value), value.modelValue, [...value.path], [value.node.name], true)
  return parts
}

/** One colour per top-level field, in schema order and cycling, so neighbouring values' marks and rows tell apart; a part
 *  keeps its field's. Never the only signal: a mark's name and a row's label say the field. */
const FIELD_COLORS = ['#4e79a7', '#f28e2b', '#59a14f', '#e15759', '#76b7b2', '#b07aa1', '#c9a227', '#9c755f']
export const fieldColor = (fields: readonly string[], name: string) => {
  const index = fields.indexOf(name)
  return index < 0 ? undefined : FIELD_COLORS[index % FIELD_COLORS.length]
}
/** The Evidence tokens a field's colour overrides on its marks and rail rows; none keeps the one Evidence colour. */
export const evidenceColorVars = (color: string | undefined): Record<string, string> => color ? {'--color-ev': color,
  '--color-ev-soft': `color-mix(in srgb, ${color} 24%, white)`, '--color-ev-ghost': `color-mix(in srgb, ${color} 12%, white)`} : {}

/** Identity, producing types and model links come from the fixed saved page.
 * Display paths never identify a correction or transfer a decision. With `part`, the row's Evidence is that part's: its
 * own link (or none), page and chip; the decision stays the whole value's. */
export function durableRailRow(value: RetainedValue, document: ParsedDocument | null, part?: ValuePart): RailRow {
  const correction = value.correction?.decision
  const action = correction?.action
  const link = part ? part.link : value.links[0] ?? null
  const anchor = document?.evidence_index.anchors.find(each => each.anchor_id === link?.evidenceAnchorId)
  const page = anchor?.producer_observations[0]?.page_number ?? null
  const disagreement=value.disagreement?.map(entry=>({part:partName(value.node,entry.path),path:entry.path,alternatives:entry.alternatives.map(a=>({value:a.value,pages:originPages(a.segments)}))}))
  const kind = value.processing !== 'saved' ? value.processing === 'absent' ? 'missing' : 'not-reviewable'
    : action === 'APPROVED' ? 'approved' : action === 'EDITED' ? 'edited' : action === 'REJECTED' ? 'rejected' : 'to-check'
  const doubt = link ? evidenceCheck(link, action === 'PENDING' ? undefined : action) : null
  const origin = link ? linkOrigin(link) : null
  // A linked scalar keeps the shared row's own words ("p.{n} · Verifier-supported"), also while the run goes on.
  const source = disagreement ? 'Readings differ · not checked' : link ? !part && (value.node.type === 'array' || value.node.type === 'object') ? 'Evidence links parts of this value' : undefined
    : value.grounding === 'provisional' ? 'Evidence is still being checked' : 'No Evidence linked'
  return {
    key: value.id, resultPath: value.path, name: value.node.name,
    value: reviewedValue(value), extracted: value.modelValue,
    kind, link, decision: value.processing === 'saved' ? {
      resultPath: value.path, evidenceAnchorId: value.links[0]?.evidenceAnchorId ?? null, reviewedOccurrenceIds: [],
      action: action && action !== 'PENDING' ? action : 'APPROVED',
      reviewedValue: action === 'EDITED' ? correction.value : null,
    } : null,
    // A missing value has no Evidence to check, during the run or after it.
    chip: {text: disagreement ? 'readings differ' : value.processing === 'absent' ? 'missing' : value.grounding === 'provisional' && !link ? 'checking' : !link ? 'no evidence'
      : `${page === null ? 'linked' : `p.${page}`}${origin === 'rule' ? ' · rule' : ''}${doubt ? ' · doubtful' : ''}`,
      style: doubt ? 'doubtful' : origin === 'rule' ? 'rule' : link ? 'link' : 'neutral'},
    evidence: disagreement ? {label:'Readings differ',detail:'Choose one, edit or reject it.'} : !link ? {label: value.processing === 'absent' ? 'No value' : value.processing === 'saved' ? 'No Evidence linked' : 'Not read yet',
      detail: value.processing === 'saved' ? 'Check it against the source, then approve, edit or reject it.'
        : value.processing === 'absent' ? 'No value was extracted.' : 'It can be reviewed once the run saves it.'} : null,
    doubt, changed: false, disagreement, page,
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
