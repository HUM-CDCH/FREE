import { apiErrorResponse, json } from './_http.js'
import {
  credentialStates,
  readModelConfig,
  type ConfigStorageOptions,
  type CredentialStateReader,
} from './_model_config.js'
import { PROVIDERS } from './_provider.js'

export type ModelConfigDependencies = ConfigStorageOptions & {
  readCredentialState?: CredentialStateReader
}

/** Reads saved state only: no provider network call, CLI process, or `AI_*` value. */
export function createGetModelConfig(dependencies: ModelConfigDependencies = {}) {
  return async function getModelConfig(): Promise<Response> {
    try {
      const config = await readModelConfig(dependencies)
      return json({
        config,
        credentialStates: await credentialStates(config, dependencies.readCredentialState),
        providers: PROVIDERS,
      })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export const GET = createGetModelConfig()
