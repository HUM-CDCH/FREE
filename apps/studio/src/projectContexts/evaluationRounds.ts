import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import {
  evaluationRoundsResponseSchema,
  type EvaluationRound,
} from '../../shared/evaluationRound.contract.js'

/** The developer evaluation rounds of one owned Project Context, or null when
 *  the deployment does not expose the surface (404) — the panel then hides. */
export async function readEvaluationRounds(
  projectContextId: string,
  signal?: AbortSignal,
): Promise<EvaluationRound[] | null> {
  const response = await authenticatedFetch(
    `/api/evaluation-rounds?projectContextId=${encodeURIComponent(projectContextId)}`,
    { method: 'GET', headers: { accept: 'application/json' }, signal },
  )
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Evaluation rounds request failed (HTTP ${response.status}).`)
  }
  return evaluationRoundsResponseSchema.parse(await response.json()).evaluationRounds
}
