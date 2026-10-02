import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyReviewDecisions } from '../../../prototypes/studio/src/reviewDecisions.js'
import { applyReviewDecisionsToResult } from './postgres-batches.js'
import type { ResultPath } from './types.js'

type Decision = Parameters<typeof applyReviewDecisions>[1][number]

// The result path inside the immutable Extraction snapshot is a Review Decision's identity: the server projection
// (batch results) and the client one (Studio) apply it over a copy, at that path only, and agree.
const result = () => ({
  records: [{
    tags: ['a', 'b'],
    rooms: [
      { name: 'Hall', defects: [{ defect: 'crack' }, { defect: 'stain' }] },
      { name: 'Kitchen', defects: [{ defect: 'damp' }, { defect: 'crack' }] },
    ],
  }],
})

const decision = (resultPath: ResultPath, overrides: Partial<Decision> = {}): Decision => ({
  resultPath: [...resultPath], evidenceAnchorId: 'anchor', reviewedOccurrenceIds: ['o'], action: 'APPROVED', reviewedValue: null, ...overrides,
})

const twin: ResultPath = ['records', 0, 'rooms', 1, 'defects', 1, 'defect']
const original: ResultPath = ['records', 0, 'rooms', 0, 'defects', 0, 'defect']
const at = (value: unknown, path: ResultPath) =>
  path.reduce<unknown>((parent, segment) => (parent as Record<string | number, unknown>)[segment], value)

const projections = [
  ['server applyReviewDecisionsToResult', applyReviewDecisionsToResult],
  ['client applyReviewDecisions', applyReviewDecisions],
] as const

describe('Review Decision projection identity', () => {
  it('an edit of one of two equal values changes that path only, the same on the server and the client', () => {
    const input = result()
    assert.equal(at(input, original), at(input, twin))
    const decisions = [decision(twin, { action: 'EDITED', reviewedValue: 'mould' })]
    const server = applyReviewDecisionsToResult(input, decisions)
    const client = applyReviewDecisions(input, decisions)
    assert.deepEqual(server, client)
    const expected = result()
    expected.records[0]!.rooms[1]!.defects[1]!.defect = 'mould'
    assert.deepEqual(server, expected)
    assert.equal(at(server, original), 'crack')
    assert.deepEqual(input, result(), 'the input is never mutated')
  })

  for (const [name, project] of projections) {
    it(`${name} ignores the decision order and never mutates its input`, () => {
      const input = result()
      const decisions = [
        decision(twin, { action: 'EDITED', reviewedValue: 'mould' }),
        decision(['records', 0, 'rooms', 0, 'defects', 1, 'defect'], { action: 'REJECTED' }),
        decision(original),
      ]
      const forward = project(input, decisions)
      const backward = project(input, [...decisions].reverse())
      assert.deepEqual(forward, backward)
      assert.equal(at(forward, twin), 'mould')
      assert.equal(at(forward, ['records', 0, 'rooms', 0, 'defects', 1, 'defect']), null)
      assert.equal(at(forward, original), 'crack')
      assert.notEqual(forward, input)
      assert.deepEqual(input, result())
    })

    it(`${name} changes nothing and throws nothing for a path that no longer exists`, () => {
      const input = result()
      for (const resultPath of [
        ['records', 0, 'rooms', 5, 'defects', 0, 'defect'],
        ['records', 3, 'rooms', 0, 'name'],
        ['records', 0, 'gone', 0, 'defect'],
      ] as ResultPath[]) {
        for (const overrides of [{ action: 'EDITED', reviewedValue: 'mould' }, { action: 'REJECTED' }] as const) {
          let projected: unknown
          assert.doesNotThrow(() => { projected = project(input, [decision(resultPath, overrides)]) })
          assert.deepEqual(projected, result(), JSON.stringify(resultPath))
        }
      }
      assert.deepEqual(input, result())
    })

    // `setAtPath` writes only an existing leaf, so a review can replace a value but never insert one.
    it(`${name} changes nothing for a missing leaf under an existing parent`, () => {
      const input = result()
      for (const resultPath of [['records', 0, 'tags', 4], ['records', 0, 'tags', -1], ['records', 0, 'rooms', 0, 'missing'], ['records', 2]] as ResultPath[])
        for (const overrides of [{ action: 'EDITED', reviewedValue: 'mould' }, { action: 'REJECTED' }] as const) {
          let projected: unknown
          assert.doesNotThrow(() => { projected = project(input, [decision(resultPath, overrides)]) })
          assert.deepEqual(projected, result(), JSON.stringify(resultPath))
        }
      assert.deepEqual(input, result())
    })
  }
})
