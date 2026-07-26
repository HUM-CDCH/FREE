import { apiErrorResponse, json, parseJsonRequest } from './_http.js'
import { systemCredentialStore, type CredentialStore } from './_keyring.js'
import {
  credentialStates,
  readModelConfig,
  updateModelConfig,
  type ConfigStorageOptions,
} from './_model_config.js'
import { PROVIDERS } from './_provider.js'

/** `credentialStore` is the keyring seam; tests inject a fake for both handlers. */
export type ModelConfigDependencies = ConfigStorageOptions & { credentialStore?: CredentialStore }

function storeFor(dependencies: ModelConfigDependencies): CredentialStore {
  return dependencies.credentialStore ?? systemCredentialStore
}

/** Reads saved state only: no provider network call, CLI process, or `AI_*` value. */
export function createGetModelConfig(dependencies: ModelConfigDependencies = {}) {
  return async function getModelConfig(): Promise<Response> {
    try {
      const config = await readModelConfig(dependencies)
      return json({
        config,
        credentialStates: await credentialStates(config, storeFor(dependencies)),
        providers: PROVIDERS,
      })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/** Whole-document save. Returns the committed configuration, never a descriptor or secret. */
export function createPutModelConfig(dependencies: ModelConfigDependencies = {}) {
  return async function putModelConfig(request: Request): Promise<Response> {
    try {
      const body = await parseJsonRequest(request)
      return json(await updateModelConfig(body, { ...dependencies, credentialStore: storeFor(dependencies) }))
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export const GET = createGetModelConfig()
export const PUT = createPutModelConfig()
