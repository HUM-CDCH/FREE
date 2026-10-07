import { describe, expect, it } from 'vitest'
import { fieldTypeWords } from './fieldTypeWords'

describe('fieldTypeWords', () => {
  it('says scalar types in words', () => {
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'string' })).toBe('string')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'verbatim-string' })).toBe('verbatim')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'number' })).toBe('number')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'boolean' })).toBe('boolean')
  })
  it('lists and groups', () => {
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', itemType: 'string' })).toBe('list of strings')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', itemType: 'date' })).toBe('list of dates')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', itemType: 'verbatim-string' })).toBe('list of verbatim strings')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'array', children: [] })).toBe('list of objects')
    expect(fieldTypeWords({ id: 'a', name: 'a', type: 'object', children: [] })).toBe('object')
  })
})
