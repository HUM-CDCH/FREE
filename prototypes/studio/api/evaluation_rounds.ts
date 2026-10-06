import type { ResearcherProjectStore } from 'db'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import { evaluationRoundsResponseSchema } from '../shared/evaluationRound.contract.js'
import { ApiError, json, noStore, noStoreError } from './_http.js'

const ROUTE = '/api/evaluation-rounds'
const LIMIT = 50

/** The developer evaluation surface is registered only when the deployment
 *  turns it on; otherwise the route does not exist. The read still goes through
 *  the owner-scoped store, so an account sees only its own Project Contexts. */
export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
  const handle = async (request: Request): Promise<Response> => {
    try {
      if (process.env.FREE_DEVELOPER_EVAL !== '1') {
        throw new ApiError(404, 'not_found', 'API route not found.')
      }
      const url = new URL(request.url)
      if (url.pathname !== ROUTE || request.method !== 'GET') {
        throw new ApiError(404, 'not_found', 'API route not found.')
      }
      const projectContextId = canonicalUuidSchema.safeParse(
        url.searchParams.get('projectContextId'),
      )
      if (!projectContextId.success) {
        throw new ApiError(422, 'invalid_request', 'projectContextId is required.')
      }
      const rounds = await store.listEvaluationRounds(projectContextId.data, LIMIT)
      if (rounds === null) {
        throw new ApiError(404, 'not_found', 'Project Context was not found.')
      }
      return json(
        evaluationRoundsResponseSchema.parse({
          evaluationRounds: rounds.map((round) => ({
            evaluationRoundId: round.evaluationRoundId,
            projectSpreadsheetVersionId: round.projectSpreadsheetVersionId,
            pipelineRunId: round.pipelineRunId,
            label: round.label,
            status: round.status,
            documents: round.documents,
            pins: round.pins ?? null,
            metrics: round.metrics ?? null,
            failure: round.failure ?? null,
            createdAt: round.createdAt.toISOString(),
            completedAt: round.completedAt?.toISOString() ?? null,
          })),
        }),
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
  return { GET: handle }
}
