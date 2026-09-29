import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExtractionError } from './errors.js'
import type { ParsedDocument } from './parsed-document.js'
import {
  normalizeDecisions,
  reviewableExtraction,
  reviewAuthority,
  reviewAuthorityMatchesExtraction,
  transferEntries,
  transferSample,
  transferVerdicts,
  unionReviewTransfer,
  type ReviewAuthority,
} from './review-rules.js'
import { parseExtractionSchema } from './schema.js'
import type { EvidenceLink, ExtractionSnapshot, ResultPath, ReviewDecisionInput, ReviewPairing } from './types.js'

const schemaTree = {
  recordDescription: 'Catalogue records.',
  schemaNodes: [
    { id: 'title', name: 'title', type: 'string' },
    { id: 'year', name: 'year', type: 'integer' },
    { id: 'scale', name: 'scale', type: 'number' },
    { id: 'kind', name: 'kind', type: 'string', allowedValues: ['map', 'chart'] },
  ],
}

const document = {
  evidence_index: {
    anchors: [
      { anchor_id: 'anchor-title', producer_observations: [{ occurrence_id: 'o-2' }, { occurrence_id: 'o-1' }] },
      { anchor_id: 'anchor-year', producer_observations: [{ occurrence_id: 'o-3' }] },
      { anchor_id: 'anchor-scale', producer_observations: [{ occurrence_id: 'o-4' }] },
      { anchor_id: 'anchor-kind', producer_observations: [{ occurrence_id: 'o-5' }] },
    ],
  },
} as unknown as ParsedDocument

const link = (field: string): EvidenceLink => ({ resultPath: ['records', 0, field], evidenceAnchorId: `anchor-${field}` })
const occurrences: Record<string, string[]> = { title: ['o-1', 'o-2'], year: ['o-3'], scale: ['o-4'], kind: ['o-5'] }

function snapshot(overrides: Partial<ExtractionSnapshot> = {}): ExtractionSnapshot {
  return {
    extractionId: 'x-1', sourceDocumentId: 'd-1', sourceRepresentationRevisionId: 'r-1',
    sourceRepresentationRevisionNumber: 1, schemaRevisionId: 's-1', extractionSchemaId: 'e-1',
    schemaRevisionNumber: 1, strategy: 'ARTICLE', catalogRecipe: null,
    outcome: 'SUCCEEDED', complete: true, modelAttribution: null,
    diagnostics: {
      phase: 'persisting', durationMs: 1, modelCalls: 1, finishReason: null, inputTokens: null,
      outputTokens: null, ungroundedPaths: [['records', 0, 'kind']], groundingIssues: [], groundingBatches: [],
      unverifiedFields: [], catalog: null,
    },
    result: { records: [{ title: 'Alpha', year: 1900, scale: 2.5, kind: 'map' }] },
    evidence: [link('title'), link('year'), link('scale')],
    failure: null, reviewable: true, batchExtractionId: null,
    createdAt: new Date(0), reviewedAt: null, reviewDecisions: [],
    ...overrides,
  }
}

function approve(field: string, overrides: Partial<ReviewDecisionInput> = {}): ReviewDecisionInput {
  return {
    resultPath: ['records', 0, field], evidenceAnchorId: `anchor-${field}`,
    reviewedOccurrenceIds: occurrences[field]!, action: 'APPROVED', reviewedValue: null, ...overrides,
  }
}

const approvals = () => [approve('title'), approve('year'), approve('scale')]

function authorize(extraction: ExtractionSnapshot, decisions: readonly ReviewDecisionInput[], tree: unknown = schemaTree) {
  return reviewAuthority({ extraction: reviewableExtraction(extraction), document, schemaTree: tree, decisions, expectedDraftVersion: 3 })
}

function refuses(code: string, message: string) {
  return (error: unknown) => error instanceof ExtractionError && error.code === code && error.message === message
}

const COVERAGE = 'The Extraction grounding coverage does not match its stored Extraction Result.'
const DECISIONS = 'The Review Decisions do not match the pinned Extraction Result.'

