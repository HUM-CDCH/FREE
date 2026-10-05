import { describe, expect, it } from 'vitest'
import type { SchemaNode } from 'extraction/schema'
import { classifyExtractionFields, groundedPathKeySet } from './extractionClassification'
import { countLeafFields } from './fieldCoverage'
import { resultPathKey } from '../shared/groundedExtraction'

const nodes: SchemaNode[] = [
  { id: 'title', name: 'title', type: 'string' },
  { id: 'total', name: 'total', type: 'number' },
  { id: 'tags', name: 'tags', type: 'array', itemType: 'string' },
  {
    id: 'address',
    name: 'address',
    type: 'object',
    children: [
      { id: 'city', name: 'city', type: 'string' },
      { id: 'zip', name: 'zip', type: 'string' },
    ],
  },
  {
    id: 'lineItems',
    name: 'lineItems',
    type: 'array',
    children: [{ id: 'amount', name: 'amount', type: 'number' }],
  },
]

describe('classifyExtractionFields', () => {
  it('classifies a fully grounded result', () => {
    const result = {
      records: [
        {
          title: 'Invoice',
          total: 42,
          tags: ['a', 'b'],
          address: { city: 'NYC', zip: '10001' },
          lineItems: [{ amount: 1 }, { amount: 2 }],
        },
      ],
    }
    const grounded = groundedPathKeySet([
      ['records', 0, 'title'],
      ['records', 0, 'total'],
      ['records', 0, 'tags', 0],
      ['records', 0, 'tags', 1],
      ['records', 0, 'address', 'city'],
      ['records', 0, 'address', 'zip'],
      ['records', 0, 'lineItems', 0, 'amount'],
      ['records', 0, 'lineItems', 1, 'amount'],
    ])

    expect(classifyExtractionFields(nodes, result, grounded)).toEqual({
      grounded: 8,
      ungroundedWithValue: 0,
      missing: 0,
    })
  })

  it('classifies a mixed result: grounded, ungrounded-with-value, and missing together', () => {
    const result = {
      records: [
        {
          title: 'Invoice',
          total: null,
          tags: [],
          address: { city: 'NYC', zip: null },
          lineItems: [{ amount: 1 }, { amount: 2 }],
        },
      ],
    }
    const grounded = groundedPathKeySet([
      ['records', 0, 'address', 'city'],
      ['records', 0, 'lineItems', 0, 'amount'],
    ])

    const counts = classifyExtractionFields(nodes, result, grounded)
    expect(counts).toEqual({ grounded: 2, ungroundedWithValue: 2, missing: 3 })
    expect(counts.grounded + counts.ungroundedWithValue + counts.missing).toBe(7)
  })

  it('counts an empty scalar-array leaf as exactly one missing field', () => {
    const result = { records: [{ title: 'x', total: 1, tags: [], address: { city: 'a', zip: 'b' }, lineItems: [{ amount: 1 }] }] }
    const grounded = groundedPathKeySet([
      ['records', 0, 'title'],
      ['records', 0, 'total'],
      ['records', 0, 'address', 'city'],
      ['records', 0, 'address', 'zip'],
      ['records', 0, 'lineItems', 0, 'amount'],
    ])
    const counts = classifyExtractionFields(nodes, result, grounded)
    expect(counts.missing).toBe(1)
  })

  it('counts each descendant of an absent array-of-objects group as missing exactly once', () => {
    const result = { records: [{ title: 'x', total: 1, tags: ['a'], address: { city: 'a', zip: 'b' } }] }
    const grounded = groundedPathKeySet([
      ['records', 0, 'title'],
      ['records', 0, 'total'],
      ['records', 0, 'tags', 0],
      ['records', 0, 'address', 'city'],
      ['records', 0, 'address', 'zip'],
    ])
    const counts = classifyExtractionFields(nodes, result, grounded)
    // lineItems is entirely absent: its one descendant leaf (amount) counts as missing once,
    // not zero (silently dropped) and not once per some assumed item count.
    expect(counts.missing).toBe(1)
    expect(counts.grounded + counts.ungroundedWithValue + counts.missing).toBe(6)
  })

  it('marks every scalar leaf under a null nested object as missing', () => {
    const result = { records: [{ title: 'x', total: 1, tags: ['a'], address: null, lineItems: [] }] }
    const grounded = groundedPathKeySet([
      ['records', 0, 'title'],
      ['records', 0, 'total'],
      ['records', 0, 'tags', 0],
    ])
    const counts = classifyExtractionFields(nodes, result, grounded)
    // address.city + address.zip missing, plus lineItems' one descendant (amount) missing
    expect(counts.missing).toBe(3)
  })

  it('returns zero counts for an empty/null schema', () => {
    expect(classifyExtractionFields(null, { records: [{ title: 'x' }] }, groundedPathKeySet([]))).toEqual({
      grounded: 0,
      ungroundedWithValue: 0,
      missing: 0,
    })
  })

  it('regression: totals are not reconcilable against the static schema leaf count when data repeats', () => {
    // countLeafFields is schema-only: it counts `lineItems.amount` once regardless of how
    // many actual line items exist. classifyExtractionFields counts one occurrence PER
    // actual item, so the two are never meant to be summed/subtracted against each other —
    // guards against reintroducing the old "fieldCount - grounded - ungrounded" reconciliation.
    const result = {
      records: [
        {
          title: 'Invoice',
          total: 1,
          tags: ['a'],
          address: { city: 'NYC', zip: '10001' },
          lineItems: [{ amount: 1 }, { amount: 2 }, { amount: 3 }],
        },
      ],
    }
    const grounded = groundedPathKeySet([
      ['records', 0, 'title'],
      ['records', 0, 'total'],
      ['records', 0, 'tags', 0],
      ['records', 0, 'address', 'city'],
      ['records', 0, 'address', 'zip'],
      ['records', 0, 'lineItems', 0, 'amount'],
      ['records', 0, 'lineItems', 1, 'amount'],
      ['records', 0, 'lineItems', 2, 'amount'],
    ])
    const counts = classifyExtractionFields(nodes, result, grounded)
    const occurrenceTotal = counts.grounded + counts.ungroundedWithValue + counts.missing
    expect(occurrenceTotal).toBe(8)
    expect(occurrenceTotal).not.toBe(countLeafFields(nodes))
    expect(countLeafFields(nodes)).toBe(6)
  })

  it('resultPathKey matches the format used to build the grounded set (sanity check for the lookup)', () => {
    expect(resultPathKey(['records', 0, 'title'])).toBe(JSON.stringify(['records', 0, 'title']))
  })
})
