import type { ReviewDecisionInput } from '../shared/extraction.contract'

type Path = ReviewDecisionInput['resultPath']
type SetDecision = (resultPath: Path, action: ReviewDecisionInput['action'], reviewedValue: ReviewDecisionInput['reviewedValue'],
  reviewedEvidence: ReviewDecisionInput['reviewedEvidence'], touch: boolean) => unknown

/** What a value was before one decision (results review redesign §3.4): enough to put it back. */
export type HistoryEntry = Readonly<{
  resultPath: Path
  before: Readonly<{ action: ReviewDecisionInput['action']; reviewedValue: ReviewDecisionInput['reviewedValue']; touched: boolean }>
}>

/** The session's decisions, newest last; every decision, an undo included, pushes one entry, so Z undoes the undo. */
export function recordDecision(history: readonly HistoryEntry[], decision: ReviewDecisionInput, touched: boolean): HistoryEntry[] {
  return [...history, { resultPath: decision.resultPath, before: { action: decision.action, reviewedValue: decision.reviewedValue, touched } }]
}

/** Restores the newest entry's value and decision (untouched when it was untouched); null with nothing to undo. */
export function undoLast(history: readonly HistoryEntry[], setDecision: SetDecision): { history: HistoryEntry[]; entry: HistoryEntry } | null {
  const entry = history.at(-1)
  if (!entry) return null
  setDecision(entry.resultPath, entry.before.action, entry.before.action === 'EDITED' ? entry.before.reviewedValue : null, null, entry.before.touched)
  return { history: history.slice(0, -1), entry }
}
