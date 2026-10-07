import { describe, expect, it } from 'vitest'
import { evidenceLinkSchema, resultPathSchema } from './groundedExtraction'

describe('saved value Evidence links', () => {
  it('requires non-empty paths and nonnegative integer indices', () => {
    expect(resultPathSchema.safeParse([]).success).toBe(false)
    expect(resultPathSchema.safeParse(['records', -1]).success).toBe(false)
    expect(resultPathSchema.safeParse(['records', 0.5]).success).toBe(false)
  })

  it('accepts a producer link with its precision and refuses unknown fields', () => {
    const link = { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_s0', precision: 'segment', verbatim: true, lexicalHits: 1 }
    expect(evidenceLinkSchema.parse(link)).toEqual(link)
    expect(evidenceLinkSchema.safeParse({ ...link, reviewedOccurrenceIds: [] }).success).toBe(false)
  })
})
