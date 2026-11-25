import { expect, it } from 'vitest'
import booleanLiterals from '../../parsing_service/tests/fixtures/boolean-literals.json'
import { evidenceCheck, fieldWords, itemCount, reviewedValueSummary } from './reviewVocabulary'
import type { SchemaNode } from 'extraction/schema'

it('an uncertain passage is non-verbatim', () => {
  expect(evidenceCheck({ verbatim: false })).toBe('Not an exact match, please double check')
  expect(evidenceCheck({ verbatim: true })).toBeNull()
  expect(evidenceCheck({})).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'EDITED')).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'REJECTED')).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'APPROVED')).toBe('Not an exact match, please double check')
})

it.each(booleanLiterals)('agrees with Catalog on the printed boolean in "$text"', ({text, value, literal}) => {
  const hint = evidenceCheck({verbatim: false}, undefined, value, text)
  expect(hint === null).toBe(literal)
})

it('reads a field name as words, leaving its path, its acronyms and its capitals alone', () => {
  expect(fieldWords('site_name')).toBe('site name')
  expect(fieldWords('siteName')).toBe('site name')
  expect(fieldWords('graves › 2 › grave_type')).toBe('graves › 2 › grave type')
  expect(fieldWords('ISBN')).toBe('ISBN')
  expect(fieldWords('journalID')).toBe('journalID')
  expect(fieldWords('title')).toBe('title')
})

it('shows a list or group by its contents, with a list\'s count beside its name', () => {
  const people: SchemaNode = { id: 'people', name: 'people', type: 'array', children: [
    { id: 'name', name: 'name', type: 'string' }, { id: 'born', name: 'born', type: 'integer' }, { id: 'note', name: 'note', type: 'string' }] }
  expect(reviewedValueSummary(people, [{ name: 'Anna Jensen', born: 1852, note: null }, { name: 'Peter', born: null, note: '' }]))
    .toBe('Anna Jensen · 1852; Peter')
  expect(reviewedValueSummary({ id: 'tags', name: 'tags', type: 'array', itemType: 'string' }, ['oak', 'ash'])).toBe('oak, ash')
  expect(reviewedValueSummary(people, [])).toBe('No value')
  const place: SchemaNode = { id: 'place', name: 'place', type: 'object', children: [
    { id: 'parish_name', name: 'parish_name', type: 'string' }, { id: 'farms', name: 'farms', type: 'array', itemType: 'string' }] }
  expect(reviewedValueSummary(place, { parish_name: 'Vor Frue', farms: ['Nørgaard'] })).toBe('parish name: Vor Frue · farms: Nørgaard')
  expect(itemCount(['oak', 'ash'])).toBe('2 items')
  expect(itemCount(['oak'])).toBe('1 item')
  expect(itemCount([])).toBeNull()
  expect(itemCount({ a: 1 })).toBeNull()
})
