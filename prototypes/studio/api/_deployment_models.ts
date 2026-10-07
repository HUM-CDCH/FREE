import { unifiedCatalogEnabled } from 'extraction/extraction-method'
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
  return [{ id, name, provider: 'vllm', baseUrl: trimmed, hasKey: false }]
}

const CLI_DEPLOYMENTS = [
  { provider: 'codex-cli', id: DEPLOYMENT_CONNECTION_IDS.codexCli, name: 'Codex CLI on this server' },
  { provider: 'claude-code', id: DEPLOYMENT_CONNECTION_IDS.claudeCode, name: 'Claude Code on this server' },
] as const

/** CLI providers run on the server's own CLI login (the CLI auth homes), so only the operator enables them, with
 *  FREE_DEPLOYMENT_CLI_PROVIDERS; every researcher can then route to them. Unknown entries are ignored. */
function cliConnections(value: string | undefined): ModelConnection[] {
  const enabled = new Set((value ?? '').split(',').map((entry) => entry.trim()))
  return CLI_DEPLOYMENTS.filter(({ provider }) => enabled.has(provider))
    .map(({ provider, id, name }) => ({ id, name, provider, baseUrl: null, hasKey: false }))
}

/**
 * The vLLM servers this deployment runs and the CLI providers its operator
 * enables, as read-only Model Connections. They come from the environment on
 * every call and are never saved, so a redeployment that moves or drops one is
 * reflected without a migration.
 */
export function deploymentModels(env: Environment = process.env): DeploymentModels {
  const connections = [
    ...served(DEPLOYMENT_CONNECTION_IDS.instruct, 'Deployment instruction model', env.FREE_DEPLOYMENT_INSTRUCT_URL),
    ...served(DEPLOYMENT_CONNECTION_IDS.nuextract, 'Deployment NuExtract', env.FREE_DEPLOYMENT_NUEXTRACT_URL),
    ...cliConnections(env.FREE_DEPLOYMENT_CLI_PROVIDERS),
  ]
  const modelId = env.FREE_DEPLOYMENT_INSTRUCT_MODEL?.trim()
  const instruct = connections.find(({ id }) => id === DEPLOYMENT_CONNECTION_IDS.instruct)
  return {
    connections,
    defaultRoute: instruct && modelId ? { connectionId: instruct.id, modelId } : null,
    ...(unifiedCatalogEnabled(env) ? { unifiedCatalog: true } : {}),
  }
}

export const DEPLOYMENT_IDS: ReadonlySet<string> = new Set(Object.values(DEPLOYMENT_CONNECTION_IDS))
