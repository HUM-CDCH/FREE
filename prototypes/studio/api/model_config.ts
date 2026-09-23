import { apiErrorResponse, json, parseJsonRequest } from './_http.js'
import { systemCredentialStore, type CredentialStore } from './_keyring.js'
import {
  credentialStates,
  readModelConfig,
  resetModelConfig,
  updateModelConfig,
  type ConfigStorageOptions,
} from './_model_config.js'
import type { DeploymentModels } from '../shared/modelConfig.contract.js'
import { deploymentModels } from './_deployment_models.js'
import { PROVIDERS } from './_provider.js'

/** `credentialStore` is the keyring seam; tests inject a fake for both handlers. */
export type ModelConfigDependencies = ConfigStorageOptions & {
  credentialStore?: CredentialStore
  deployment?: () => DeploymentModels
}

let modelConfigWriteBarrier: Promise<void> = Promise.resolve()

/**
 * The hosted Studio has one process and one deployment-wide document. Reserve a
 * queue position synchronously so every handler instance serializes the complete
 * read/keyring/atomic-file/cleanup path without turning probes into queued work.
 */
async function serializeModelConfigWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const preceding = modelConfigWriteBarrier
  let release!: () => void
  modelConfigWriteBarrier = new Promise<void>((resolve) => {
    release = resolve
  })
  await preceding
  try {
    return await operation()
  } finally {
    release()
  }
}

/** Reads saved state only: no provider network call, CLI process, or `AI_*` value. */
export function createGetModelConfig(dependencies: ModelConfigDependencies = {}) {
  const credentialStore = dependencies.credentialStore ?? systemCredentialStore
  return async function getModelConfig(): Promise<Response> {
    try {
      const config = await readModelConfig(dependencies)
      return json({
        config,
        credentialStates: await credentialStates(config, credentialStore),
        providers: PROVIDERS,
        deployment: (dependencies.deployment ?? deploymentModels)(),
      })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/** Whole-document save. Returns the committed configuration, never a descriptor or secret. */
export function createPutModelConfig(dependencies: ModelConfigDependencies = {}) {
  const credentialStore = dependencies.credentialStore ?? systemCredentialStore
  return async function putModelConfig(request: Request): Promise<Response> {
    try {
      return json(
        await serializeModelConfigWrite(async () => {
          const body = await parseJsonRequest(request)
          return updateModelConfig(body, {
            ...dependencies,
            credentialStore,
          })
        }),
      )
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/** Deletes the saved document, readable or not; the response is the empty state a GET would now return. */
export function createDeleteModelConfig(dependencies: ModelConfigDependencies = {}) {
  const get = createGetModelConfig(dependencies)
  return async function deleteModelConfig(): Promise<Response> {
    try {
      await serializeModelConfigWrite(() => resetModelConfig(dependencies))
      return await get()
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

export const GET = createGetModelConfig()
export const PUT = createPutModelConfig()
export const DELETE = createDeleteModelConfig()
