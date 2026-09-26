import type { ModelConfigurationStore, ResearcherProjectStore } from 'db'
import { apiErrorResponse, json, parseJsonRequest } from './_http.js'
import { applyAccountModelConfig, readAccountModelConfig } from './_model_config.js'
import type { ModelKeyCache } from './_model_keys.js'
import type { DeploymentModels } from '../shared/modelConfig.contract.js'
import { deploymentModels } from './_deployment_models.js'
import { PROVIDERS } from './_provider.js'

/** `configurations` and `keys` are the storage and key-cache seams; tests inject isolated ones for both. */
export type ModelConfigDependencies = {
  configurations?: ModelConfigurationStore
  keys?: Pick<ModelKeyCache, 'retain'>
  deployment?: () => DeploymentModels
}

/** Reads saved state only: no provider network call, CLI process, key, or `AI_*` value. */
function createGetModelConfig(researcherAccountId: string, dependencies: ModelConfigDependencies) {
  return async function getModelConfig(): Promise<Response> {
    try {
      const config = await readAccountModelConfig(researcherAccountId, dependencies.configurations)
      return json({
        config,
        providers: PROVIDERS,
        deployment: (dependencies.deployment ?? deploymentModels)(),
      })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/** Whole-document save. Returns the committed configuration, never a descriptor or key. */
function createPutModelConfig(researcherAccountId: string, dependencies: ModelConfigDependencies) {
  return async function putModelConfig(request: Request): Promise<Response> {
    try {
      const body = await parseJsonRequest(request)
      const config = await applyAccountModelConfig(body, {
        researcherAccountId,
        store: dependencies.configurations,
        keys: dependencies.keys,
      })
      return json({ config })
    } catch (error) {
      return apiErrorResponse(error)
    }
  }
}

/** A researcher reads and changes only their own configuration. */
export function createResearcherApiHandlers(
  store: Pick<ResearcherProjectStore, 'researcherAccountId'>,
  dependencies: ModelConfigDependencies = {},
) {
  return {
    GET: createGetModelConfig(store.researcherAccountId, dependencies),
    PUT: createPutModelConfig(store.researcherAccountId, dependencies),
  }
}
