import { describe, expect, it } from 'vitest'
import {
  applyReviewDecisions,
  parseReviewedValue,
  schemaNodeAtResultPath,
} from './reviewDecisions'
import type { SchemaNode } from 'extraction/schema'

const nodes: SchemaNode[] = [{
  id: 'people',
  name: 'people',
  type: 'array',
  children: [
    { id: 'age', name: 'age', type: 'integer' },
    { id: 'active', name: 'active', type: 'boolean' },
    { id: 'kind', name: 'kind', type: 'string', allowedValues: ['A', 'B'] },
  ],
}]

describe('Review Decision projection', () => {
  it('applies nested edits and rejections without mutating the Extraction Result', () => {
    const original = {
      records: [{ people: [{ age: 4, active: true }] }],
    }
    const projected = applyReviewDecisions(original, [
      {
        resultPath: ['records', 0, 'people', 0, 'age'],
        evidenceAnchorId: 'age-anchor',
        reviewedOccurrenceIds: ['age-occurrence'],
        action: 'EDITED',
        reviewedValue: 7,
      },
      {
        resultPath: ['records', 0, 'people', 0, 'active'],
        evidenceAnchorId: 'active-anchor',
        reviewedOccurrenceIds: ['active-occurrence'],
        action: 'REJECTED',
        reviewedValue: null,
      },
    ])

    expect(projected).toEqual({
      records: [{ people: [{ age: 7, active: null }] }],
    })
    expect(original.records[0]?.people[0]).toEqual({ age: 4, active: true })
  })

  it('resolves array paths against the pinned schema and parses scalar types', () => {
    const age = schemaNodeAtResultPath(nodes, ['records', 0, 'people', 2, 'age'])
    const active = schemaNodeAtResultPath(nodes, ['records', 0, 'people', 2, 'active'])
    const kind = schemaNodeAtResultPath(nodes, ['records', 0, 'people', 2, 'kind'])

    expect(age?.name).toBe('age')
    expect(parseReviewedValue(age, '12')).toEqual({ value: 12, error: null })
    expect(parseReviewedValue(age, '12.5').error).toBe('Enter a whole number.')
    expect(parseReviewedValue(active, 'false')).toEqual({ value: false, error: null })
    expect(parseReviewedValue(kind, 'C').error).toBe('Choose a value allowed by the pinned schema.')
  })
})