describe('Review Decision rules against the read snapshot', () => {
  it('grants the review authority: the decisions, each anchor\'s occurrences and the Evidence\'s result paths', () => {
    const authority = authorize(snapshot(), approvals())
    assert.equal(authority.expectedDraftVersion, 3)
    assert.deepEqual(authority.reviewDecisions, approvals())
    assert.deepEqual(authority.occurrenceIdsByAnchor.get('anchor-title'), new Set(['o-1', 'o-2']))
    assert.deepEqual(authority.evidenceResultPathKeys, new Set(['title', 'year', 'scale'].map((field) => JSON.stringify(['records', 0, field]))))
  })

  it('refuses an Extraction without a reviewable Extraction Result', () => {
    for (const extraction of [snapshot({ reviewable: false }), snapshot({ result: null }), snapshot({ evidence: null })])
      assert.throws(() => reviewableExtraction(extraction), refuses('invalid_review', 'The Extraction has no reviewable Extraction Result.'))
  })

  it('checks the schema, then the records, then the coverage, then the decisions', () => {
    const noDecisions: ReviewDecisionInput[] = []
    const uncovered = snapshot({ evidence: [link('title')] })
    assert.throws(() => authorize(uncovered, noDecisions, { schemaNodes: 'not a schema' }),
      refuses('invalid_schema_revision', 'The pinned Schema Revision is invalid.'))
    assert.throws(() => authorize({ ...uncovered, result: { records: [{ unknown: 'x' }] } }, noDecisions),
      refuses('invalid_review', 'The Extraction Result does not match its pinned Schema Revision.'))
    assert.throws(() => authorize(uncovered, noDecisions), refuses('invalid_review', COVERAGE))
  })

  it('refuses a coverage mismatch: a populated value neither grounded nor ungrounded, or both', () => {
    assert.throws(() => authorize(snapshot({ evidence: [link('title'), link('year')] }), approvals().slice(0, 2)), refuses('invalid_review', COVERAGE))
    const both = snapshot()
    const overlap = { ...both.diagnostics, ungroundedPaths: [['records', 0, 'kind'], ['records', 0, 'scale']] as ResultPath[] }
    assert.throws(() => authorize({ ...both, diagnostics: overlap }, approvals()), refuses('invalid_review', COVERAGE))
  })

  it('refuses a duplicate Evidence path', () => {
    const duplicated = snapshot({ evidence: [link('title'), link('year'), link('scale'), link('year')] })
    assert.throws(() => authorize(duplicated, approvals()), refuses('invalid_review', COVERAGE))
  })

  it('refuses decisions that do not match the Evidence one to one', () => {
    for (const decisions of [
      approvals().slice(0, 2),
      [...approvals(), approve('kind')],
      [approve('title', { evidenceAnchorId: 'anchor-year' }), approve('year'), approve('scale')],
    ])
      assert.throws(() => authorize(snapshot(), decisions), refuses('invalid_review', DECISIONS))
  })

  it('an EDITED decision carries a value and only it does', () => {
    assert.doesNotThrow(() => authorize(snapshot(), [approve('title', { action: 'EDITED', reviewedValue: 'Beta' }), approve('year'), approve('scale')]))
    assert.doesNotThrow(() => authorize(snapshot(), [approve('title', { action: 'REJECTED' }), approve('year'), approve('scale')]))
    for (const title of [
      approve('title', { action: 'EDITED' }),
      approve('title', { reviewedValue: 'Beta' }),
      approve('title', { action: 'REVISED' as ReviewDecisionInput['action'] }),
    ])
      assert.throws(() => authorize(snapshot(), [title, approve('year'), approve('scale')]), refuses('invalid_review', DECISIONS))
  })

  it('an EDITED value fits its node\'s numeric type and allowed values', () => {
    const kindGrounded = snapshot({
      evidence: [link('title'), link('year'), link('scale'), link('kind')],
      diagnostics: { ...snapshot().diagnostics, ungroundedPaths: [] },
    })
    const edit = (field: string, reviewedValue: unknown) => approvals().concat(approve('kind')).map((decision) =>
      decision.resultPath[2] === field ? { ...decision, action: 'EDITED' as const, reviewedValue } : decision)
    for (const [field, value] of [['year', 1901], ['scale', 0.5], ['scale', 3], ['kind', 'chart']] as const)
      assert.doesNotThrow(() => authorize(kindGrounded, edit(field, value)))
    for (const [field, value] of [['year', 1900.5], ['year', '1901'], ['scale', Number.NaN], ['scale', Number.POSITIVE_INFINITY], ['kind', 'atlas'], ['kind', 1]] as const)
      assert.throws(() => authorize(kindGrounded, edit(field, value)), refuses('invalid_review', DECISIONS), `${field}=${String(value)}`)
  })
})

