import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import progressFixture from '../../../prototypes/parsing_service/tests/fixtures/contracts/extract.progress.json' with { type: 'json' }
import articleProgressFixture from '../../../prototypes/parsing_service/tests/fixtures/contracts/extract.progress.article.json' with { type: 'json' }
import { partialFromProgress, progressDocumentSchema, type ProgressDocument } from './partial-result.js'
import type { VerifiedGrounding } from './types.js'

/** The shared fixture as a typed, mutable document: its nullable fields may be set to null in a case. */
const fixture = (): ProgressDocument => progressDocumentSchema.parse(structuredClone(progressFixture))
const key = (...path: string[]) => JSON.stringify(path)

describe('partialFromProgress', () => {
  it('maps the shared fixture: one record per entry, in the order they were read, each value in its state', () => {
    const partial = partialFromProgress(fixture())!
    assert.equal(partial.strategy, 'CATALOG')
    assert.deepEqual([partial.startedAtPage, partial.discovered, partial.finished], [1, 5, 2])
    assert.deepEqual(partial.records.map((record) => [record.index, record.state]),
      [[0, 'finished'], [1, 'finished'], [2, 'checking'], [3, 'reading'], [4, 'queued']])
    const [first, second, third, reading, queued] = partial.records
    assert.deepEqual(first!.values[key('material')], { value: 'Holz', state: 'grounded' })
    assert.deepEqual(first!.values[key('gilded')], { value: null, state: 'empty' })
    assert.deepEqual(first!.values[key('finds', '0', 'count')], { value: 2, state: 'grounded' })
    assert.deepEqual(first!.evidenceLinks[0], {
      resultPath: ['records', 0, 'label'], evidenceAnchorId: 'a_p1_s0', precision: 'segment', verbatim: true, lexicalHits: 1,
      grounding: { linkedBy: 'verification', support: 'literal', textSpans: [{ segment: 'p1_s0', start: 0, end: 1 }],
        alternatives: [], precision: 'segment', raw: '1', itemSpans: null },
    })
    assert.equal((first!.evidenceLinks[3]!.grounding as VerifiedGrounding).itemSpans?.length, 1)  // the list item's occurrence
    // An arbitration left unresolved: the field is contested, with the values that disagreed (design §1).
    assert.deepEqual(second!.values[key('site')], { value: null, state: 'contested', candidates: ['Bdorf', 'Bdorf-Nord'] })
    // A candidates-stage entry: candidates are checking, what the values call left null is empty (Ruling 7).
    assert.deepEqual(third!.values[key('material')], { value: 'Gold', state: 'checking' })
    assert.deepEqual(third!.values[key('site')], { value: null, state: 'empty' })
    assert.deepEqual(third!.evidenceLinks, [])
    assert.deepEqual([reading!.record, reading!.values, queued!.record, queued!.label], [null, {}, null, null])
    assert.equal(partial.document, null)
  })

  it('a candidates-stage entry whose values window failed keeps its nulls unknown: reading, not empty', () => {
    const document = fixture()
    document.entries[2]!.failed = 1
    assert.deepEqual(partialFromProgress(document)!.records[2]!.values[key('site')], { value: null, state: 'reading' })
    assert.deepEqual(partialFromProgress(document)!.records[2]!.values[key('material')], { value: 'Gold', state: 'checking' })
  })

  it('orders records by distance from the start page, ties and unknown pages last in source order', () => {
    const document = fixture()
    document.started_at_page = 3
    document.entries[4]!.page = null
    assert.deepEqual(partialFromProgress(document)!.records.map((record) => record.index), [3, 2, 0, 1, 4])
    document.started_at_page = null
    assert.deepEqual(partialFromProgress(document)!.records.map((record) => record.index), [0, 1, 2, 3, 4])
  })

  it('a finished value kei kept without a link is checking, never grounded', () => {
    const document = fixture()
    document.entries[1]!.evidence = []
    const [, second] = partialFromProgress(document)!.records
    assert.deepEqual(second!.values[key('material')], { value: 'Stein', state: 'checking' })
  })

  it('maps an Article document: candidates checking and the rest reading while contexts remain; links grounded once complete', () => {
    const link = { path: ['records', 0, 'site'], segment: 'p1_s0', page: 1, bbox_pt: [0, 0, 1, 1], verbatim: true, hits: 1,
      linked_by: 'model', cell: null, precision: 'segment' }
    // The complete document, through the schema (typed, its nullable fields assignable); the incomplete one is derived from
    // it, as the reader produces it: no links before every context has answered.
    const complete: ProgressDocument = progressDocumentSchema.parse({
      version: 1, strategy: 'article', started_at_page: 2, discovered: 1, finished: 0,
      entries: [{ index: 0, label: null, page: null, stage: 'candidates', evidence: [link],
        candidates: [{ path: ['site'], value: 'Hill', quote: null, window: 0 }, { path: ['year'], value: 1828, quote: null, window: 0 }],
        record: { entry_no: null, site: 'Hill', year: 1828, finds: null }, contested: [], failed: 0 }],
      document: { contexts: [{ primary: ['p1_s0'], overlap: [] }, { primary: ['p2_s0'], overlap: [] }], answered: 2, of: 2, failed_contexts: 0, links: [link], grounding_batches: 1 },
    })
    const incomplete: ProgressDocument = structuredClone(complete)
    incomplete.document!.answered = 1
    incomplete.document!.links = []
    incomplete.document!.grounding_batches = 0
    incomplete.entries[0]!.evidence = []
    const reading = partialFromProgress(incomplete)!
    assert.equal(reading.strategy, 'ARTICLE')
    assert.deepEqual(reading.document, { contextsAnswered: 1, contexts: 2, groundingBatches: 0 })
    assert.equal(reading.records[0]!.state, 'checking')
    assert.deepEqual(reading.records[0]!.values[key('site')], { value: 'Hill', state: 'checking' })
    assert.deepEqual(reading.records[0]!.values[key('entry_no')], { value: null, state: 'reading' })
    assert.deepEqual(reading.records[0]!.evidenceLinks, [])
    const grounded = partialFromProgress(complete)!
    assert.deepEqual(grounded.document, { contextsAnswered: 2, contexts: 2, groundingBatches: 1 })
    assert.deepEqual(grounded.records[0]!.values[key('site')], { value: 'Hill', state: 'grounded' })
    assert.deepEqual(grounded.records[0]!.values[key('year')], { value: 1828, state: 'checking' })
    assert.deepEqual(grounded.records[0]!.values[key('entry_no')], { value: null, state: 'empty' })
    assert.deepEqual(grounded.records[0]!.evidenceLinks, [{ resultPath: ['records', 0, 'site'], evidenceAnchorId: 'a_p1_s0', precision: 'segment', verbatim: true, lexicalHits: 1 }])
    // A context whose call failed leaves its unanswered fields unknown; a conflict leaves its field contested.
    complete.entries[0]!.failed = 1
    assert.deepEqual(partialFromProgress(complete)!.records[0]!.values[key('entry_no')], { value: null, state: 'reading' })
    complete.entries[0]!.failed = 0
    complete.entries[0]!.contested = [{ path: ['entry_no'], candidates: ['31', '32'] }]
    assert.deepEqual(partialFromProgress(complete)!.records[0]!.values[key('entry_no')], { value: null, state: 'contested', candidates: ['31', '32'] })
  })

  it('maps the shared Article fixture: every context answered, its links grounded, a field no context answered empty', () => {
    const partial = partialFromProgress(progressDocumentSchema.parse(structuredClone(articleProgressFixture)))!
    assert.equal(partial.strategy, 'ARTICLE')
    assert.deepEqual([partial.startedAtPage, partial.discovered, partial.finished], [2, 1, 0])
    assert.deepEqual(partial.document, { contextsAnswered: 2, contexts: 2, groundingBatches: 2 })
    const [record] = partial.records
    assert.equal(record!.state, 'checking')
    assert.deepEqual(record!.values[key('site')], { value: 'Hill', state: 'grounded' })
    assert.deepEqual(record!.values[key('finds', '0')], { value: 'spear', state: 'grounded' })
    assert.deepEqual(record!.values[key('year')], { value: null, state: 'empty' })
    assert.deepEqual(record!.evidenceLinks[1], { resultPath: ['records', 0, 'site'], evidenceAnchorId: 'a_p2_s0', precision: 'segment', verbatim: false, lexicalHits: 2 })
  })

  it('a document outside the contract is null, never a throw', () => {
    for (const raw of [null, 'progress', {}, { ...fixture(), version: 2 }, { ...fixture(), entries: [{ index: 0 }] }])
      assert.equal(partialFromProgress(raw), null)
  })
})
