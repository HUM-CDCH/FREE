import { expect, it } from 'vitest'
import { evidenceCheck, fieldWords } from './reviewVocabulary'

it('an uncertain passage is non-verbatim', () => {
  expect(evidenceCheck({ verbatim: false })).toBe('Not an exact match, please double check')
  expect(evidenceCheck({ verbatim: true })).toBeNull()
  expect(evidenceCheck({})).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'EDITED')).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'REJECTED')).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'APPROVED')).toBe('Not an exact match, please double check')
})

it('reads a field name as words, leaving its path, its acronyms and its capitals alone', () => {
  expect(fieldWords('site_name')).toBe('site name')
  expect(fieldWords('siteName')).toBe('site name')
  expect(fieldWords('graves › 2 › grave_type')).toBe('graves › 2 › grave type')
  expect(fieldWords('ISBN')).toBe('ISBN')
  expect(fieldWords('journalID')).toBe('journalID')
  expect(fieldWords('title')).toBe('title')
})
