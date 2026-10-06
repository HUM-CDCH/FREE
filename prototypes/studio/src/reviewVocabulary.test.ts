import { expect, it } from 'vitest'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { evidenceCheck } from './reviewVocabulary'

it('a doubtful link: not found, or found elsewhere; none after an edit or rejection', () => {
  expect(evidenceCheck({ verbatim: false })).toBe('Value not found in the linked passage')
  expect(evidenceCheck({ verbatim: true, lexicalHits: 3 })).toBe('Value also appears in 2 other passages')
  expect(evidenceCheck({ verbatim: false }, 'EDITED')).toBeNull()
})

it('says what tied a recipe value to its field, until it is edited or rejected', async () => {
  const { groundingDetail } = await import('./reviewVocabulary')
  const link = { resultPath: ['records', 0, 'sheet'], evidenceAnchorId: 'a', grounding: { linkedBy: 'key', alternatives: [{}], normalized: { value: 'Grab' } } } as unknown as EvidenceLink
  expect(groundingDetail(link)).toBe('Read after its printed key · 1 other match in the entry · glossary: Grab')
  expect(groundingDetail(link, 'EDITED')).toBeNull()
})
