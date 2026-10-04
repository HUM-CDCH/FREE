import type { ReviewDecisionInput } from '../shared/extraction.contract'
import { resultPathKey } from './reviewDecisions'

type Path = readonly (string | number)[]

function valueAt(result: unknown, path: Path): unknown {
  return path.reduce<unknown>((value, step) =>
    value !== null && typeof value === 'object' ? (value as Record<string | number, unknown>)[step] : undefined, result)
}

/**
 * Reconciles a Review Draft drafted while the Extraction ran with its settled result (results review redesign §5.3;
 * ADR 0016). The server keeps a decision only when the settled Evidence links its path to the same anchor and reports
 * the rest as `dropped`; the session adds the value rule: a decision made here during the run is kept only when the
 * settled value equals the value it was made on. A decision not kept returns to To check, marked changed.
 */
export function reconcileAtSettlement({ recovered, prepared, result, decidedOn, dropped }: {
  recovered: { decisions: readonly ReviewDecisionInput[]; touchedPaths: ReadonlySet<string> }
  prepared: readonly ReviewDecisionInput[]
  result: unknown
  decidedOn: ReadonlyMap<string, unknown>
  dropped: readonly { resultPath: Path; evidenceAnchorId?: string | null }[]
}) {
  const changed = new Set(dropped.map((each) => resultPathKey(each.resultPath)))
  for (const decision of recovered.decisions) {
    const key = resultPathKey(decision.resultPath)
    if (recovered.touchedPaths.has(key) && decidedOn.has(key) &&
      JSON.stringify(valueAt(result, decision.resultPath)) !== JSON.stringify(decidedOn.get(key))) changed.add(key)
  }
  const defaults = new Map(prepared.map((decision) => [resultPathKey(decision.resultPath), decision]))
  const touchedPaths = new Set([...recovered.touchedPaths].filter((key) => !changed.has(key)))
  return {
    decisions: recovered.decisions.map((decision) => {
      const key = resultPathKey(decision.resultPath)
      return changed.has(key) ? defaults.get(key) ?? decision : decision
    }),
    touchedPaths,
    kept: touchedPaths.size,
    changed,
  }
}
