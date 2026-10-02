import { extractionReviewDraftSchema, type ReviewDecisionInput } from '../shared/extraction.contract'
import { resultPathKey } from './reviewDecisions'
import { consumeSessionRecovery, registerSessionRecoveryCapture, removeSessionRecovery } from './auth/sessionRecovery'

type ReviewDraft = { version: number; decisions: readonly ReviewDecisionInput[] }
const unsaved = new Map<string, { draft: ReviewDraft; unregister: () => void }>()

/** Register before sending: a 401 captures synchronously, before promise rejection. */
export function rememberReviewDraft(id: string, draft: ReviewDraft) {
  unsaved.get(id)?.unregister()
  const state = { draft, unregister: () => {} }
  state.unregister = registerSessionRecoveryCapture('extraction-review', id, () => state.draft)
  unsaved.set(id, state)
}

export function forgetReviewDraft(id: string) {
  unsaved.get(id)?.unregister()
  unsaved.delete(id)
  removeSessionRecovery('extraction-review', id)
}

export function acknowledgeReviewDraft(id: string, version: number) {
  const state = unsaved.get(id)
  if (state) state.draft.version = version
}

export const REVIEW_DRAFT_CONFLICT = 'The review changed elsewhere. Your recovered changes are retained here. Reload server review to continue.'

export function recoverReviewDraft(id: string, server: ReviewDraft | undefined, prepared: readonly ReviewDecisionInput[]) {
  const local = consumeSessionRecovery('extraction-review', id, (value) => {
    const parsed = extractionReviewDraftSchema.safeParse(value)
    if (!parsed.success) return null
    const expected = new Map(prepared.map((decision) => [resultPathKey(decision.resultPath), decision]))
    const keys = parsed.data.decisions.map((decision) => resultPathKey(decision.resultPath))
    if (new Set(keys).size !== keys.length || parsed.data.decisions.some((decision) => {
      const original = expected.get(resultPathKey(decision.resultPath))
      return !original || original.evidenceAnchorId !== decision.evidenceAnchorId ||
        original.reviewedOccurrenceIds.length !== decision.reviewedOccurrenceIds.length ||
        new Set(decision.reviewedOccurrenceIds).size !== decision.reviewedOccurrenceIds.length ||
        !original.reviewedOccurrenceIds.every((occurrence) => decision.reviewedOccurrenceIds.includes(occurrence))
    })) return null
    return parsed.data
  })
  const canonical = (decisions: readonly ReviewDecisionInput[]) => JSON.stringify(decisions.map((decision) => [
    resultPathKey(decision.resultPath), decision.evidenceAnchorId, [...decision.reviewedOccurrenceIds].sort(), decision.action, decision.reviewedValue, decision.reviewedEvidence,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))), (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)
  const matches = local && canonical(local.decisions) === canonical(server?.decisions ?? [])
  const conflict = Boolean(local && !matches && local.version !== (server?.version ?? 0))
  if (local) {
    forgetReviewDraft(id)
    if (conflict) rememberReviewDraft(id, local)
  }
  return {
    ...restoreReviewDraft(local ?? server, prepared),
    retry: Boolean(local && !matches && !conflict),
    conflict,
    version: conflict ? local!.version : server?.version ?? 0,
  }
}

/** The server stores only explicitly reviewed fields; other fields remain pending. */
export function restoreReviewDraft(
  draft: { decisions: readonly ReviewDecisionInput[] } | undefined,
  prepared: readonly ReviewDecisionInput[],
) {
  const byPath = new Map(draft?.decisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
  return {
    decisions: prepared.map((decision) => byPath.get(resultPathKey(decision.resultPath)) ?? decision),
    touchedPaths: new Set(byPath.keys()),
  }
}