describe('Review Decision revalidation against the locked row', () => {
  const authority = (decisions: readonly ReviewDecisionInput[] = approvals()): ReviewAuthority => authorize(snapshot(), decisions)
  const holds = (decisions: readonly ReviewDecisionInput[], extraction = snapshot(), granted = authority()) =>
    reviewAuthorityMatchesExtraction(extraction, normalizeDecisions(decisions), granted)

  it('holds for the decisions the authority was granted for', () => {
    assert.equal(holds(approvals()), true)
  })

  it('fails when a decision does not review exactly the occurrences its Evidence Anchor owns', () => {
    for (const title of [
      approve('title', { reviewedOccurrenceIds: ['o-1'] }),
      approve('title', { reviewedOccurrenceIds: ['o-1', 'o-2', 'o-3'] }),
      approve('title', { reviewedOccurrenceIds: ['o-1', 'o-9'] }),
    ])
      assert.equal(holds([title, approve('year'), approve('scale')]), false)
  })

  it("a correction's own Evidence is a published anchor with every occurrence, once, on an EDITED decision only", () => {
    const corrected = (reviewedEvidence: ReviewDecisionInput['reviewedEvidence'], action: 'EDITED' | 'APPROVED' = 'EDITED') =>
      holds([approve('title', { action, reviewedValue: action === 'EDITED' ? 'Corrected' : null, reviewedEvidence }),
        approve('year'), approve('scale')])
    assert.equal(corrected([{ evidenceAnchorId: 'anchor-title', reviewedOccurrenceIds: ['o-2', 'o-1'] }]), true)
    assert.equal(corrected([{ evidenceAnchorId: 'anchor-title', reviewedOccurrenceIds: ['o-1', 'o-1'] }]), false)
    assert.equal(corrected([{ evidenceAnchorId: 'anchor-missing', reviewedOccurrenceIds: ['o-9'] }]), false)
    assert.equal(corrected([{ evidenceAnchorId: 'anchor-year', reviewedOccurrenceIds: ['o-3'] }], 'APPROVED'), false)
  })

  it('fails on the action/value rule, a changed row or Evidence the authority was not granted for', () => {
    assert.equal(holds([approve('title', { action: 'EDITED' }), approve('year'), approve('scale')]), false)
    assert.equal(holds(approvals(), snapshot({ reviewable: false })), false)
    assert.equal(holds(approvals(), snapshot({ outcome: 'FAILED' as unknown as 'SUCCEEDED' })), false)
    assert.equal(holds(approvals(), snapshot({ outcome: 'CANCELLED' as unknown as 'SUCCEEDED' })), false)
    assert.equal(holds(approvals(), snapshot({ evidence: null })), false)
    assert.equal(holds(approvals(), snapshot({ evidence: {} as unknown as EvidenceLink[] })), false)
    assert.equal(holds(approvals(), snapshot({ evidence: [link('title'), link('year'), link('kind')] })), false)
    assert.equal(holds([approve('title'), approve('year'), approve('year')]), false)
  })

  it('the decision digest ignores decision order and occurrence order and duplicates', () => {
    const [title, year, scale] = approvals()
    const reordered = [scale!, { ...title!, reviewedOccurrenceIds: ['o-2', 'o-1', 'o-2'] }, year!]
    assert.equal(JSON.stringify(normalizeDecisions(reordered)), JSON.stringify(normalizeDecisions(approvals())))
    assert.equal(
      JSON.stringify(normalizeDecisions([approve('year'), { ...title!, reviewedOccurrenceIds: ['o-2', 'o-1'] }])),
      '[{"resultPath":["records",0,"title"],"resultPathKey":"[\\"records\\",0,\\"title\\"]","evidenceAnchorId":"anchor-title",' +
        '"reviewedOccurrenceIds":["o-1","o-2"],"action":"APPROVED","reviewedValue":null},' +
        '{"resultPath":["records",0,"year"],"resultPathKey":"[\\"records\\",0,\\"year\\"]","evidenceAnchorId":"anchor-year",' +
        '"reviewedOccurrenceIds":["o-3"],"action":"APPROVED","reviewedValue":null}]',
    )
  })
})

