import { describe, expect, it } from 'vitest'
import { METHOD_MESSAGES, REFERENCE_ARTICLE } from 'extraction/extraction-method'
import {
  ARTICLE_CONTROL_SECTIONS, effectiveSummary, orderedArticle, orderedCatalog, settingsDelta,
  STARTING_POINTS, unavailableReason, withStartingPoint,
} from './advancedSettings'

describe('current Article controls', () => {
  it('offers the live controls and keeps their validation', () => {
    expect(ARTICLE_CONTROL_SECTIONS.flatMap(section => section.keys)).toEqual([
      'context', 'context_tokens', 'grouping', 'overlap_passages', 'rendering',
      'grounding', 'grounding_overflow', 'evidence_policy',
    ])
    expect(unavailableReason(REFERENCE_ARTICLE, 'overlap_passages', 1)).toBe(METHOD_MESSAGES.bounded)
    expect(unavailableReason(REFERENCE_ARTICLE, 'grouping', 'structural')).toBe(METHOD_MESSAGES.bounded)
    expect(unavailableReason(REFERENCE_ARTICLE, 'evidence_policy', 'schema')).toBe(METHOD_MESSAGES.schemaPolicy)
    expect(unavailableReason({ ...REFERENCE_ARTICLE, grounding: 'off', grounding_overflow: undefined }, 'grounding_overflow', 'windows')).toBe(METHOD_MESSAGES.overflow)
    expect(unavailableReason({ ...REFERENCE_ARTICLE, context: 'bounded', overlap_passages: 1 }, 'context', 'full')).toBeNull()
  })

  it('omits unset factors and keeps a stable key order', () => {
    const on = orderedArticle({ ...REFERENCE_ARTICLE, context: 'bounded', grouping: 'structural' })
    expect(Object.keys(orderedArticle({ ...on, grouping: undefined }))).toEqual(Object.keys(REFERENCE_ARTICLE))
    expect(orderedArticle(Object.fromEntries(Object.entries(REFERENCE_ARTICLE).reverse()))).toEqual(REFERENCE_ARTICLE)
  })

  it('describes the shared default and explicit changes', () => {
    expect(effectiveSummary(undefined)).toBe('Full source · Plain text · Source-label verification · Large checks in windows')
    const next = withStartingPoint(undefined, STARTING_POINTS[1]!)
    expect(next).toMatchObject({ context: 'bounded', grounding: 'spans', evidence_policy: 'schema' })
    expect(settingsDelta(REFERENCE_ARTICLE, next)).toContainEqual({ label: 'Verification', from: 'Source labels', to: 'Source spans' })
  })
})

it('keeps Catalog overrides in option order', () => {
  expect(Object.keys(orderedCatalog({ unified: { headings: false, candidates: 8, overlap: 2 } }).unified!))
    .toEqual(['overlap', 'candidates', 'headings'])
})
