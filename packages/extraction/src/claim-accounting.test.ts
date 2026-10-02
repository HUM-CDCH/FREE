import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import contract from '../../../prototypes/parsing_service/tests/fixtures/contracts/article-claims.json' with { type: 'json' }
import { claimAccounting } from './claim-accounting.js'
import { populatedContentPaths, resultPathKey } from './review-paths.js'
import type { ExtractionAttemptSnapshot, ResultPath } from './types.js'

const path = (field: string): ResultPath => ['records', 0, field]
const issue = (code: string, field: string) => ({ code, detail: 'x', record: 0, path: path(field) })
function diagnostics(overrides: Partial<NonNullable<ExtractionAttemptSnapshot['diagnostics']>> = {}) {
  return {
    phase: 'persisting' as const, durationMs: 1, modelCalls: 1, finishReason: null, inputTokens: null, outputTokens: null,
    ungroundedPaths: [], groundingIssues: [], groundingBatches: [], unverifiedFields: [], catalog: null, ...overrides,
  }
}

describe('claim accounting from the persisted Extraction', () => {
  it('counts each claim once with disjoint dispositions, as assembly.grounding_accounting does', () => {
    const accounting = claimAccounting({
      strategy: 'ARTICLE',
      evidence: [{ resultPath: path('a'), evidenceAnchorId: 'a_p1_s0' }],
      diagnostics: diagnostics({
        ungroundedPaths: [path('b'), path('c'), path('d'), path('e')],
        groundingIssues: [issue('grounding_exceeds_budget', 'c'), issue('grounding_exceeds_budget', 'c'),
          issue('call_failed', 'd'), issue('evidence_policy_skipped', 'e')],
        eligibility: { allRecordLeaves: 5, eligibleRecordLeaves: 4, skipped: [{ resultPath: path('e'), policy: 'unverified' }], eligibleGrounding: 'partial' },
      }),
    })
    assert.deepEqual(accounting, {
      claims: 5, excluded: 1, eligible: 4, supported: 1, unsupported: 1, notCompleted: 2,
      reasons: { call_failed: 1, grounding_exceeds_budget: 1 }, excludedPolicies: { unverified: 1 },
      unfinished: [{ resultPath: path('c'), reasons: ['grounding_exceeds_budget'] }, { resultPath: path('d'), reasons: ['call_failed'] }],
    })
  })

  it('ignores a policy-skipped path that is not a claim: neither linked nor listed ungrounded', () => {
    const accounting = claimAccounting({
      strategy: 'ARTICLE',
      evidence: [{ resultPath: path('a'), evidenceAnchorId: 'a_p1_s0' }],
      diagnostics: diagnostics({
        ungroundedPaths: [path('b')],
        eligibility: { allRecordLeaves: 3, eligibleRecordLeaves: 2, skipped: [{ resultPath: path('z'), policy: 'derived' }], eligibleGrounding: 'partial' },
      }),
    })
    assert.deepEqual(accounting, {
      claims: 2, excluded: 0, eligible: 2, supported: 1, unsupported: 1, notCompleted: 0,
      reasons: {}, excludedPolicies: {}, unfinished: [],
    })
  })

  it('with verification off, every eligible claim is not completed for that reason', () => {
    const accounting = claimAccounting({
      strategy: 'ARTICLE',
      evidence: [],
      diagnostics: diagnostics({
        ungroundedPaths: [path('a'), path('b')],
        effectiveMethod: { options: { strategy: 'article', article: { grounding: 'off' } }, versions: { method: 1 } },
      }),
    })
    assert.equal(accounting?.notCompleted, 2)
    assert.deepEqual(accounting?.reasons, { grounding_disabled: 2 })
  })

  it('is null before grounding was reached and never re-walks the result (a boolean leaf is not a claim)', () => {
    assert.equal(claimAccounting({ strategy: 'ARTICLE', evidence: null, diagnostics: null }), null)
    const accounting = claimAccounting({ strategy: 'ARTICLE', evidence: [], diagnostics: diagnostics({ ungroundedPaths: [path('title')] }) })
    assert.equal(accounting?.claims, 1)
  })

  it('does not count a boolean result value the service neither grounded nor listed ungrounded', () => {
    const result = { records: [{ title: 'Alpha', year: 1900, active: true }] }
    const accounting = claimAccounting({
      strategy: 'ARTICLE',
      evidence: [{ resultPath: path('title'), evidenceAnchorId: 'a_p1_s0' }],
      diagnostics: diagnostics({ ungroundedPaths: [path('year')] }),
    })
    assert.equal(accounting?.claims, 2)
    assert.equal(accounting?.supported, 1)
    assert.equal(accounting?.unsupported, 1)
    // finding: the review coverage rule `groundedResultPathKeys` (review-rules.ts) walks `populatedContentPaths`, which
    // lists booleans, while the Parsing Service's `leaves` excludes them; so this `active: true` is outside the claim
    // set here but inside the populated set that rule holds `evidence ∪ ungroundedPaths` to. Not changed in this task.
    assert.ok(populatedContentPaths(result).map(resultPathKey).includes(resultPathKey(path('active'))))
  })

  const pathless = (code: string, record: number | null = null) => ({ code, detail: 'x', record })
  const at = (record: number, field: string): ResultPath => ['records', record, field]

  it('a generic Catalog record-level failed call marks only that record\'s ungrounded claims, under a neutral code', () => {
    const accounting = claimAccounting({
      strategy: 'CATALOG',
      evidence: [{ resultPath: at(0, 'a'), evidenceAnchorId: 'a_p1_s0' }],
      diagnostics: diagnostics({
        ungroundedPaths: [at(0, 'b'), at(0, 'c'), at(1, 'b')], groundingIssues: [pathless('call_failed', 0)],
      }),
    })
    assert.deepEqual(accounting, {
      claims: 4, excluded: 0, eligible: 4, supported: 1, unsupported: 1, notCompleted: 2,
      reasons: { call_failed_unattributed: 2 }, excludedPolicies: {},
      unfinished: [
        { resultPath: at(0, 'b'), reasons: ['call_failed_unattributed'] }, { resultPath: at(0, 'c'), reasons: ['call_failed_unattributed'] },
      ],
    })
  })

  it('a generic Catalog path-less failed call without a record (document or discovery stage) marks nothing', () => {
    const accounting = claimAccounting({
      strategy: 'CATALOG',
      evidence: [],
      diagnostics: diagnostics({
        ungroundedPaths: [at(0, 'b'), at(1, 'b')],
        groundingIssues: [pathless('call_failed', null), { code: 'call_failed', detail: 'x' }, pathless('no_evidence', null)],
      }),
    })
    assert.equal(accounting?.unsupported, 2)
    assert.equal(accounting?.notCompleted, 0)
    assert.deepEqual(accounting?.reasons, {})
  })

  it('a generic Catalog record-level no_evidence keeps its code and leaves other records alone', () => {
    const accounting = claimAccounting({
      strategy: 'CATALOG',
      evidence: [],
      diagnostics: diagnostics({ ungroundedPaths: [at(0, 'b'), at(3, 'b'), at(3, 'c')], groundingIssues: [pathless('no_evidence', 3)] }),
    })
    assert.equal(accounting?.notCompleted, 2)
    assert.equal(accounting?.unsupported, 1)
    assert.deepEqual(accounting?.reasons, { no_evidence: 2 })
    assert.deepEqual(accounting?.unfinished, [
      { resultPath: at(3, 'b'), reasons: ['no_evidence'] }, { resultPath: at(3, 'c'), reasons: ['no_evidence'] },
    ])
  })

  it('a generic Catalog record-level failure leaves policy-excluded claims excluded and a claim with its own reasons as it was', () => {
    const accounting = claimAccounting({
      strategy: 'CATALOG',
      evidence: [],
      diagnostics: diagnostics({
        ungroundedPaths: [path('b'), path('c'), path('d')],
        groundingIssues: [issue('grounding_exceeds_budget', 'c'), pathless('no_evidence', 0), pathless('call_failed', 0)],
        eligibility: { allRecordLeaves: 3, eligibleRecordLeaves: 2, skipped: [{ resultPath: path('d'), policy: 'derived' }], eligibleGrounding: 'partial' },
      }),
    })
    assert.deepEqual(accounting?.unfinished, [
      { resultPath: path('b'), reasons: ['call_failed_unattributed', 'no_evidence'] }, { resultPath: path('c'), reasons: ['grounding_exceeds_budget'] },
    ])
    assert.equal(accounting?.excluded, 1)
    assert.equal(accounting?.unsupported, 0)
  })

  it('a projected Catalog attempt keeps the path rule: its path-less issues attribute nothing', () => {
    const accounting = claimAccounting({
      strategy: 'CATALOG',
      evidence: [],
      diagnostics: diagnostics({
        ungroundedPaths: [path('b')], groundingIssues: [pathless('call_failed', 0)],
        unified: {} as NonNullable<ExtractionAttemptSnapshot['diagnostics']>['unified'],
      }),
    })
    assert.equal(accounting?.unsupported, 1)
    assert.equal(accounting?.notCompleted, 0)
  })

  it('an Article attempt keeps the path rule: a path-less failed call is an extraction-stage failure', () => {
    const accounting = claimAccounting({
      strategy: 'ARTICLE',
      evidence: [],
      diagnostics: diagnostics({ ungroundedPaths: [path('b'), path('c')], groundingIssues: [pathless('call_failed', 0)] }),
    })
    assert.equal(accounting?.unsupported, 2)
    assert.equal(accounting?.notCompleted, 0)
    assert.deepEqual(accounting?.reasons, {})
  })

  it('counts a repeated ungrounded path as one claim', () => {
    const accounting = claimAccounting({
      strategy: 'ARTICLE',
      evidence: [],
      diagnostics: diagnostics({ ungroundedPaths: [path('b'), path('b'), path('c')], groundingIssues: [issue('call_failed', 'b')] }),
    })
    assert.equal(accounting?.claims, 2)
    assert.equal(accounting?.eligible, 2)
    assert.equal(accounting?.notCompleted, 1)
    assert.equal(accounting?.unsupported, 1)
    assert.deepEqual(accounting?.unfinished, [{ resultPath: path('b'), reasons: ['call_failed'] }])
  })

  it('agrees with the Parsing Service on its pinned mixed-state artifact', () => {
    const accounting = claimAccounting({
      strategy: 'ARTICLE',
      evidence: contract.evidence.map((link) => ({ resultPath: link.path as ResultPath, evidenceAnchorId: `a_${link.segment}` })),
      diagnostics: diagnostics({
        ungroundedPaths: contract.ungrounded as ResultPath[],
        groundingIssues: contract.issues,
        eligibility: {
          allRecordLeaves: contract.grounding_eligibility.all_record_leaves,
          eligibleRecordLeaves: contract.grounding_eligibility.eligible_record_leaves,
          skipped: contract.grounding_eligibility.skipped.map(({ path, policy }) => ({ resultPath: path as ResultPath, policy: policy as 'derived' | 'unverified' })),
          eligibleGrounding: 'partial',
        },
      }),
    })
    const { unfinished, ...counts } = accounting!
    assert.deepEqual(counts, {
      claims: contract.grounding.claims, excluded: contract.grounding.excluded, eligible: contract.grounding.eligible,
      supported: contract.grounding.supported, unsupported: contract.grounding.unsupported,
      notCompleted: contract.grounding.not_completed, reasons: contract.grounding.reasons,
      excludedPolicies: contract.grounding.excluded_policies,
    })
    assert.equal(unfinished.length, contract.grounding.not_completed)
  })
})
