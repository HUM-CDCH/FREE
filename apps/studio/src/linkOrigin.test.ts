import { describe, expect, it } from 'vitest'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { sourceEvidenceLinks } from './evidenceNavigation'
import { linkOrigin } from './linkOrigin'
import { evidenceCheck } from './reviewVocabulary'

describe('who linked a saved value to its Evidence', () => {
  it('names verifier links and rule-made links apart', () => {
    expect(linkOrigin({})).toBe('verifier')
    expect(linkOrigin({ linkedBy: 'lexical' })).toBe('rule')
    expect(linkOrigin({ grounding: { linkedBy: 'verification', support: 'literal', textSpans: [], alternatives: [], precision: 'segment', raw: 'x', itemSpans: null } })).toBe('verifier')
    expect(linkOrigin({ grounding: { linkedBy: 'lexical', support: 'literal', textSpans: [], alternatives: [], precision: 'segment', raw: 'x', itemSpans: null } })).toBe('rule')
    expect(linkOrigin({ grounding: { linkedBy: 'key', provenance: 'token', textSpans: [], keySpans: [], alternatives: [], heading: null, precision: 'segment', raw: 'x', normalized: null } })).toBe('rule')
  })

  it('reads an Article link with a location as the model\'s link, as without one', () => {
    const link: EvidenceLink = { resultPath: ['records', 0, 'site_name'], evidenceAnchorId: 'a_p1_s3', precision: 'segment', verbatim: true }
    const located: EvidenceLink = { ...link, location: { textSpans: [{ segment: 'p1_s3', start: 14, end: 23 }], raw: 'Cedar Bay' } }
    expect(linkOrigin(located)).toBe('verifier')
    expect(evidenceCheck(located)).toBe(evidenceCheck(link))
    expect(sourceEvidenceLinks(located, new Set(['a_p1_s3', 'a_p1_s4']))).toEqual([located])
  })
})
