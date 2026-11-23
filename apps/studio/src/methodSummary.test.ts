import { describe, expect, it } from 'vitest'
import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
import { methodLines, modelsLine, settingsHeadline, unifiedLines } from './methodSummary'

describe('method summaries', () => {
  it('say what was requested, marking the service defaults', () => {
    expect(settingsHeadline({ article: REFERENCE_ARTICLE })).toBe('Service defaults · Full source · Plain text · Source-label verification · Large checks in windows')
    expect(settingsHeadline({ article: { ...REFERENCE_ARTICLE, context: 'bounded', grounding: 'spans' } }))
      .toBe('Bounded source units (12,288 tokens) · Plain text · Source-span verification · Large checks in windows')
  })

  it('list every Article control, leaving the unused ceiling out', () => {
    expect(methodLines({ article: REFERENCE_ARTICLE })).toContainEqual({ label: 'Large checks', value: 'Check in windows' })
    const lines = methodLines({ article: REFERENCE_ARTICLE })
    expect(lines.map((line) => line.label)).not.toContain('Context ceiling')
    expect(lines).toContainEqual({ label: 'Verification', value: 'Source labels' })
    expect(modelsLine(null)).toBe('Field values: deployment default · Reasoning: deployment default')
    expect(modelsLine({ fields: 'instruct' })).toBe('Field values: instruct · Reasoning: deployment default')
  })
})


it('shows the heading candidate ceiling as the service default and with saved overrides', () => {
  expect(unifiedLines({ defaults: 12 })).toContainEqual({ label: 'Heading excerpts measured', value: 'service default (32 excerpts)' })
  expect(unifiedLines({ defaults: 12, candidates: 1 })).toContainEqual({ label: 'Heading excerpts measured', value: '1 excerpt' })
  expect(settingsHeadline({ unified: { defaults: 12 } })).toBe('Unified Catalog, defaults version 12')
})
