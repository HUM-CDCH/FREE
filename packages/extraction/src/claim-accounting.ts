import { resultPathKey } from './review-paths.js'
import type { ExtractionAttemptSnapshot, ResultPath } from './types.js'

/** `assembly._UNFINISHED` in the Parsing Service: a claim whose check did not complete in some context it was routed to. */
export const UNFINISHED_CODES: ReadonlySet<string> = new Set([
  'grounding_exceeds_budget', 'call_failed', 'missing_claim', 'unknown_label', 'no_evidence',
])

/** The unfinished codes the non-projected verifier records for a record without a path (`grounding.py`), and the code
 *  each is reported under: a record-level failed call cannot be told from a record-extraction failure, so it is named
 *  neutrally; `no_evidence` keeps its own. */
const RECORD_LEVEL_CODES: ReadonlyMap<string, string> = new Map([
  ['call_failed', 'call_failed_unattributed'], ['no_evidence', 'no_evidence'],
])

/** `assembly.ARTICLE_VERSION` from which Article's verifier names each claim of a failed call (`grounding.verify`'s
 *  `projected`). An Article result stored before it (no recorded version: the Parsing Service on dev; or below it)
 *  records a failed grounding call with its record but without a path, as the generic Catalog verifier does. */
export const ARTICLE_CLAIM_ATTRIBUTION_VERSION = 4

export type ClaimState = 'supported' | 'unsupported' | 'not_completed' | 'excluded'
export type UnfinishedClaim = Readonly<{ resultPath: ResultPath; reasons: readonly string[] }>
/** Every claim (populated record leaf the service grounded or listed ungrounded) once: excluded by a schema evidence
 *  policy, or eligible and then supported (linked), not completed (its distinct reasons, one count per claim) or
 *  unsupported (every check finished, none supported it). The keys and counting are `assembly.grounding_accounting`'s. */
export type ClaimAccounting = Readonly<{
  claims: number; excluded: number; eligible: number; supported: number; unsupported: number; notCompleted: number
  reasons: Readonly<Record<string, number>>
  excludedPolicies: Readonly<Record<string, number>>
  unfinished: readonly UnfinishedClaim[]
}>

const counted = (values: readonly string[]): Record<string, number> => {
  const counts: Record<string, number> = {}
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

/** Null until the attempt has diagnostics and evidence (grounding was reached). Reads only persisted fields: the claim
 *  set is `evidence ∪ ungroundedPaths` (a repeated path is one claim), the same set the review coverage rule holds the
 *  result to. An unfinished check is never reported as unsupported. Where an issue names its path, only that claim is
 *  not completed. The Parsing Service's non-projected verifier (generic Catalog: no `grounded` or `unified` diagnostics)
 *  records a failed call (`call_failed`) and `no_evidence` with its record but without a path; such a failure cannot be
 *  attributed to a value, so every eligible ungrounded claim of that record without unfinished reasons of its own is
 *  marked not completed with it (an understatement, disclosed by its reason). A record-level `call_failed` is reported
 *  as `call_failed_unattributed`: the same issue list carries record-extraction failures it cannot be told from. A
 *  path-less issue without a record (document extraction, discovery windows) attributes nothing. An Article result
 *  whose grounder predates per-claim attribution (`versions.article` absent or below
 *  `ARTICLE_CLAIM_ATTRIBUTION_VERSION`) is read by the same record-level rule: its failed grounding calls carry no path.
 *  From that version on, Article's path-less `call_failed` issues are extraction-stage failures and attribute nothing,
 *  as `assembly.grounding_accounting` reads every path-less issue. */
export function claimAccounting(
  extraction: Pick<ExtractionAttemptSnapshot, 'strategy' | 'evidence' | 'diagnostics'>,
): ClaimAccounting | null {
  const { strategy, evidence, diagnostics } = extraction
  if (!diagnostics || !evidence) return null
  const supportedKeys = new Set(evidence.map((link) => resultPathKey(link.resultPath)))
  const ungroundedByKey = new Map<string, ResultPath>()
  for (const path of diagnostics.ungroundedPaths) {
    const key = resultPathKey(path)
    if (!supportedKeys.has(key) && !ungroundedByKey.has(key)) ungroundedByKey.set(key, path)
  }
  const ungrounded = [...ungroundedByKey.values()]
  // A policy-skipped path excludes a claim only if it is one: `assembly`'s `eligible = claims - excluded.keys()`.
  const claimKeys = new Set([...supportedKeys, ...ungrounded.map(resultPathKey)])
  const excludedBy = new Map((diagnostics.eligibility?.skipped ?? [])
    .map((item) => [resultPathKey(item.resultPath), item.policy] as const)
    .filter(([key]) => claimKeys.has(key)))
  const claims = supportedKeys.size + ungrounded.length
  const supported = [...supportedKeys].filter((key) => !excludedBy.has(key)).length
  const eligibleUngrounded = ungrounded.filter((path) => !excludedBy.has(resultPathKey(path)))
  const article = diagnostics.effectiveMethod?.options.article
  const disabled = typeof article === 'object' && article !== null && (article as { grounding?: unknown }).grounding === 'off'
  const reasonsByKey = new Map<string, Set<string>>()
  if (disabled) {
    for (const path of eligibleUngrounded) reasonsByKey.set(resultPathKey(path), new Set(['grounding_disabled']))
  } else {
    const eligibleKeys = new Set(eligibleUngrounded.map(resultPathKey))
    const genericCatalog = strategy === 'CATALOG' && !diagnostics.grounded && !diagnostics.unified
    const legacyArticle = strategy === 'ARTICLE' &&
      !((diagnostics.effectiveMethod?.versions.article ?? 0) >= ARTICLE_CLAIM_ATTRIBUTION_VERSION)
    const recordLevel = new Map<number, Set<string>>()
    for (const issue of diagnostics.groundingIssues) {
      const code = issue.code
      const path = issue.path
      if (typeof code !== 'string' || !UNFINISHED_CODES.has(code)) continue
      if (!Array.isArray(path)) {
        const record = issue.record
        const reported = RECORD_LEVEL_CODES.get(code)
        if ((genericCatalog || legacyArticle) && reported && typeof record === 'number' && Number.isInteger(record))
          recordLevel.set(record, (recordLevel.get(record) ?? new Set()).add(reported))
        continue
      }
      const key = resultPathKey(path as ResultPath)
      if (!eligibleKeys.has(key)) continue
      reasonsByKey.set(key, (reasonsByKey.get(key) ?? new Set()).add(code))
    }
    for (const path of eligibleUngrounded) {
      const key = resultPathKey(path)
      const codes = path[0] === 'records' && typeof path[1] === 'number' ? recordLevel.get(path[1]) : undefined
      if (codes && !reasonsByKey.has(key)) reasonsByKey.set(key, new Set(codes))
    }
  }
  const unfinished = eligibleUngrounded.flatMap((resultPath) => {
    const reasons = reasonsByKey.get(resultPathKey(resultPath))
    return reasons ? [{ resultPath, reasons: [...reasons].sort() }] : []
  })
  return {
    claims, excluded: excludedBy.size, eligible: claims - excludedBy.size, supported,
    unsupported: claims - excludedBy.size - supported - unfinished.length, notCompleted: unfinished.length,
    reasons: counted(unfinished.flatMap((claim) => claim.reasons)),
    excludedPolicies: counted([...excludedBy.values()]),
    unfinished,
  }
}