describe('Review transfer from a sample to a later run', () => {
  const nodes = parseExtractionSchema({
    recordDescription: 'Catalogue entries.',
    schemaNodes: [
      { id: 'n-number', name: 'number', type: 'string' },
      { id: 'n-date', name: 'date', type: 'string' },
      { id: 'n-marks', name: 'marks', type: 'array', itemType: 'string' },
    ],
  }).schemaNodes
  type Value = readonly [string, string]
  /** An Extraction from records of `field: [value, anchor]`, or `[[value, anchor], ...]` for an array. */
  const run = (extractionId: string, records: Record<string, Value | readonly Value[]>[]) => ({
    extractionId,
    diagnostics: {} as ExtractionSnapshot['diagnostics'],
    result: { records: records.map((record) => Object.fromEntries(Object.entries(record).map(([field, value]) =>
      [field, Array.isArray(value[0]) ? (value as Value[]).map((item) => item[0]) : value[0]]))) },
    evidence: records.flatMap((record, index) => Object.entries(record).flatMap(([field, value]) =>
      Array.isArray(value[0])
        ? (value as Value[]).map((item, at) => ({ resultPath: ['records', index, field, at], evidenceAnchorId: item[1] }))
        : [{ resultPath: ['records', index, field], evidenceAnchorId: (value as Value)[1] }])),
  })
  type Sample = ReturnType<typeof run>
  const decide = (sample: Sample, path: ResultPath, action: ReviewDecisionInput['action'], reviewed: Partial<ReviewDecisionInput> = {}) => ({
    resultPath: path, action, reviewedOccurrenceIds: [], reviewedValue: null, ...reviewed,
    evidenceAnchorId: sample.evidence.find((each) => JSON.stringify(each.resultPath) === JSON.stringify(path))!.evidenceAnchorId,
  })
  /** Each destination value's status, carried action and carried value after `decisions` on `sample`. */
  const verdicts = (sample: Sample, decisions: ReviewDecisionInput[], destination: Sample, pairings: ReviewPairing[] = []) =>
    Object.fromEntries([...transferVerdicts(
      unionReviewTransfer([{ ...transferSample(sample), entries: transferEntries(sample, decisions, nodes, 1) }])!,
      destination, nodes, pairings,
    )].map(([key, { status, decision }]) => [key, [status, decision?.action, decision?.reviewedValue].filter(Boolean).join(' ')]))
  const date = ['records', 0, 'date']
  const nr41 = (dateValue: string, anchor: string, extractionId = 'full') => run(extractionId, [{ number: ['41', 'a0'], date: [dateValue, anchor] }])
  const corrected = { reviewedValue: 'um 1650', reviewedEvidence: [{ evidenceAnchorId: 'a1', reviewedOccurrenceIds: ['o1'] }] }

  it('carries an approval, the same mistake, a fix and a rejection, and nothing on another anchor', () => {
    const sample = nr41('1897', 'a2', 'sample')
    const cell = nr41('1897', 'a_p3_s2_c4', 'sample')
    const cases: [string, Sample, ReviewDecisionInput, Sample, string][] = [
      ['approval', sample, decide(sample, date, 'APPROVED'), nr41('1897', 'a2'), 'reviewed APPROVED'],
      ['same mistake', sample, decide(sample, date, 'EDITED', corrected), nr41('1897', 'a2'), 'reviewed EDITED um 1650'],
      ['fix', sample, decide(sample, date, 'EDITED', corrected), nr41('um 1650', 'a1'), 'fixed APPROVED'],
      ['fix without its Evidence', sample, decide(sample, date, 'EDITED', { reviewedValue: 'um 1650' }), nr41('um 1650', 'a1'), 'changed'],
      ['rejection', sample, decide(sample, date, 'REJECTED'), nr41('1897', 'a2'), 'reviewed REJECTED'],
      ['moved anchor', sample, decide(sample, date, 'APPROVED'), nr41('1897', 'a3'), 'changed'],
      ['same table cell', cell, decide(cell, date, 'APPROVED'), nr41('1897', 'a_p3_s2_c4'), 'reviewed APPROVED'],
      ['another table cell', cell, decide(cell, date, 'APPROVED'), nr41('1897', 'a_p3_s2_c5'), 'changed'],
    ]
    for (const [name, source, decision, destination, expected] of cases)
      assert.equal(verdicts(source, [decision], destination)[JSON.stringify(date)], expected, name)
  })

  it('leaves merged and split Article records unmatched', () => {
    const two = run('sample', [{ number: ['41', 'a0'], date: ['1897', 'a1'] }, { number: ['42', 'b0'], date: ['1612', 'b1'] }])
    const both = [decide(two, date, 'APPROVED'), decide(two, ['records', 1, 'date'], 'APPROVED')]
    assert.deepEqual(verdicts(two, both, run('full', [{ number: ['41', 'a0'], date: ['1612', 'b1'] }])),
      { '["records",0,"number"]': 'unmatched', '["records",0,"date"]': 'unmatched' })
    const one = nr41('1897', 'a1', 'sample')
    assert.deepEqual(verdicts(one, [decide(one, date, 'APPROVED')], run('full', [{ number: ['41', 'a0'] }, { date: ['1897', 'a1'] }])),
      { '["records",0,"number"]': 'unmatched', '["records",1,"date"]': 'unmatched' })
  })

  it('compares a split record paired by hand with one half under the same rules, and ignores a pairing of an aligned record', () => {
    const whole = run('sample', [{ number: ['41', 'a0'], date: ['1897', 'a1'], marks: [['Augsburg', 'a2']] }])
    const decisions = [decide(whole, ['records', 0, 'number'], 'APPROVED'), decide(whole, date, 'APPROVED'),
      decide(whole, ['records', 0, 'marks', 0], 'APPROVED')]
    // The full run split it: the first half cites the date on another passage, the second keeps the mark's.
    const split = run('full', [{ number: ['41', 'a0'], date: ['1897', 'a9'] }, { marks: [['Augsburg', 'a2']] }])
    const paired = { record: 0, extractionId: 'sample', sourceRecord: 0 }
    assert.deepEqual(verdicts(whole, decisions, split, [paired]), {
      '["records",0,"number"]': 'reviewed APPROVED', '["records",0,"date"]': 'changed', '["records",1,"marks",0]': 'unmatched',
    })
    const other = run('sample', [{ number: ['41', 'a0'] }, { number: ['42', 'b0'] }])
    assert.deepEqual(verdicts(other, [decide(other, ['records', 0, 'number'], 'APPROVED'), decide(other, ['records', 1, 'number'], 'APPROVED')],
      run('full', [{ number: ['41', 'a0'] }]), [{ record: 0, extractionId: 'sample', sourceRecord: 1 }]),
    { '["records",0,"number"]': 'reviewed APPROVED' })
  })

  const twoSamples = (older: Sample, olderDecisions: ReviewDecisionInput[], newer: Sample, newerDecisions: ReviewDecisionInput[],
    pairings: ReviewPairing[] = []) => unionReviewTransfer([
    { ...transferSample(older), entries: transferEntries(older, olderDecisions, nodes, 1) },
    { ...transferSample(newer), entries: transferEntries(newer, newerDecisions, nodes, 1), pairings },
  ])!
  const statuses = (transfer: ReturnType<typeof twoSamples>, destination: Sample) => Object.fromEntries([...transferVerdicts(
    transfer, destination, nodes)].map(([key, { status, decision }]) => [key, [status, decision?.action].filter(Boolean).join(' ')]))
  const number = ['records', 0, 'number']

  it('aligns one record across samples: two samples\' records merged in the run are unmatched, one record sampled twice carries', () => {
    const first = run('first', [{ number: ['41', 'a0'] }])
    const second = run('second', [{ date: ['1897', 'b0'] }])
    assert.deepEqual(statuses(twoSamples(first, [decide(first, number, 'APPROVED')], second, [decide(second, date, 'APPROVED')]),
      run('full', [{ number: ['41', 'a0'], date: ['1897', 'b0'] }])),
    { '["records",0,"number"]': 'unmatched', '["records",0,"date"]': 'unmatched' })
    const once = nr41('1897', 'a2', 'once')
    const twice = nr41('1897', 'a2', 'twice')
    assert.deepEqual(statuses(twoSamples(once, [decide(once, number, 'APPROVED')], twice, [decide(twice, date, 'REJECTED')]), nr41('1897', 'a2')),
      { '["records",0,"number"]': 'reviewed APPROVED', '["records",0,"date"]': 'reviewed REJECTED' })
  })

  it('lets a newer sample\'s decision on a record it paired by hand override the older one', () => {
    const whole = nr41('1897', 'a1', 'whole')
    const split = run('split', [{ number: ['41', 'a0'] }, { date: ['1897', 'a1'] }])
    const transfer = twoSamples(whole, [decide(whole, date, 'APPROVED')], split, [decide(split, ['records', 1, 'date'], 'REJECTED')],
      [{ record: 1, extractionId: 'whole', sourceRecord: 0 }])
    assert.deepEqual(transfer.entries.map((entry) => [entry.extractionId, entry.action]), [['split', 'REJECTED']])
    assert.deepEqual(statuses(transfer, nr41('1897', 'a1')), { '["records",0,"number"]': 'unmatched', '["records",0,"date"]': 'unmatched' })
  })

  it('never carries or keeps a corrected value the destination field no longer allows', () => {
    const narrowed = parseExtractionSchema({ recordDescription: 'Catalogue entries.', schemaNodes: [
      { id: 'n-number', name: 'number', type: 'string' }, { id: 'n-date', name: 'date', type: 'string', allowedValues: ['1897', '1898'] },
    ] }).schemaNodes
    const sample = nr41('1897', 'a2', 'sample')
    const verdict = transferVerdicts(unionReviewTransfer([{ ...transferSample(sample),
      entries: transferEntries(sample, [decide(sample, date, 'EDITED', corrected)], nodes, 1) }])!, nr41('1897', 'a2'), narrowed)
      .get(JSON.stringify(date))
    assert.deepEqual([verdict?.status, verdict?.decision, verdict?.kept], ['changed', null, null])
  })

  it('aligns array items by their anchors, never by index', () => {
    const marks = run('sample', [{ number: ['41', 'a0'], marks: [['N', 'm1'], ['A', 'm2']] }])
    const decisions = [decide(marks, ['records', 0, 'marks', 0], 'APPROVED'), decide(marks, ['records', 0, 'marks', 1], 'REJECTED')]
    assert.deepEqual(verdicts(marks, decisions, run('full', [{ number: ['41', 'a0'], marks: [['A', 'm2'], ['N', 'm1']] }])),
      { '["records",0,"marks",0]': 'reviewed REJECTED', '["records",0,"marks",1]': 'reviewed APPROVED' })
  })
})
