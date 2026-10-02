import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ExtractionError } from './errors.js'
import type { ParsedDocument } from './parsed-document.js'
import {
  normalizeDecisions,
  reviewableExtraction,
  reviewAuthority,
  reviewAuthorityMatchesExtraction,
  reviewDecisionMatchesSchema,
  type ReviewAuthority,
} from './review-rules.js'
import type { EvidenceLink, ExtractionSnapshot, ResultPath, ReviewDecisionInput } from './types.js'

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

  it('allows optional missing/ungrounded corrections only with canonical researcher-picked Evidence', () => {
    for (const missing of [false, true]) {
      const original = snapshot(missing ? { result: { records: [{ title: 'Alpha', year: 1900, scale: 2.5, kind: null }] },
        diagnostics: { ...snapshot().diagnostics, ungroundedPaths: [] } } : {})
      const correction = approve('kind', { evidenceAnchorId: null, reviewedOccurrenceIds: [], action: 'EDITED', reviewedValue: 'chart',
        reviewedEvidence: [{ evidenceAnchorId: 'anchor-kind', reviewedOccurrenceIds: ['o-5'] }] })
      const decisions = [...approvals(), correction]
      assert.equal(reviewAuthorityMatchesExtraction(reviewableExtraction(original), normalizeDecisions(decisions), authorize(original, decisions)), true)
      assert.doesNotThrow(() => authorize(original, approvals()))
      for (const invalid of [
        { ...correction, action: 'APPROVED' as const, reviewedValue: null },
        { ...correction, reviewedEvidence: [] },
        { ...correction, reviewedEvidence: [{ evidenceAnchorId: 'anchor-kind', reviewedOccurrenceIds: ['foreign'] }] },
        { ...correction, reviewedValue: 'disallowed' },
        { ...correction, resultPath: ['records', 1, 'kind'] },
      ]) assert.throws(() => authorize(original, [...approvals(), invalid]), refuses('invalid_review', DECISIONS))
    }
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

  it('an EDITED item of a scalar array is one value of the item type', () => {
    const nodes = [
      { id: 'grave_goods', name: 'grave_goods', type: 'array', itemType: 'string' },
      { id: 'counts', name: 'counts', type: 'array', itemType: 'integer' },
    ] as const
    const edit = (resultPath: ResultPath, reviewedValue: unknown): ReviewDecisionInput => ({
      resultPath, evidenceAnchorId: 'anchor', reviewedOccurrenceIds: ['o'], action: 'EDITED', reviewedValue,
    } as ReviewDecisionInput)
    assert.equal(reviewDecisionMatchesSchema(nodes, edit(['records', 0, 'grave_goods', 2], 'bronze pin, broken')), true)
    assert.equal(reviewDecisionMatchesSchema(nodes, edit(['records', 0, 'counts', 1], 3)), true)
    assert.equal(reviewDecisionMatchesSchema(nodes, edit(['records', 0, 'grave_goods', 2], ['bronze pin', 'broken'])), false)
    assert.equal(reviewDecisionMatchesSchema(nodes, edit(['records', 0, 'counts', 1], [3])), false)
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
