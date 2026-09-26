import type { ModelConfigurationStore, ResearcherProjectStore } from 'db'
import { apiErrorResponse, json, parseJsonRequest } from './_http.js'
import { systemCredentialStore, type CredentialStore } from './_keyring.js'
import {
  credentialStates,
  readAccountModelConfig,
  updateAccountModelConfig,
} from './_model_config.js'
import type { DeploymentModels } from '../shared/modelConfig.contract.js'
import { deploymentModels } from './_deployment_models.js'
import { PROVIDERS } from './_provider.js'

/** `configurations` and `credentialStore` are the storage and keyring seams; tests inject fakes for both. */
export type ModelConfigDependencies = {
  configurations?: ModelConfigurationStore
  credentialStore?: CredentialStore
  deployment?: () => DeploymentModels
}

/** Reads saved state only: no provider network call, CLI process, or `AI_*` value. */
function createGetModelConfig(researcherAccountId: string, dependencies: ModelConfigDependencies) {
  const credentialStore = dependencies.credentialStore ?? systemCredentialStore
  return async function getModelConfig(): Promise<Response> {
    try {
      const config = await readAccountModelConfig(researcherAccountId, dependencies.configurations)
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
function createPutModelConfig(researcherAccountId: string, dependencies: ModelConfigDependencies) {
  const credentialStore = dependencies.credentialStore ?? systemCredentialStore
  return async function putModelConfig(request: Request): Promise<Response> {
    try {
      const body = await parseJsonRequest(request)
      return json(
        await updateAccountModelConfig(body, {
          researcherAccountId,
          store: dependencies.configurations,
          credentialStore,
        }),
      )
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
