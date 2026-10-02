import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { articleSettingsIssues, METHOD_MESSAGES, REFERENCE_ARTICLE, type ArticleSettings } from 'extraction/extraction-method'
import {
  ARTICLE_CHOICES, changedSections, effectiveSummary, orderedArticle, sectionSummary,
  settingsDelta, STARTING_POINTS, unavailableReason, withStartingPoint, type ArticleKey,
} from './advancedSettings'

const inventory = JSON.parse(readFileSync(new URL(
  '../../../parsing_service/tests/fixtures/contracts/article-options.json', import.meta.url), 'utf8')).inventory as {
  context_tokens: number; identity_fields: string[]; factors: Record<string, unknown[]>; verdicts: string }

/** The order a researcher would set choices in: parents before the children they enable. */
const ORDER: readonly ArticleKey[] = ['context', 'context_tokens', 'identity_fields', 'identity', 'prompt', 'rendering', 'grounding',
  'grounding_schedule', 'evidence_policy', 'grounding_routing', 'selection', 'grouping', 'overlap_passages']

function* inputs(): Generator<Record<string, unknown>> {
  const names = Object.keys(inventory.factors)
  const walk = function* (index: number, chosen: Record<string, unknown>): Generator<Record<string, unknown>> {
    if (index === names.length) {
      yield { ...chosen, context_tokens: inventory.context_tokens,
        identity_fields: chosen.identity === 'conservative' ? inventory.identity_fields : [] }
      return
    }
    for (const value of inventory.factors[names[index]!]!) yield* walk(index + 1, { ...chosen, [names[index]!]: value })
  }
  yield* walk(0, {})
}

describe('every categorical combination through the Advanced controls', () => {
  it('each accepted one is reachable without a disabled choice; each refused one ends disabled or blocked', () => {
    let index = 0
    for (const target of inputs()) {
      let draft: ArticleSettings = REFERENCE_ARTICLE
      let disabled = false
      for (const key of ORDER) {
        const value = (target[key] ?? undefined) as never
        if (unavailableReason(draft, key, value) !== null) disabled = true
        draft = orderedArticle({ ...draft, [key]: value })
      }
      const accepted = inventory.verdicts[index] === '1'
      if (accepted) expect({ index, disabled, issues: articleSettingsIssues(draft) }).toEqual({ index, disabled: false, issues: [] })
      else expect(disabled || articleSettingsIssues(draft).length > 0, `#${index}`).toBe(true)
      index += 1
    }
    expect(index).toBe(6144)
  })
})

describe('choices', () => {
  it('a new incompatible choice is disabled with the design reason; the selected one never is', () => {
    expect(unavailableReason(REFERENCE_ARTICLE, 'overlap_passages', 1)).toBe(METHOD_MESSAGES.bounded)
    expect(unavailableReason(REFERENCE_ARTICLE, 'selection', 'supported')).toBe(METHOD_MESSAGES.bounded)
    expect(unavailableReason(REFERENCE_ARTICLE, 'grouping', 'structural')).toBe(METHOD_MESSAGES.bounded)
    expect(unavailableReason(REFERENCE_ARTICLE, 'evidence_policy', 'schema')).toBe(METHOD_MESSAGES.schemaPolicy)
    expect(unavailableReason({ ...REFERENCE_ARTICLE, grounding: 'off' }, 'grounding_schedule', 'unresolved')).toBe(METHOD_MESSAGES.schedule)
    expect(unavailableReason({ ...REFERENCE_ARTICLE, grounding: 'spans' }, 'grounding_routing', 'origin_lexical')).toBe(METHOD_MESSAGES.routing)
    // A parent change that breaks a child stays available: the child is kept and shown invalid instead.
    expect(unavailableReason({ ...REFERENCE_ARTICLE, context: 'bounded', overlap_passages: 1 }, 'context', 'full')).toBeNull()
    expect(unavailableReason({ ...REFERENCE_ARTICLE, overlap_passages: 1 }, 'overlap_passages', 1)).toBeNull()
    expect(ARTICLE_CHOICES.grounding.map((choice) => choice.label)).toEqual(['Source labels', 'Generated quotes', 'Source spans', 'Off'])
  })

  it('an optional factor switched off leaves no key behind, in ArticleOptions order', () => {
    const on = orderedArticle({ ...REFERENCE_ARTICLE, context: 'bounded', grouping: 'structural' })
    expect(Object.keys(orderedArticle({ ...on, grouping: undefined }))).toEqual(Object.keys(REFERENCE_ARTICLE))
    const reversed = Object.fromEntries(Object.entries(REFERENCE_ARTICLE).reverse())
    expect(JSON.stringify(orderedArticle(reversed))).toBe(JSON.stringify(REFERENCE_ARTICLE))
  })
})

