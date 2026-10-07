import { describe, expect, it } from 'vitest'
import { REFERENCE_ARTICLE, REFERENCE_CATALOG } from 'extraction/extraction-method'
import { methodLines, modelsLine, settingsHeadline } from './methodSummary'

describe('method summaries', () => {
  it('say what was requested, service defaults, or that nothing was recorded', () => {
    expect(settingsHeadline(null)).toBe('Not recorded')
    expect(settingsHeadline({ article: null })).toBe('Service defaults')
    expect(settingsHeadline({ generic: null })).toBe('Service defaults')
    expect(settingsHeadline({ article: { ...REFERENCE_ARTICLE, context: 'bounded', grounding: 'spans' } }))
      .toBe('Bounded source units (12,288 tokens) · Plain text · Source-span verification')
    expect(settingsHeadline({ recipe: REFERENCE_CATALOG.recipe! })).toBe('Input budget 4,096 tokens · Output reserve 1,024 tokens · All factors on')
    expect(settingsHeadline({ recipe: { factors: { glossary: true, headings: true, overlap: true, verification: false } } }))
      .toBe('Input budget service default · Output reserve service default · Off: verification')
    expect(settingsHeadline({ generic: { record_chars: 30000 } })).toBe('Discovery text limit service default · Record text limit 30,000 characters')
  })

  it('list every Article control, leaving the unused ceiling out', () => {
    const lines = methodLines({ article: REFERENCE_ARTICLE })
    expect(lines.map((line) => line.label)).not.toContain('Context ceiling')
    expect(lines).toContainEqual({ label: 'Verification', value: 'Source labels' })
    expect(methodLines({ article: null })).toEqual([])
    expect(modelsLine(null)).toBe('Field values: deployment default · Reasoning: deployment default')
    expect(modelsLine({ fields: 'instruct' })).toBe('Field values: instruct · Reasoning: deployment default')
  })
})
