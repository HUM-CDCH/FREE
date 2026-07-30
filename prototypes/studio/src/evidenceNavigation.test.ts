// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { findTextLayerMatch, normalizeEvidenceText, verifiedEvidenceBbox } from './evidenceNavigation'
import { isBundledSource } from './sourceIdentity'

describe('source-document Evidence navigation', () => {
  it('normalizes whitespace and matches text across same-page spans', () => {
    const page = document.createElement('div')
    const layer = document.createElement('div')
    layer.className = 'textLayer'
    for (const text of ['First', '   paragraph ']) {
      const span = document.createElement('span')
      span.textContent = text
      layer.append(span)
    }
    page.append(layer)
    expect(normalizeEvidenceText('First\n paragraph')).toBe('First paragraph')
    expect(findTextLayerMatch(page, 'First paragraph')?.textContent).toBe('   paragraph ')
  })

  it('accepts only finite same-anchor geometry', () => {
    const anchor = { kind: 'text' as const, anchor_id: 'a', content_sha256: 'a'.repeat(64), preprocess_id: 'p', page_number: 1, block_id: 'b', markdown_span: { start: 0, end: 1 }, bbox: { x0: 1, y0: 2, x1: 4, y1: 6 } }
    expect(verifiedEvidenceBbox(anchor)).toEqual({ x0: 1, y0: 2, x1: 4, y1: 6 })
    expect(verifiedEvidenceBbox({ ...anchor, bbox: { x0: 1, y0: 2, x1: Number.NaN, y1: 6 } })).toBeNull()
  })

  it('does not identify uploaded same-named PDFs as the bundled source', () => {
    expect(isBundledSource({ url: '/bundled.pdf', filename: 'Beretning_Ellekilde_8_13.pdf', bundled: true })).toBe(true)
    expect(isBundledSource({ url: 'blob:upload', filename: 'Beretning_Ellekilde_8_13.pdf', bundled: false })).toBe(false)
  })
})