describe('summaries', () => {
  it('service defaults and the explicit reference read as the documented reference', () => {
    expect(effectiveSummary(undefined)).toBe('Full source · Plain text · Source-label verification')
    expect(effectiveSummary(REFERENCE_ARTICLE)).toBe('Full source · Plain text · Source-label verification')
    expect(sectionSummary(REFERENCE_ARTICLE, 'context')).toBe('Full source')
    // Retired settings never reach a summary: they no longer describe what Article does.
    expect(sectionSummary(REFERENCE_ARTICLE, 'identity')).toBe('Not used by Article')
    expect(sectionSummary(REFERENCE_ARTICLE, 'input')).toBe('Plain text')
    expect(sectionSummary(REFERENCE_ARTICLE, 'evidence')).toBe('Source labels · All fields')
  })

  it('inactive values never reach a summary', () => {
    const full = { ...REFERENCE_ARTICLE, context_tokens: 16384 }
    expect(sectionSummary(full, 'context')).toBe('Full source')
    const spans = withStartingPoint(undefined, STARTING_POINTS[1]!)
    expect(effectiveSummary(spans)).toBe('Bounded source units (12,288 tokens) · Plain text · Source-span verification')
    expect(sectionSummary(spans, 'evidence')).toBe('Source spans · Schema policies')
    expect(sectionSummary({ ...spans, identity: 'conservative', identity_fields: ['species', 'preparation'] }, 'identity'))
      .toBe('Not used by Article')
    expect(sectionSummary({ ...spans, selection: 'supported' }, 'context')).toBe('Bounded · 12,288 tokens')
    expect(sectionSummary({ ...spans, prompt: 'schema' }, 'input')).toBe('Plain text')
  })

  it('a section is Changed only when one of its values differs from the saved settings', () => {
    expect(changedSections(REFERENCE_ARTICLE, undefined)).toEqual(new Set())
    expect(changedSections({ ...REFERENCE_ARTICLE, grounding: 'spans' }, REFERENCE_ARTICLE)).toEqual(new Set(['evidence']))
    expect(changedSections({ ...REFERENCE_ARTICLE, context_tokens: 16384 }, REFERENCE_ARTICLE)).toEqual(new Set())
  })
})

describe('starting points', () => {
  it('assign exactly the documented values, keep identity fields, and carry no preset identity', () => {
    const declared = { ...REFERENCE_ARTICLE, identity_fields: ['species'] }
    const explore = withStartingPoint(declared, STARTING_POINTS[1]!)
    expect(explore).toEqual({
      context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: ['species'],
      prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema',
    })
    expect(withStartingPoint(explore, STARTING_POINTS[0]!)).toEqual({ ...REFERENCE_ARTICLE, identity_fields: ['species'] })
    expect(JSON.stringify(explore)).not.toMatch(/preset|"name"|"id"/)
  })

  it('the delta lists every changed setting, from service defaults too', () => {
    expect(settingsDelta(undefined, withStartingPoint(undefined, STARTING_POINTS[1]!))).toEqual([
      { label: 'Article settings', from: 'Service defaults', to: 'Customized' },
      { label: 'Scope', from: 'Full source', to: 'Bounded source units' },
      { label: 'Context ceiling', from: 'Used with bounded source units', to: '12,288 tokens' },
      { label: 'Instructions', from: 'Reference', to: 'Schema-driven' },
      { label: 'Verification', from: 'Source labels', to: 'Source spans' },
      { label: 'Fields to verify', from: 'All populated record fields', to: 'Follow schema policies' },
      { label: 'Continue verification', from: 'Across all source units', to: 'Until first support' },
    ])
    expect(settingsDelta(REFERENCE_ARTICLE, REFERENCE_ARTICLE)).toEqual([])
  })
})
