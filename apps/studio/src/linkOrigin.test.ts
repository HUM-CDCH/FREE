import { describe, expect, it } from 'vitest'
import { linkOrigin } from './linkOrigin'

describe('who linked a saved value to its Evidence', () => {
  it('names verifier links and rule-made links apart', () => {
    expect(linkOrigin({})).toBe('verifier')
    expect(linkOrigin({ linkedBy: 'lexical' })).toBe('rule')
    expect(linkOrigin({ grounding: { linkedBy: 'verification', support: 'literal', textSpans: [], alternatives: [], precision: 'segment', raw: 'x', itemSpans: null } })).toBe('verifier')
    expect(linkOrigin({ grounding: { linkedBy: 'key', provenance: 'token', textSpans: [], keySpans: [], alternatives: [], heading: null, precision: 'segment', raw: 'x', normalized: null } })).toBe('rule')
  })
})
