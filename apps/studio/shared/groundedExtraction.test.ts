import { describe, expect, it } from 'vitest'
import { evidenceLinkSchema, resultPathSchema } from './groundedExtraction'

describe('saved value Evidence links', () => {
  it('requires non-empty paths and nonnegative integer indices', () => {
    expect(resultPathSchema.safeParse([]).success).toBe(false)
    expect(resultPathSchema.safeParse(['records', -1]).success).toBe(false)
    expect(resultPathSchema.safeParse(['records', 0.5]).success).toBe(false)
  })

  it('accepts a producer link with its precision and refuses unknown fields', () => {
    const link = { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_s0', precision: 'segment', verbatim: true }
    expect(evidenceLinkSchema.parse(link)).toEqual(link)
    expect(evidenceLinkSchema.safeParse({ ...link, reviewedOccurrenceIds: [] }).success).toBe(false)
  })

  it('accepts an Article link\'s location as one span and its printed text, and nothing else', () => {
    const span = { segment: 'p1_s3', start: 14, end: 23 }
    const link = { resultPath: ['records', 0, 'site_name'], evidenceAnchorId: 'a_p1_s3', precision: 'segment', verbatim: true,
      location: { textSpans: [span], raw: 'Cedar Bay' } }
    expect(evidenceLinkSchema.parse(link)).toEqual(link)
    for (const location of [{ textSpans: [], raw: 'Cedar Bay' }, { textSpans: [span, span], raw: 'Cedar Bay' }, { textSpans: [span], raw: '' },
      { spans: [span], raw: 'Cedar Bay' }, { textSpans: [span], raw: 'Cedar Bay', boxes: [] }, { textSpans: [{ ...span, page: 1 }], raw: 'Cedar Bay' }])
      expect(evidenceLinkSchema.safeParse({ ...link, location }).success).toBe(false)
  })
})
