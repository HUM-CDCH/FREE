import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aggregateFieldOutcomes,
  alignRecords,
  precisionRecallF1,
  scoreAlignment,
  scoreDocument,
  type RecordFields,
} from './record-alignment-scoring.js'
import type { SchemaNode } from './schema.js'

const nodes: SchemaNode[] = [
  { id: 'species-id', name: 'species', type: 'string', identifying: true },
  { id: 'count-id', name: 'count', type: 'integer' },
  {
    id: 'temp-id',
    name: 'temperature',
    type: 'number',
    evaluationTolerance: { kind: 'absolute', amount: 0.5 },
  },
]

const salmon: RecordFields = { species: 'Salmon', count: 3, temperature: 8 }
const cod: RecordFields = { species: 'Cod', count: 5, temperature: 10 }

describe('alignRecords', () => {
  it('aligns reordered-but-matchable records by their identifying field', () => {
    const alignment = alignRecords(nodes, [cod, salmon], [salmon, cod])
    assert.equal(alignment.matched.length, 2)
    assert.equal(alignment.unmatchedGold.length, 0)
    assert.equal(alignment.unmatchedExtracted.length, 0)
    const bySpecies = new Map(
      alignment.matched.map((pair) => [pair.gold.species, pair]),
    )
    assert.deepEqual(bySpecies.get('Salmon')?.extracted, salmon)
    assert.deepEqual(bySpecies.get('Cod')?.extracted, cod)
  })

  it('reports an omitted gold record as unmatched, not merged or dropped', () => {
    const alignment = alignRecords(nodes, [salmon], [salmon, cod])
    assert.equal(alignment.matched.length, 1)
    assert.deepEqual(alignment.unmatchedGold, [cod])
    assert.equal(alignment.unmatchedExtracted.length, 0)
  })

  it('reports a hallucinated extracted record as unmatched', () => {
    const alignment = alignRecords(nodes, [salmon, cod], [salmon])
    assert.equal(alignment.matched.length, 1)
    assert.deepEqual(alignment.unmatchedExtracted, [cod])
    assert.equal(alignment.unmatchedGold.length, 0)
  })

  it('falls back to greedy similarity when no field is identifying', () => {
    const noKeyNodes: SchemaNode[] = [
      { id: 'species-id', name: 'species', type: 'string' },
      { id: 'count-id', name: 'count', type: 'integer' },
    ]
    const alignment = alignRecords(
      noKeyNodes,
      [
        { species: 'Cod', count: 5 },
        { species: 'Salmon', count: 3 },
      ],
      [
        { species: 'Salmon', count: 3 },
        { species: 'Cod', count: 5 },
      ],
    )
    assert.equal(alignment.matched.length, 2)
    const bySpecies = new Map(
      alignment.matched.map((pair) => [pair.gold.species, pair]),
    )
    assert.deepEqual(bySpecies.get('Salmon')?.extracted, {
      species: 'Salmon',
      count: 3,
    })
  })

  it('falls back to greedy assignment when the identifying key ties on either side', () => {
    const tied = alignRecords(
      nodes,
      [
        { species: 'Salmon', count: 3, temperature: 8 },
        { species: 'Salmon', count: 9, temperature: 20 },
      ],
      [
        { species: 'Salmon', count: 3, temperature: 8 },
        { species: 'Salmon', count: 9, temperature: 20 },
      ],
    )
    assert.equal(tied.matched.length, 2)
    assert.equal(tied.unmatchedGold.length, 0)
    assert.equal(tied.unmatchedExtracted.length, 0)
  })

  it('does not collide records with a blank identifying value onto one key', () => {
    const blankA: RecordFields = { species: '', count: 1, temperature: 1 }
    const blankB: RecordFields = { species: '', count: 2, temperature: 2 }
    const alignment = alignRecords(nodes, [blankA], [blankB])
    // Falls through to greedy (no usable key on either blank record) and
    // still ends up matched — the point is it's not a spurious "both blank
    // so they're the same key" short-circuit.
    assert.equal(alignment.matched.length, 1)
  })
})

describe('scoreAlignment / field comparison', () => {
  it('requires an exact match on an unconfigured numeric field', () => {
    const alignment = alignRecords(
      nodes,
      [{ species: 'Salmon', count: 4, temperature: 8 }],
      [salmon],
    )
    const counts = scoreAlignment(nodes, alignment)
    // species + temperature correct, count (4 vs 3, no tolerance) incorrect.
    assert.equal(counts.correctFields, 2)
    assert.equal(counts.totalGoldFields, 3)
    assert.equal(counts.totalExtractedFields, 3)
  })

  it('credits a near-miss within a configured tolerance', () => {
    const withinTolerance = scoreDocument(
      nodes,
      [{ species: 'Salmon', count: 3, temperature: 8.3 }],
      [salmon],
    )
    assert.equal(withinTolerance.correctFields, 3)

    const outsideTolerance = scoreDocument(
      nodes,
      [{ species: 'Salmon', count: 3, temperature: 8.6 }],
      [salmon],
    )
    assert.equal(outsideTolerance.correctFields, 2)
  })

  it('counts every field of an omitted record as a recall miss, never correct', () => {
    const counts = scoreDocument(nodes, [salmon], [salmon, cod])
    assert.equal(counts.correctFields, 3)
    assert.equal(counts.totalGoldFields, 6)
    assert.equal(counts.totalExtractedFields, 3)
    assert.equal(precisionRecallF1(counts).recall, 0.5)
    assert.equal(precisionRecallF1(counts).precision, 1)
  })

  it('counts every field of a hallucinated record as a precision miss, never correct', () => {
    const counts = scoreDocument(nodes, [salmon, cod], [salmon])
    assert.equal(counts.correctFields, 3)
    assert.equal(counts.totalGoldFields, 3)
    assert.equal(counts.totalExtractedFields, 6)
    assert.equal(precisionRecallF1(counts).precision, 0.5)
    assert.equal(precisionRecallF1(counts).recall, 1)
  })
})

describe('aggregateFieldOutcomes / precisionRecallF1', () => {
  it('sums raw counts across documents before deriving ratios, reflecting both matched-pair and unmatched-record outcomes', () => {
    const documentA = scoreDocument(nodes, [salmon], [salmon, cod]) // 3/6 recall, 3/3 precision
    const documentB = scoreDocument(nodes, [salmon, cod], [salmon, cod]) // perfect
    const aggregated = aggregateFieldOutcomes([documentA, documentB])
    assert.deepEqual(aggregated, {
      correctFields: 3 + 6,
      totalGoldFields: 6 + 6,
      totalExtractedFields: 3 + 6,
    })
    const metrics = precisionRecallF1(aggregated)
    assert.equal(metrics.recall, 9 / 12)
    assert.equal(metrics.precision, 9 / 9)
    assert.ok(metrics.f1 > 0 && metrics.f1 < 1)
  })

  it('reports zero, not NaN, for an empty corpus', () => {
    const metrics = precisionRecallF1({
      correctFields: 0,
      totalGoldFields: 0,
      totalExtractedFields: 0,
    })
    assert.deepEqual(metrics, { precision: 0, recall: 0, f1: 0 })
  })
})
