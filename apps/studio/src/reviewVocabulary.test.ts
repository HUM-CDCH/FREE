import { expect, it } from 'vitest'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { evidenceCheck, fieldWords, passageOnly } from './reviewVocabulary'

it('an uncertain passage is non-verbatim; historical repetition counts never create doubt', () => {
  expect(evidenceCheck({ verbatim: false })).toBe('Value not printed word for word.')
  const historical: EvidenceLink = { resultPath: ['title'], evidenceAnchorId: 'a', verbatim: true, lexicalHits: 12 }
  expect(evidenceCheck(historical)).toBeNull()
  expect(evidenceCheck({ verbatim: true })).toBeNull()
  expect(evidenceCheck({})).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'EDITED')).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'REJECTED')).toBeNull()
  expect(evidenceCheck({ verbatim: false }, 'APPROVED')).toBe('Value not printed word for word.')
})

it('says a link is located to its passage only when no value mark can be drawn; a page or cell link says its own', () => {
  const link = { resultPath: ['title'], evidenceAnchorId: 'a' } as EvidenceLink
  expect(passageOnly(link)).toBe(' · passage only')
  expect(passageOnly({ ...link, precision: 'segment', valueBoxes: [{ x0: 0, y0: 0, x1: 1, y1: 1 }] })).toBe('')
  expect(passageOnly({ ...link, precision: 'input' })).toBe('')
  expect(passageOnly({ ...link, precision: 'cell' })).toBe('')
  expect(passageOnly(null)).toBe('')
})

it('says what tied a recipe value to its field, until it is edited or rejected', async () => {
  const { groundingDetail } = await import('./reviewVocabulary')
  const link = { resultPath: ['records', 0, 'sheet'], evidenceAnchorId: 'a', grounding: { linkedBy: 'key', alternatives: [{}], normalized: { value: 'Grab' } } } as unknown as EvidenceLink
  expect(groundingDetail(link)).toBe('Read after its printed key · 1 other match in the entry · glossary: Grab')
  expect(evidenceCheck({ ...link, verbatim: true })).toBeNull()
  expect(groundingDetail(link, 'EDITED')).toBeNull()
})

it('never calls a single-pass unified link verified', async () => {
  const { groundingDetail } = await import('./reviewVocabulary')
  const located = (support: string) => ({ resultPath: ['records', 0, 'site'], evidenceAnchorId: 'a',
    grounding: { linkedBy: 'lexical', support, textSpans: [], alternatives: [], precision: 'segment', raw: 'x', itemSpans: null } }) as unknown as EvidenceLink
  expect(groundingDetail(located('literal'))).toBe('Located by code; the value is printed in the entry')
  expect(groundingDetail(located('supporting'))).toBe('Located by code in a supporting passage; no verifier checked it')
})

it('reads a field name as words, leaving its path, its acronyms and its capitals alone', () => {
  expect(fieldWords('site_name')).toBe('site name')
  expect(fieldWords('siteName')).toBe('site name')
  expect(fieldWords('graves › 2 › grave_type')).toBe('graves › 2 › grave type')
  expect(fieldWords('ISBN')).toBe('ISBN')
  expect(fieldWords('journalID')).toBe('journalID')
  expect(fieldWords('title')).toBe('title')
})
