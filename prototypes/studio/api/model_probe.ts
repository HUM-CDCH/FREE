import type { ModelConfigurationStore, ResearcherProjectStore } from 'db'
import {
  modelProbeRequestSchema,
  type DeploymentModels,
  type ModelConnection,
} from '../shared/modelConfig.contract.js'
import { DEPLOYMENT_IDS, deploymentModels } from './_deployment_models.js'
import { ApiError, apiErrorResponse, json, parseJsonRequest } from './_http.js'
import { systemCredentialStore, type CredentialStore } from './_keyring.js'
import { parseModelProbeRequest, readAccountModelConfig } from './_model_config.js'
import {
  probeConnection,
  providerTable,
  type ProviderProbeDependencies,
} from './_provider.js'

export type ModelProbeDependencies = ProviderProbeDependencies & {
  configurations?: ModelConfigurationStore
  credentialStore?: CredentialStore
  deployment?: () => DeploymentModels
}

/**
 * A deployment connection is probed at the address the server knows, never at
 * one the client sends, and without a credential.
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

/** Only a connection the researcher saved, at the same provider and API base, may reuse its stored credential. */
async function savedCredential(
  researcherAccountId: string,
  connection: ModelConnection,
  dependencies: ModelProbeDependencies,
): Promise<string | null> {
  const entry = providerTable[connection.provider]
  if (entry.authentication === 'external') return null
  const saved = (await readAccountModelConfig(researcherAccountId, dependencies.configurations)).connections.find(
    ({ id, provider, baseUrl }) =>
      id === connection.id &&
      provider === connection.provider &&
      baseUrl === connection.baseUrl,
  )
  if (!saved) {
    if (entry.authentication === 'optional') return null
    throw new ApiError(409, 'invalid_model_config', 'The draft Model Connection requires a credential.')
  }

  try {
    const credential = await (dependencies.credentialStore ?? systemCredentialStore).get?.(connection.id)
    // Loose null: the keyring resolves `null`, not `undefined`, for a missing entry.
    if (credential != null) return credential
    if (entry.authentication === 'optional') return null
  } catch (cause) {
    if (entry.authentication === 'optional') return null
    throw new ApiError(503, 'keyring_unavailable', 'The operating system credential store is unavailable.', { cause })
  }
  throw new ApiError(409, 'invalid_model_config', 'The draft Model Connection requires a credential.')
}

function createPostModelProbe(researcherAccountId: string, dependencies: ModelProbeDependencies) {
  return async function postModelProbe(request: Request): Promise<Response> {
    try {
      const body = await parseJsonRequest(request)
      const deployed = deploymentProbe(body, dependencies)
      if (deployed) return json(await probeConnection(deployed, null, dependencies))
      const parsed = parseModelProbeRequest(body)
      const entry = providerTable[parsed.connection.provider]
      if (entry.authentication === 'external' && parsed.credential !== undefined) {
        throw new ApiError(409, 'invalid_model_config', 'External providers do not accept managed credentials.')
      }
      const credential = Object.hasOwn(parsed, 'credential')
        ? (parsed.credential ?? null)
        : await savedCredential(researcherAccountId, parsed.connection, dependencies)
      return json(await probeConnection(parsed.connection, credential, dependencies))
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/** A researcher probes with only their own saved credentials. */
export function createResearcherApiHandlers(
  store: Pick<ResearcherProjectStore, 'researcherAccountId'>,
  dependencies: ModelProbeDependencies = {},
) {
  return { POST: createPostModelProbe(store.researcherAccountId, dependencies) }
}
