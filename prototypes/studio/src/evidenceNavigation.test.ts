// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { verifiedEvidenceBbox } from './evidenceNavigation'
import { isBundledSource } from './sourceIdentity'

describe('source-document Evidence navigation', () => {
  it('accepts rotated page-space geometry and rejects unsafe bounds', () => {
    const anchor = { kind: 'text' as const, anchor_id: 'a', occurrence_id: 'o', content_sha256: 'a'.repeat(64), preprocess_id: 'p', page_number: 1, block_id: 'b', markdown_span: { start: 0, end: 1 }, bbox: { x0: 1, y0: 2, x1: 4, y1: 6 } }
    const parsed = { pages: [{ page_number: 1, width_pt: 10, height_pt: 10, rotation: 0 }] } as never
    expect(verifiedEvidenceBbox(parsed, anchor)).toEqual({ x0: 1, y0: 2, x1: 4, y1: 6 })
    expect(verifiedEvidenceBbox(parsed, { ...anchor, bbox: { x0: 1, y0: 2, x1: Number.NaN, y1: 6 } })).toBeNull()
    expect(verifiedEvidenceBbox(parsed, { ...anchor, bbox: { x0: 1, y0: 2, x1: 11, y1: 6 } })).toBeNull()
    expect(verifiedEvidenceBbox({ pages: [{ page_number: 1, width_pt: 10, height_pt: 10, rotation: 90 }] } as never, anchor)).toEqual(anchor.bbox)
  })

  it('does not identify uploaded same-named PDFs as the bundled source', () => {
    expect(isBundledSource({ url: '/bundled.pdf', filename: 'Beretning_Ellekilde_8_13.pdf', bundled: true })).toBe(true)
    expect(isBundledSource({ url: 'blob:upload', filename: 'Beretning_Ellekilde_8_13.pdf', bundled: false })).toBe(false)
  })
})
