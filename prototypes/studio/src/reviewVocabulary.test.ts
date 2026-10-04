import { describe, expect, it } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import type { PartialRecord, ReviewDecisionInput } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { ClaimStatus } from './claimStates'
import { resultPathKey } from './reviewDecisions'
import { evidenceCheck, partialRailModel, settledRailModel, stateLabel } from './reviewVocabulary'

const schemaNodes: SchemaNode[] = [
  { id: 'category', name: 'category', type: 'string' },
  { id: 'sheet', name: 'sheet', type: 'string' },
  { id: 'skeleton', name: 'skeleton', type: 'object', children: [{ id: 'sex', name: 'sex', type: 'string' }, { id: 'age', name: 'age', type: 'string' }] },
  { id: 'site', name: 'site', type: 'string' },
  { id: 'condition', name: 'condition', type: 'string' },
  { id: 'certainty', name: 'certainty', type: 'string' },
  { id: 'archive', name: 'archive', type: 'string', valueSource: 'document' },
] as SchemaNode[]
const link = (field: (string | number)[], extra: Partial<EvidenceLink> = {}): EvidenceLink =>
  ({ resultPath: ['records', 0, ...field], evidenceAnchorId: `a-${field.join('.')}`, ...extra })
const decision = (field: (string | number)[], action: ReviewDecisionInput['action'] = 'APPROVED', reviewedValue: ReviewDecisionInput['reviewedValue'] = null): ReviewDecisionInput =>
  ({ resultPath: ['records', 0, ...field], evidenceAnchorId: `a-${field.join('.')}`, reviewedOccurrenceIds: ['o'], action, reviewedValue })

const record = { category: 'Grav 8', sheet: '67', skeleton: { sex: 'mand', age: 'over 45 år' }, site: 'Ellekilde', condition: null, certainty: 'reported', archive: 'NM', empty: [] }
const links = [link(['category']), link(['sheet'], { linkedBy: 'lexical' }), link(['skeleton', 'sex'], { verbatim: true, lexicalHits: 2 }), link(['skeleton', 'age'])]
const statuses = new Map<string, ClaimStatus>([
  [resultPathKey(['records', 0, 'site']), { state: 'excluded', reasons: [], policy: 'unverified' }],
  [resultPathKey(['records', 0, 'certainty']), { state: 'not_completed', reasons: ['verification_failed'] }],
])

describe('the rail model of a settled result (results review redesign §1, §3)', () => {
  const touched = new Set([resultPathKey(['records', 0, 'skeleton', 'age'])])
  const model = settledRailModel({ records: [record] }, {
    schemaNodes, links, statuses, evidencePages: new Map([['a-category', 1], ['a-sheet', 1], ['a-skeleton.sex', 2]]),
    contested: [{ resultPath: ['records', 0, 'condition'], candidates: ['Meget fragmenteret', 'bevaret'] }],
    decisions: [decision(['category']), decision(['sheet']), decision(['skeleton', 'sex']), decision(['skeleton', 'age'], 'EDITED', 'over 50 år')],
    isTouched: (path) => touched.has(resultPathKey(path)),
  })
  const rows = Object.fromEntries(model.records[0]!.rows.map((row) => [row.name, row]))

  it('names leaves by their path, 1-based, in schema order; an empty list has no row; document fields render once apart', () => {
    expect(model.records[0]!.rows.map((row) => row.name)).toEqual(['category', 'sheet', 'skeleton › sex', 'skeleton › age', 'site', 'condition', 'certainty'])
    expect(model.document.map((row) => [row.name, row.chip?.text, row.evidence?.detail])).toEqual([['archive', 'document', 'Read once for the whole document; not verified.']])
  })

  it('gives a linked value its decision, its chip and its doubt', () => {
    expect([rows.category!.kind, rows.category!.chip]).toEqual(['to-check', { text: 'p.1', style: 'link' }])
    expect(rows.sheet!.chip).toEqual({ text: 'p.1 · rule', style: 'rule' })
    expect([rows['skeleton › sex']!.chip, rows['skeleton › sex']!.doubt]).toEqual([{ text: 'p.2 · doubtful', style: 'doubtful' }, 'Value also appears in 1 other passage'])
    expect([rows['skeleton › age']!.kind, rows['skeleton › age']!.value, rows['skeleton › age']!.extracted]).toEqual(['edited', 'over 50 år', 'over 45 år'])
    expect(rows['skeleton › age']!.chip?.text).toBe('linked')
  })

  it('says why every other value is not reviewable, with the words of claimStates', () => {
    expect([rows.site!.kind, rows.site!.chip?.text, rows.site!.evidence]).toEqual(['not-reviewable', 'excluded',
      { label: 'Excluded by policy', detail: 'The schema policy “unverified” asked for no verification.' }])
    expect([rows.certainty!.chip?.text, rows.certainty!.evidence?.label]).toEqual(['not completed', 'Not completed'])
    expect([rows.condition!.kind, rows.condition!.evidence?.detail]).toEqual(['contested', 'Sources disagreed: “Meget fragmenteret” · “bevaret”.'])
    expect(stateLabel(rows.condition!)).toBe('Contested')
  })

  it('counts over readable records', () => {
    expect(model.counts).toEqual({ toCheck: 3, approved: 0, edited: 1, rejected: 0, doubtful: 1, notReviewable: 4, required: 4 })
    expect(model.records[0]!.toCheck).toBe(3)
    expect(model.records[0]!.label).toBe('Grav 8')
  })

  it('a missing value, a linked value whose anchor the document lacks, and no claim accounting', () => {
    const bare = settledRailModel({ records: [{ category: 'Grav 8', sheet: '', site: 'Ellekilde' }] }, {
      schemaNodes, links: [link(['category'])], statuses: null, contested: [], decisions: [], isTouched: () => false,
    })
    expect(bare.records[0]!.rows.map((row) => [row.kind, row.evidence?.detail])).toEqual([
      ['not-reviewable', 'Its Evidence is not in this document.'],
      ['missing', 'No value was extracted.'],
      ['not-reviewable', 'This run kept no claim accounting, so whether its checks finished is not known.'],
    ])
  })

  it('keeps the order and the labels of the run while the workspace stays open', () => {
    const two = settledRailModel({ records: [{ category: 'A' }, { category: 'B' }] }, {
      schemaNodes, links: [], statuses: null, contested: [], decisions: [], isTouched: () => false, order: [1, 0], labels: new Map([[1, 'Grav 9']]),
    })
    expect(two.records.map((each) => [each.index, each.label])).toEqual([[1, 'Grav 9'], [0, 'A']])
  })
})

