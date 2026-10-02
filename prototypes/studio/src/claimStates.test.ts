import { describe, expect, it } from 'vitest'
import { claimStatuses, describeClaimStatus, fieldLabel } from './claimStates'

const attempt = {
  evidenceLinks: [{ resultPath: ['records', 0, 'items', 0, 'sku'], evidenceAnchorId: 'a_p1_s3_r3_c2' }],
  diagnostics: { grounding: {
    groundedPaths: [], ungroundedPaths: [['records', 0, 'publisher'], ['records', 0, 'items', 86, 'pack_qty'], ['records', 0, 'items', 1, 'description'], ['records', 0, 'notes']],
    issueCodes: [], batches: [],
    claims: { claims: 5, excluded: 1, eligible: 4, supported: 1, unsupported: 1, notCompleted: 2,
      reasons: { grounding_exceeds_budget: 2 }, excludedPolicies: { unverified: 1 },
      unfinished: [{ resultPath: ['records', 0, 'publisher'], reasons: ['grounding_exceeds_budget'] },
        { resultPath: ['records', 0, 'items', 86, 'pack_qty'], reasons: ['grounding_exceeds_budget'] }] },
  }, eligibility: { allRecordLeaves: 5, eligibleRecordLeaves: 4, skipped: [{ resultPath: ['records', 0, 'notes'], policy: 'unverified' }], eligibleGrounding: 'partial' } },
} as const

describe('claim states', () => {
  it('names every claim once from the links, the unfinished list and the skipped paths', () => {
    const states = claimStatuses(attempt as never)
    expect(states.get(JSON.stringify(['records', 0, 'items', 0, 'sku']))).toEqual({ state: 'supported', reasons: [], linkedBy: 'verifier' })
    expect(states.get(JSON.stringify(['records', 0, 'publisher']))).toEqual({ state: 'not_completed', reasons: ['grounding_exceeds_budget'] })
    expect(states.get(JSON.stringify(['records', 0, 'items', 1, 'description']))).toEqual({ state: 'unsupported', reasons: [] })
    expect(states.get(JSON.stringify(['records', 0, 'notes']))).toEqual({ state: 'excluded', reasons: [], policy: 'unverified' })
    expect(states.size).toBe(5)
  })
  it('describes a state without overstating it', () => {
    expect(describeClaimStatus({ state: 'supported', reasons: [] }).label).toBe('Verifier-supported')
    expect(describeClaimStatus({ state: 'not_completed', reasons: ['grounding_exceeds_budget', 'call_failed'] }))
      .toEqual({ label: 'Not completed', detail: 'The check did not finish: its evidence did not fit the model’s context; a verification call failed.' })
    expect(describeClaimStatus({ state: 'not_completed', reasons: ['call_failed_unattributed'] }).detail)
      .toBe('The check did not finish: a call for this record failed and could not be attributed to a value, so its checks may not have finished.')
    expect(describeClaimStatus({ state: 'unsupported', reasons: [] }).detail).toMatch(/none found supporting evidence/)
    expect(describeClaimStatus({ state: 'excluded', reasons: [], policy: 'derived' }).detail).toMatch(/schema policy/)
  })
  it('a supported claim is verifier-linked only when the verifier made its link; code and recipe rules are rule-linked', () => {
    const span = { segment: 'p1_s1', start: 0, end: 1 }
    const recipe = (linkedBy: 'key' | 'structure') => ({ linkedBy, provenance: 'token', textSpans: [span], keySpans: [], alternatives: [], heading: null, precision: 'segment', raw: 'x', normalized: null })
    const links = [
      { resultPath: ['records', 0, 'model'], evidenceAnchorId: 'a1' },
      { resultPath: ['records', 0, 'lexical'], evidenceAnchorId: 'a2', linkedBy: 'lexical' },
      { resultPath: ['records', 0, 'cited'], evidenceAnchorId: 'a3', linkedBy: 'citation_lexical' },
      { resultPath: ['records', 0, 'key'], evidenceAnchorId: 'a4', grounding: recipe('key') },
      { resultPath: ['records', 0, 'structure'], evidenceAnchorId: 'a5', grounding: recipe('structure') },
      { resultPath: ['records', 0, 'verified'], evidenceAnchorId: 'a6', grounding: { linkedBy: 'verification', support: 'literal', textSpans: [span], alternatives: [], precision: 'segment', raw: 'x', itemSpans: null } },
    ]
    const states = claimStatuses({ evidenceLinks: links, diagnostics: null } as never)
    expect(['model', 'lexical', 'cited', 'key', 'structure', 'verified'].map((field) => states.get(JSON.stringify(['records', 0, field]))?.linkedBy))
      .toEqual(['verifier', 'rule', 'rule', 'rule', 'rule', 'verifier'])
  })
  it('describes a rule-linked value as linked by rule, never as verifier-supported', () => {
    expect(describeClaimStatus({ state: 'supported', reasons: [], linkedBy: 'rule' }))
      .toEqual({ label: 'Linked by rule', detail: 'A key or structure rule linked this value; no verifier checked it.' })
    expect(describeClaimStatus({ state: 'supported', reasons: [], linkedBy: 'verifier' }).label).toBe('Verifier-supported')
  })
  it('labels a path as Studio does: 1-based items, dotted fields', () => {
    expect(fieldLabel(['records', 0, 'items', 86, 'pack_qty'], 1)).toBe('items[87].pack_qty')
    expect(fieldLabel(['records', 2, 'site'], 3)).toBe('Item 3 · site')
    expect(fieldLabel(['records', 0, 'publisher'], 1)).toBe('publisher')
    // A path without a records envelope keeps every step.
    expect(fieldLabel(['title'], 1)).toBe('title')
    expect(fieldLabel(['items', 2, 'sku'], 1)).toBe('items[3].sku')
  })
  it('excludes a skipped path only if it is a claim, and a linked skipped claim stays excluded, as the accounting counts it', () => {
    const skipped = { ...attempt, diagnostics: { ...attempt.diagnostics, eligibility: { ...attempt.diagnostics.eligibility, skipped: [
      { resultPath: ['records', 0, 'notes'], policy: 'unverified' },
      { resultPath: ['records', 0, 'items', 0, 'sku'], policy: 'derived' },
      { resultPath: ['records', 0, 'not_a_claim'], policy: 'derived' },
    ] } } }
    const states = claimStatuses(skipped as never)
    expect(states.get(JSON.stringify(['records', 0, 'items', 0, 'sku']))).toEqual({ state: 'excluded', reasons: [], policy: 'derived' })
    expect(states.get(JSON.stringify(['records', 0, 'not_a_claim']))).toBeUndefined()
    expect(states.size).toBe(5)
  })
  it('without a claim accounting, an ungrounded value is not called unsupported: its checks may not have finished', () => {
    const legacy = { ...attempt, diagnostics: { ...attempt.diagnostics, grounding: { ...attempt.diagnostics.grounding, claims: null } } }
    const states = claimStatuses(legacy as never)
    expect(states.get(JSON.stringify(['records', 0, 'items', 1, 'description']))).toBeUndefined()
    expect(states.get(JSON.stringify(['records', 0, 'items', 0, 'sku']))).toEqual({ state: 'supported', reasons: [], linkedBy: 'verifier' })
  })
})
