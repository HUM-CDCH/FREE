import { expect, it } from 'vitest'
import { parseReviewedValue } from './reviewedValue'
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

it('parses scalar types against the producing schema node', () => {
  const [people] = nodes
  const [age, active, kind] = people!.children!
  expect(parseReviewedValue(age!, '12')).toEqual({ value: 12, error: null })
  expect(parseReviewedValue(age!, '12.5').error).toBe('Enter a whole number.')
  expect(parseReviewedValue(age!, ' ').error).toBe('Enter a whole number.')
  expect(parseReviewedValue(active!, 'false')).toEqual({ value: false, error: null })
  expect(parseReviewedValue(kind!, 'C').error).toBe('Choose a value allowed by the pinned schema.')
})
