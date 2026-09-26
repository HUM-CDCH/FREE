import type { ResearcherProjectStore } from 'db'
import {
  modelProbeRequestSchema,
  type DeploymentModels,
  type ModelConnection,
} from '../shared/modelConfig.contract.js'
import { DEPLOYMENT_IDS, deploymentModels } from './_deployment_models.js'
import { ApiError, apiErrorResponse, json, parseJsonRequest } from './_http.js'
import { parseModelProbeRequest } from './_model_config.js'
import { probeConnection, type ProviderProbeDependencies } from './_provider.js'

export type ModelProbeDependencies = ProviderProbeDependencies & {
  deployment?: () => DeploymentModels
}

/**
 * A deployment connection is probed at the address the server knows, never at
 * one the client sends, and without a key.
 */
function deploymentProbe(value: unknown, dependencies: ModelProbeDependencies): ModelConnection | null {
  const body = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const connection = body.connection && typeof body.connection === 'object'
    ? (body.connection as Record<string, unknown>)
    : {}
  if (typeof connection.id !== 'string' || !DEPLOYMENT_IDS.has(connection.id)) return null
  // The same structural contract as any probe; only the reserved-ID rule differs.
  if (!modelProbeRequestSchema.safeParse(value).success) parseModelProbeRequest(value)
  if (Object.hasOwn(body, 'credential')) {
    throw new ApiError(409, 'invalid_model_config', 'Deployment connections take no credential.')
  }
  const served = (dependencies.deployment ?? deploymentModels)().connections.find(({ id }) => id === connection.id)
  if (!served) throw new ApiError(409, 'invalid_model_config', 'This deployment does not serve that connection.')
  return served
}

/** `POST /api/model_probe`. The body can carry a key, so it is never logged or echoed. */
export function createPostModelProbe(dependencies: ModelProbeDependencies = {}) {
  return async function POST(request: Request): Promise<Response> {
    try {
      let body: unknown
      try {
        body = await parseJsonRequest(request)
      } catch {
        throw new ApiError(400, 'invalid_request', 'The request is invalid.')
      }
      const deployed = deploymentProbe(body, dependencies)
      if (deployed) return json(await probeConnection(deployed, null, dependencies))
      const { connection, credential } = parseModelProbeRequest(body)
      // Probes carry exactly the key the page typed or holds; Studio never looks one up for a probe.
      if (connection.hasKey && credential === undefined)
        throw new ApiError(409, 'invalid_model_config', 'Probe this connection with its key.')
      if (!connection.hasKey && credential !== undefined)
        throw new ApiError(409, 'invalid_model_config', 'This connection uses no key; probe it without one.')
      return json(await probeConnection(connection, credential ?? null, dependencies))
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/** A researcher probes a draft connection with the key their page supplies, never one Studio holds. */
export function createResearcherApiHandlers(
  _store: Pick<ResearcherProjectStore, 'researcherAccountId'>,
  dependencies: ModelProbeDependencies = {},
) {
  return { POST: createPostModelProbe(dependencies) }
}
