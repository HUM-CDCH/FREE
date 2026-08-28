import type { ModelConnection } from '../shared/modelConfig.contract.js'
import { ApiError, apiErrorResponse, json, parseJsonRequest } from './_http.js'
import { systemCredentialStore, type CredentialStore } from './_keyring.js'
import {
  parseModelProbeRequest,
  readModelConfig,
  type ConfigStorageOptions,
} from './_model_config.js'
import {
  probeConnection,
  providerTable,
  type ProviderProbeDependencies,
} from './_provider.js'

export type ModelProbeDependencies = ConfigStorageOptions &
  ProviderProbeDependencies & { credentialStore?: CredentialStore }

async function savedCredential(
  connection: ModelConnection,
  dependencies: ModelProbeDependencies,
): Promise<string | null> {
  const entry = providerTable[connection.provider]
  if (entry.authentication === 'external') return null
  const saved = (await readModelConfig(dependencies)).connections.find(
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

export function createPostModelProbe(dependencies: ModelProbeDependencies = {}) {
  return async function postModelProbe(request: Request): Promise<Response> {
    try {
      const parsed = parseModelProbeRequest(await parseJsonRequest(request))
      const entry = providerTable[parsed.connection.provider]
      if (entry.authentication === 'external' && parsed.credential !== undefined) {
        throw new ApiError(409, 'invalid_model_config', 'External providers do not accept managed credentials.')
      }
      const credential = Object.hasOwn(parsed, 'credential')
        ? (parsed.credential ?? null)
        : await savedCredential(parsed.connection, dependencies)
      return json(await probeConnection(parsed.connection, credential, dependencies))
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export const POST = createPostModelProbe()
