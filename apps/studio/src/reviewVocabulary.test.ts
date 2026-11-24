import { expect, it } from 'vitest'
import booleanLiterals from '../../parsing_service/tests/fixtures/boolean-literals.json'
import { evidenceCheck, fieldWords } from './reviewVocabulary'

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