describe('the rail model while the run reads (§5.1, §5.2)', () => {
  const partialRecord = (index: number, state: PartialRecord['state'], overrides: Partial<PartialRecord> = {}): PartialRecord => ({
    index, label: `Grav ${index + 8}`, page: index + 1, state, record: null, values: {}, evidenceLinks: [], ...overrides,
  })
  const finished = partialRecord(0, 'finished', {
    record: { category: 'Grav 8', sheet: '67', site: 'Ellekilde', condition: null },
    values: { '["category"]': { value: 'Grav 8', state: 'grounded' }, '["sheet"]': { value: '67', state: 'checking' },
      '["site"]': { value: null, state: 'empty' }, '["condition"]': { value: null, state: 'contested', candidates: ['a', 'b'] } },
    evidenceLinks: [link(['category'])],
  })
  const model = partialRailModel({ strategy: 'CATALOG', startedAtPage: 1, discovered: 3, finished: 1, document: null, records: [
    finished,
    partialRecord(1, 'checking', { record: { category: 'Grav 9', sheet: null }, values: { '["category"]': { value: 'Grav 9', state: 'checking' } } }),
    partialRecord(2, 'reading'),
    partialRecord(3, 'queued'),
  ] }, { schemaNodes, decisions: [decision(['category'])], isTouched: () => false })

  it('a finished record is reviewable; its unlinked value is No evidence, never a candidate', () => {
    expect(model.records[0]!.rows.map((row) => [row.name, row.kind])).toEqual([['category', 'to-check'], ['sheet', 'not-reviewable'], ['site', 'missing'], ['condition', 'contested']])
    expect(model.records[0]!.rows[1]!.evidence?.label).toBe('No evidence')
  })

  it('a record still checked shows candidates and reading values; a reading or queued record shows placeholders', () => {
    expect(model.records[1]!.rows.map((row) => row.kind)).toEqual(['checking', 'reading'])
    expect(model.records[2]!.rows.map((row) => [row.name, row.kind, row.value])).toEqual([['category', 'reading', null], ['sheet', 'reading', null],
      ['skeleton', 'reading', null], ['site', 'reading', null], ['condition', 'reading', null], ['certainty', 'reading', null]])
    expect(model.records[3]!.rows.every((row) => row.kind === 'queued')).toBe(true)
  })

  it('counts only what is read; keeps the partial\'s order and kei\'s labels', () => {
    expect(model.counts.toCheck).toBe(1)
    expect(model.counts.notReviewable).toBe(3)
    expect(model.records.map((each) => each.label)).toEqual(['Grav 8', 'Grav 9', 'Grav 10', 'Grav 11'])
  })
})

it('a doubtful link: not found, or found elsewhere; none after an edit or rejection', () => {
  expect(evidenceCheck({ verbatim: false })).toBe('Value not found in the linked passage')
  expect(evidenceCheck({ verbatim: true, lexicalHits: 3 })).toBe('Value also appears in 2 other passages')
  expect(evidenceCheck({ verbatim: false }, 'EDITED')).toBeNull()
})
