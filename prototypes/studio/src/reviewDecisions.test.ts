import { describe, expect, it } from 'vitest'
import {
  applyReviewDecisions,
  orderResultFields,
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
  it('orders nested records without coercing values, dropping extras or changing array positions', () => {
    const first = { extra: 'keep', kind: 'not an allowed value', active: null, age: 4 }
    const source = [{ people: [first, { active: false, age: 9 }], other: ['b', 'a'] }]
    const sorted = orderResultFields(source, nodes) as typeof source
    expect(sorted).toEqual(source)
    expect(Object.keys(sorted[0].people[0])).toEqual(['age', 'active', 'kind', 'extra'])
    expect(Object.keys(sorted[0].people[1])).toEqual(['age', 'active'])
    expect(Object.keys(first)).toEqual(['extra', 'kind', 'active', 'age'])
  })

  it('keeps every array item at its position and every value at its path, even two equal items', () => {
    const leafPaths = (value: unknown, path: (string | number)[] = []): string[] =>
      Array.isArray(value) ? value.flatMap((item, index) => leafPaths(item, [...path, index]))
        : value !== null && typeof value === 'object'
          ? Object.entries(value).flatMap(([key, item]) => leafPaths(item, [...path, key]))
          : [JSON.stringify([...path, value])]
    const twin = { kind: 'A', age: 4, active: true }
    const source = { records: [{ other: 'x', people: [{ ...twin }, { active: false, kind: 'B', age: 9 }, { ...twin }] }] }
    const sorted = orderResultFields(source.records, nodes) as typeof source.records
    expect(sorted[0].people.map((person) => person.age)).toEqual([4, 9, 4])
    expect(sorted[0].people.map((person) => person.kind)).toEqual(['A', 'B', 'A'])
    expect(new Set(leafPaths({ records: sorted }))).toEqual(new Set(leafPaths(source)))
    expect(leafPaths({ records: sorted })).toHaveLength(leafPaths(source).length)
    expect(Object.keys(sorted[0].people[2])).toEqual(['age', 'active', 'kind'])
  })
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

  it('changes nothing for a decision at an index past the end of an array or at a missing key', () => {
    const original = { records: [{ tags: ['a', 'b'], people: [{ age: 4 }] }] }
    for (const resultPath of [['records', 0, 'tags', 2], ['records', 0, 'people', 0, 'missing'], ['records', 1]]) {
      for (const action of ['EDITED', 'REJECTED'] as const) {
        const projected = applyReviewDecisions(original, [{
          resultPath, evidenceAnchorId: 'anchor', reviewedOccurrenceIds: ['o'], action,
          reviewedValue: action === 'EDITED' ? 'x' : null,
        }])
        expect(projected).toEqual({ records: [{ tags: ['a', 'b'], people: [{ age: 4 }] }] })
      }
    }
    expect(original).toEqual({ records: [{ tags: ['a', 'b'], people: [{ age: 4 }] }] })
  })

  it('resolves array paths against the pinned schema and parses scalar types', () => {
    const age = schemaNodeAtResultPath(nodes, ['records', 0, 'people', 2, 'age'])
    const active = schemaNodeAtResultPath(nodes, ['records', 0, 'people', 2, 'active'])
    const kind = schemaNodeAtResultPath(nodes, ['records', 0, 'people', 2, 'kind'])

    expect(age?.name).toBe('age')
    expect(parseReviewedValue(age, '12')).toEqual({ value: 12, error: null })
    expect(parseReviewedValue(age, '12.5').error).toBe('Enter a whole number.')
    expect(parseReviewedValue(age, ' ').error).toBe('Enter a whole number.')
    expect(parseReviewedValue(active, 'false')).toEqual({ value: false, error: null })
    expect(parseReviewedValue(kind, 'C').error).toBe('Choose a value allowed by the pinned schema.')
  })

  it('resolves one item of a scalar array to its item type, so an item edit stays one value', () => {
    const scalarArrays: SchemaNode[] = [
      { id: 'grave_goods', name: 'grave_goods', type: 'array', itemType: 'string' },
      { id: 'counts', name: 'counts', type: 'array', itemType: 'integer' },
    ]
    const good = schemaNodeAtResultPath(scalarArrays, ['records', 0, 'grave_goods', 2])
    const count = schemaNodeAtResultPath(scalarArrays, ['records', 0, 'counts', 1])

    expect(good?.type).toBe('string')
    expect(parseReviewedValue(good, 'bronze pin, broken')).toEqual({ value: 'bronze pin, broken', error: null })
    expect(parseReviewedValue(count, '3')).toEqual({ value: 3, error: null })
    expect(parseReviewedValue(count, '3, 4').error).toBe('Enter a whole number.')
    // The whole array still parses as a list.
    expect(parseReviewedValue(schemaNodeAtResultPath(scalarArrays, ['records', 0, 'counts']), '3, 4'))
      .toEqual({ value: [3, 4], error: null })
  })

  it('writes an edited or rejected item at its own index and leaves its siblings alone', () => {
    const original = { records: [{ grave_goods: ['pin', 'bead', 'sherd'] }] }
    const decision = (index: number, action: 'EDITED' | 'REJECTED', reviewedValue: string | null) => ({
      resultPath: ['records', 0, 'grave_goods', index], evidenceAnchorId: `a-${index}`,
      reviewedOccurrenceIds: [`o-${index}`], action, reviewedValue,
    })

    expect(applyReviewDecisions(original, [decision(2, 'EDITED', 'bronze pin, broken'), decision(0, 'REJECTED', null)]))
      .toEqual({ records: [{ grave_goods: [null, 'bead', 'bronze pin, broken'] }] })
    expect(original.records[0]?.grave_goods).toEqual(['pin', 'bead', 'sherd'])
  })
})
