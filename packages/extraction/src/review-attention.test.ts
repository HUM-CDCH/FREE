import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewAttention } from './review-attention.js'

test('presence and decisions are independent; arrays describe only actual occurrences', () => {
  const nodes = [
    { id: 'name', name: 'renamed', type: 'string' as const },
    { id: 'group', name: 'details', type: 'object' as const, children: [{ id: 'date', name: 'date', type: 'date' as const }] },
    { id: 'list', name: 'tags', type: 'array' as const, itemType: 'string' as const },
  ]
  const path = ['records', 0, 'renamed']
  const attention = reviewAttention({ records: [{ renamed: 'one', tags: [] }, { renamed: 'two', tags: ['B', 'A'] }] }, nodes,
    [{ resultPath: path, evidenceAnchorId: 'anchor' }],
    [{ resultPath: path, evidenceAnchorId: 'anchor', reviewedOccurrenceIds: [], action: 'APPROVED', reviewedValue: null,
      carriedFrom: { extractionId: 'sample', sourcePathKey: 'old-name' } }])
  assert.deepEqual([attention.grounded, attention.ungrounded, attention.missing, attention.requiredRemaining], [1, 3, 2, 0])
  assert.equal(attention.cells[0]!.decision?.provenance, 'carried')
  assert.equal(reviewAttention({ records: [] }, nodes, [], []).cells.length, 0)
  assert.equal(reviewAttention({ records: [{ renamed: 'one' }] }, nodes, [{ resultPath: path, evidenceAnchorId: 'anchor' }], []).requiredRemaining, 1)
})
