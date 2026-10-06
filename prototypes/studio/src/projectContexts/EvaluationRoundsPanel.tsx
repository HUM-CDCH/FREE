import { useEffect, useState } from 'react'
import type { EvaluationRound } from '../../shared/evaluationRound.contract.js'
import { readEvaluationRounds } from './evaluationRounds.js'

function number(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(3) : '—'
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** The developer evaluation metrics a round's `metrics` JSON carries, or nulls
 *  while a round is still pending or failed before scoring. */
function summary(round: EvaluationRound) {
  const metrics = record(round.metrics)
  const micro = record(metrics.micro)
  const coverage = record(metrics.anchor_coverage)
  const effort = record(metrics.reviewer_effort)
  return {
    precision: number(micro.precision),
    recall: number(micro.recall),
    f1: number(micro.f1),
    coverage: number(coverage.eligible_link_rate),
    effort: typeof effort.effort === 'number' ? String(effort.effort) : '—',
  }
}

/** Read-only developer panel: the three evaluation rounds and their metrics.
 *  It renders nothing when the deployment does not expose the surface or the
 *  Project Context has no rounds, so it is inert with the switch off. */
export function EvaluationRoundsPanel({ projectContextId }: { projectContextId: string }) {
  const [rounds, setRounds] = useState<EvaluationRound[] | null>(null)

  useEffect(() => {
    if (!projectContextId) return
    const controller = new AbortController()
    readEvaluationRounds(projectContextId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setRounds(value)
      })
      .catch(() => {
        if (!controller.signal.aborted) setRounds(null)
      })
    return () => controller.abort()
  }, [projectContextId])

  if (!rounds || rounds.length === 0) return null

  return (
    <section
      aria-labelledby="evaluation-rounds-title"
      className="rounded-card border border-line bg-surface p-4"
    >
      <h2 id="evaluation-rounds-title" className="text-section font-semibold text-ink">
        Developer evaluation
      </h2>
      <p className="mt-1 text-compact text-ink-muted">
        Automatic pipeline results. Coverage is evidence-anchor coverage, not semantic correctness.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-compact">
          <thead className="text-ink-muted">
            <tr>
              <th className="py-1 pr-3">Round</th>
              <th className="py-1 pr-3">Status</th>
              <th className="py-1 pr-3">P</th>
              <th className="py-1 pr-3">R</th>
              <th className="py-1 pr-3">F1</th>
              <th className="py-1 pr-3">Anchor coverage</th>
              <th className="py-1 pr-3">Edits</th>
              <th className="py-1 pr-3">Gold version</th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((round) => {
              const values = summary(round)
              return (
                <tr key={round.evaluationRoundId} className="border-t border-line">
                  <td className="py-1 pr-3 font-medium text-ink">{round.label}</td>
                  <td className="py-1 pr-3 text-ink-muted">{round.status}</td>
                  <td className="py-1 pr-3">{values.precision}</td>
                  <td className="py-1 pr-3">{values.recall}</td>
                  <td className="py-1 pr-3">{values.f1}</td>
                  <td className="py-1 pr-3">{values.coverage}</td>
                  <td className="py-1 pr-3">{values.effort}</td>
                  <td className="py-1 pr-3 font-mono text-ink-muted">
                    {round.projectSpreadsheetVersionId?.slice(0, 8) ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
