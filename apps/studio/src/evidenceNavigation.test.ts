// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { anchorOccurrences, sourceEvidenceLinks, verifiedEvidenceBbox } from './evidenceNavigation'

describe('source-document Evidence navigation', () => {
  it('opens attribution context without copying value highlights onto it', () => {
    const link = { resultPath: ['records', 0, 'country'], evidenceAnchorId: 'a_p1_s1', precision: 'segment' as const,
      contextSpans: [{ segment: 'p1_s0', start: 0, end: 12 }, { segment: 'p1_s0', start: 15, end: 20 }],
      valueBoxes: [{ x0: 1, y0: 2, x1: 3, y1: 4 }],
      location: { textSpans: [{ segment: 'p1_s1', start: 1, end: 4 }], raw: 'UK' } }
    const result = sourceEvidenceLinks(link, new Set(['a_p1_s0', 'a_p1_s1']))
    expect(result).toHaveLength(2)
    expect(result[0]).toBe(link)
    expect(result[1].evidenceAnchorId).toBe('a_p1_s0')
    expect(result[1].valueBoxes).toBeUndefined()
    expect(result[1].location).toBeUndefined()
    expect(result[1].contextOnly).toBe(true)
  })
  it('accepts rotated page-space geometry and rejects unsafe bounds', () => {
    const anchor = { kind: 'text' as const, anchor_id: 'a', content_sha256: 'a'.repeat(64), preprocess_id: 'p', block_id: 'b', markdown_span: { start: 0, end: 1 }, producer_observations: [{ occurrence_id: 'o', page_number: 1, producer_ref: '#/texts/1', bbox: { x0: 1, y0: 2, x1: 4, y1: 6 } }] }
    const occurrence = anchor.producer_observations[0]
    const parsed = { pages: [{ page_number: 1, width_pt: 10, height_pt: 10, rotation: 0 }] } as never
    expect(verifiedEvidenceBbox(parsed, occurrence)).toEqual({ x0: 1, y0: 2, x1: 4, y1: 6 })
    expect(verifiedEvidenceBbox(parsed, { ...occurrence, bbox: { x0: 1, y0: 2, x1: Number.NaN, y1: 6 } })).toBeNull()
    expect(verifiedEvidenceBbox(parsed, { ...occurrence, bbox: { x0: 1, y0: 2, x1: 11, y1: 6 } })).toBeNull()
    expect(verifiedEvidenceBbox({ pages: [{ page_number: 1, width_pt: 10, height_pt: 10, rotation: 90 }] } as never, occurrence)).toEqual(occurrence.bbox)
  })

  it('keeps every page-scoped occurrence for text spanning pages', () => {
    const anchor = { kind: 'text' as const, producer_observations: [
      { occurrence_id: 'page-1', page_number: 1 },
      { occurrence_id: 'page-2', page_number: 2 },
    ] } as never
    expect(anchorOccurrences(anchor).map((item) => item.page_number)).toEqual([1, 2])
  })
})
