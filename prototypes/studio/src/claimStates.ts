import type { ExtractionAttempt } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'

export type ClaimState = 'supported' | 'unsupported' | 'not_completed' | 'excluded'
/** Who linked a supported value to its evidence: the verifier, or a rule (code's lexical match, a recipe's key or
 *  structure). */
export type LinkOrigin = 'verifier' | 'rule'
export type ClaimStatus = Readonly<{ state: ClaimState; reasons: readonly string[]; policy?: string; linkedBy?: LinkOrigin }>

/** A link is the verifier's when a unified Catalog's verification accepted it, or when it carries no rule at all (an
 *  Article model link); `lexical`/`citation_lexical` links and recipe `key`/`structure` links are rule-made. */
export function linkOrigin(link: Pick<EvidenceLink, 'linkedBy' | 'grounding'>): LinkOrigin {
  if (link.grounding) return link.grounding.linkedBy === 'verification' ? 'verifier' : 'rule'
  return link.linkedBy === undefined ? 'verifier' : 'rule'
}

/** The Parsing Service's issue codes for a check that never finished, in the researcher's words. */
const REASONS: Readonly<Record<string, string>> = {
  grounding_exceeds_budget: 'its evidence did not fit the model’s context',
  call_failed: 'a verification call failed',
  call_failed_unattributed: 'a call for this record failed and could not be attributed to a value, so its checks may not have finished',
  missing_claim: 'the verifier did not answer for this value',
  unknown_label: 'the verifier named evidence that was not offered',
  no_evidence: 'no source passage was available to check against',
  grounding_disabled: 'verification was off for this run',
}
export const reasonText = (code: string): string => REASONS[code] ?? code.replaceAll('_', ' ')

/**
 * Every claim's verifier state, keyed by `JSON.stringify(resultPath)`. Without a claim accounting (an attempt the
 * service stored before it), an ungrounded value is left unnamed: whether its checks finished is not known.
 */
export function claimStatuses(attempt: Pick<ExtractionAttempt, 'evidenceLinks' | 'diagnostics'>): ReadonlyMap<string, ClaimStatus> {
  const states = new Map<string, ClaimStatus>()
  const grounding = attempt.diagnostics?.grounding
  for (const { resultPath, policy } of attempt.diagnostics?.eligibility?.skipped ?? [])
    states.set(JSON.stringify(resultPath), { state: 'excluded', reasons: [], policy })
  if (grounding?.claims) {
    for (const { resultPath, reasons } of grounding.claims.unfinished)
      states.set(JSON.stringify(resultPath), { state: 'not_completed', reasons })
    for (const path of grounding.ungroundedPaths) {
      const key = JSON.stringify(path)
      if (!states.has(key)) states.set(key, { state: 'unsupported', reasons: [] })
    }
  }
  for (const link of attempt.evidenceLinks ?? [])
    states.set(JSON.stringify(link.resultPath), { state: 'supported', reasons: [], linkedBy: linkOrigin(link) })
  return states
}

export function describeClaimStatus(status: ClaimStatus): { label: string; detail: string } {
  switch (status.state) {
    case 'supported': return status.linkedBy === 'rule'
      ? { label: 'Linked by rule', detail: 'A key or structure rule linked this value; no verifier checked it.' }
      : { label: 'Verifier-supported', detail: 'The verifier linked source evidence to this value. A reviewer still decides whether it is right.' }
    case 'unsupported': return { label: 'Unsupported', detail: 'Every check finished and none found supporting evidence.' }
    case 'not_completed': return { label: 'Not completed', detail: `The check did not finish: ${status.reasons.map(reasonText).join('; ')}.` }
    case 'excluded': return { label: 'Excluded by policy', detail: `The schema policy “${status.policy ?? 'unverified'}” asked for no verification.` }
  }
}

/** `items[87].pack_qty`; with several records, `Item 3 · site` (1-based, as the Results tab labels them). */
export function fieldLabel(resultPath: readonly (string | number)[], recordCount: number): string {
  const [, record, ...rest] = resultPath
  const field = rest.map((step, index) => typeof step === 'number' ? `[${step + 1}]` : index === 0 ? String(step) : `.${step}`).join('')
  return recordCount > 1 && typeof record === 'number' ? `Item ${record + 1} · ${field}` : field
}
