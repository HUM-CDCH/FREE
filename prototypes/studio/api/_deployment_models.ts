import {
  DEPLOYMENT_CONNECTION_IDS,
  isValidApiBase,
  type DeploymentModels,
  type ModelConnection,
} from '../shared/modelConfig.contract.js'

type Environment = Readonly<Record<string, string | undefined>>

function served(id: string, name: string, baseUrl: string | undefined): ModelConnection[] {
  const trimmed = baseUrl?.trim()
  if (!trimmed || !isValidApiBase(trimmed)) return []
  return [{ id, name, provider: 'vllm', baseUrl: trimmed }]
}

/**
 * The vLLM servers this deployment runs, as read-only Model Connections. They
 * come from the environment on every call and are never saved, so a
 * redeployment that moves or drops a server is reflected without a migration.
 */
export function deploymentModels(env: Environment = process.env): DeploymentModels {
  const connections = [
    ...served(DEPLOYMENT_CONNECTION_IDS.instruct, 'Deployment instruction model', env.FREE_DEPLOYMENT_INSTRUCT_URL),
    ...served(DEPLOYMENT_CONNECTION_IDS.nuextract, 'Deployment NuExtract', env.FREE_DEPLOYMENT_NUEXTRACT_URL),
  ]
  const modelId = env.FREE_DEPLOYMENT_INSTRUCT_MODEL?.trim()
  const instruct = connections.find(({ id }) => id === DEPLOYMENT_CONNECTION_IDS.instruct)
  return {
    connections,
    defaultRoute: instruct && modelId ? { connectionId: instruct.id, modelId } : null,
  }
}

export const DEPLOYMENT_IDS: ReadonlySet<string> = new Set(Object.values(DEPLOYMENT_CONNECTION_IDS))
