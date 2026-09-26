import { createModelConfigurationStore, type ModelConfigurationStore } from 'db'
import { z } from 'zod'
import {
  apiBaseIssue,
  modelConfigSchema,
  type CredentialActions,
  modelConfigUpdateSchema,
  modelProbeRequestSchema,
  type CredentialState,
  type ExtractionModelChoice,
  type ModelConfig,
  type ModelConfigUpdate,
  type ModelConnection,
  type ModelProbeRequest,
  type ProviderKind,
} from '../shared/modelConfig.contract.js'
import { ApiError, boundedValidationDetails, type ValidationIssue } from './_http.js'
import type { CredentialStore } from './_keyring.js'
import { DEPLOYMENT_IDS } from './_deployment_models.js'
import { providerTable } from './_provider.js'


function emptyModelConfig(): ModelConfig {
  return { connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {} }
}

/** Comparison value only. Readers return a fresh document so callers cannot alias it. */
export const EMPTY_MODEL_CONFIG: ModelConfig = emptyModelConfig()


function invalidModelConfig(issues: readonly ValidationIssue[], cause?: unknown): ApiError {
  return new ApiError(409, 'invalid_model_config', 'The model configuration is invalid.', {
    details: boundedValidationDetails('config', issues),
    cause,
  })
}


function semanticIssues(config: ModelConfig): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const connectionById = new Map<string, ModelConnection>()
  const cliCounts = new Map<ProviderKind, number>()

  config.connections.forEach((connection, index) => {
    const at = `connections.${index}`
    if (connectionById.has(connection.id)) {
      issues.push({ path: `${at}.id`, message: 'Connection IDs must be unique.' })
    } else {
      connectionById.set(connection.id, connection)
    }

    if (providerTable[connection.provider].transport === 'cli') {
      if (connection.baseUrl !== null) {
        issues.push({ path: `${at}.baseUrl`, message: 'CLI providers require a null API base.' })
      }
      const count = (cliCounts.get(connection.provider) ?? 0) + 1
      cliCounts.set(connection.provider, count)
      if (count > 1) {
        issues.push({ path: `${at}.provider`, message: 'CLI provider kinds allow only one connection.' })
      }
      return
    }

    if (connection.baseUrl === null) {
      issues.push({ path: `${at}.baseUrl`, message: 'HTTP providers require an API base.' })
      return
    }
    const issue = apiBaseIssue(connection.baseUrl)
    if (issue) issues.push({ path: `${at}.baseUrl`, message: issue })
  })

  config.connections.forEach((connection, index) => {
    if (DEPLOYMENT_IDS.has(connection.id)) {
      issues.push({ path: `connections.${index}.id`, message: 'This ID is reserved for a deployment connection.' })
    }
  })

  // A route may name a deployment connection. Whether this deployment still
  // serves it is decided when the route is resolved, not when the file is read.
  const routed = (connectionId: string) => connectionById.get(connectionId) ?? (
    DEPLOYMENT_IDS.has(connectionId) ? 'deployment' : undefined
  )
  const { schemaSuggestion, interaction } = config.routes
  if (schemaSuggestion !== null) {
    const connection = routed(schemaSuggestion.connectionId)
    if (!connection) {
      issues.push({
        path: 'routes.schemaSuggestion.connectionId',
        message: 'Route must reference an existing connection.',
      })
    } else if (
      schemaSuggestion.protocol === 'nuextract' &&
      connection !== 'deployment' &&
      !providerTable[connection.provider].supportsNuextract
    ) {
      issues.push({
        path: 'routes.schemaSuggestion.protocol',
        message: 'The NuExtract protocol requires a vLLM connection.',
      })
    }
  }
  if (interaction !== null && !routed(interaction.connectionId)) {
    issues.push({
      path: 'routes.interaction.connectionId',
      message: 'Route must reference an existing connection.',
    })
  }

  return issues
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }))
}

/** The contract every stored document obeys: its shape plus the rules across connections and routes. */
export function validateModelConfig(value: unknown): ModelConfig {
  const parsed = modelConfigSchema.safeParse(value)
  if (!parsed.success) throw invalidModelConfig(zodIssues(parsed.error), parsed.error)

  const issues = semanticIssues(parsed.data)
  if (issues.length > 0) throw invalidModelConfig(issues)
  return parsed.data
}

function invalidSubmitted(issues: readonly ValidationIssue[]): ApiError {
  return new ApiError(409, 'invalid_model_config', 'The submitted model configuration is invalid.', {
    details: boundedValidationDetails('request', issues),
  })
}

/** A malformed request is `400`; a well-formed one describing invalid state is `409`. */
export function parseModelConfigUpdate(
  value: unknown,
): ModelConfigUpdate & { credentials: CredentialActions } {
  const parsed = modelConfigUpdateSchema.safeParse(value)
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'The request is invalid.', {
      details: boundedValidationDetails('request', zodIssues(parsed.error)),
      cause: parsed.error,
    })
  }

  // The submitted document is whole, so duplicate IDs, CLI singletons, API bases
  // and dangling routes are all decidable here, by the same rules a saved one obeys.
  const issues = semanticIssues(parsed.data.config)
  if (issues.length > 0) {
    throw invalidSubmitted(issues.map((issue) => ({ ...issue, path: `config.${issue.path}` })))
  }
  return { config: parsed.data.config, credentials: parsed.data.credentials ?? {} }
}

/** Probe request syntax is structural; connection-contract violations are semantic. */
export function parseModelProbeRequest(value: unknown): ModelProbeRequest {
  const parsed = modelProbeRequestSchema.safeParse(value)
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'The request is invalid.', {
      details: boundedValidationDetails('request', zodIssues(parsed.error)),
      cause: parsed.error,
    })
  }
  const issues = semanticIssues({
    connections: [parsed.data.connection],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {},
  })
  if (issues.length > 0) {
    throw invalidSubmitted(
      issues.map((issue) => ({
        ...issue,
        path: issue.path.replace(/^connections\.0/, 'connection'),
      })),
    )
  }
  return parsed.data
}

let processConfigurations: ModelConfigurationStore | undefined
/** The process's configuration store. Each Researcher Account owns one document (decision 6). */
export function modelConfigurations(): ModelConfigurationStore {
  return (processConfigurations ??= createModelConfigurationStore())
}

/** The account's configuration, or the empty one before its first Apply. Validation on write keeps the stored
 *  document valid, so one that fails here is a server fault: 500, with no details. */
export async function readAccountModelConfig(
  researcherAccountId: string,
  source: ModelConfigurationStore = modelConfigurations(),
): Promise<ModelConfig> {
  const stored = await source.read(researcherAccountId)
  if (stored === null) return emptyModelConfig()
  return storedModelConfig(stored)
}

function storedModelConfig(stored: unknown): ModelConfig {
  try {
    return validateModelConfig(stored)
  } catch {
    throw new ApiError(500, 'invalid_model_config', 'The saved model configuration is invalid.')
  }
}

/**
 * Externally authenticated connections are absent from the map entirely: FREE
 * manages no credential for them, and CLI login is a probe concern.
 *
 * Reporting state is best effort by design, so a keyring failure degrades to
 * `unavailable` here. The mutating paths below take the opposite policy and fail
 * with `503`, because a save that silently skipped the keyring would be a lie.
 */
export async function credentialStates(
  config: ModelConfig,
  store: CredentialStore,
): Promise<Record<string, CredentialState>> {
  const states: Record<string, CredentialState> = {}
  for (const connection of config.connections) {
    if (providerTable[connection.provider].authentication === 'external') continue
    try {
      states[connection.id] = await store.state(connection.id)
    } catch {
      states[connection.id] = 'unavailable'
    }
  }
  return states
}

export type ModelConfigUpdateOptions = {
  researcherAccountId: string
  store?: ModelConfigurationStore
  credentialStore: CredentialStore
}

async function requireKeyring<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    throw new ApiError(503, 'keyring_unavailable', 'The operating system credential store is unavailable.', {
      cause,
    })
  }
}

/** Every issue decidable without the keyring, collected so one response reports them all. */
function updateIssues(
  previous: ModelConfig,
  config: ModelConfig,
  credentials: CredentialActions,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const previousById = new Map(previous.connections.map((connection) => [connection.id, connection]))
  const submittedById = new Map(config.connections.map((connection) => [connection.id, connection]))

  config.connections.forEach((connection, index) => {
    const before = previousById.get(connection.id)
    if (before && before.provider !== connection.provider) {
      issues.push({
        path: `config.connections.${index}.provider`,
        message: 'An existing connection cannot change provider kind. Delete it and create a new UUID.',
      })
    }
    const managed =
      providerTable[connection.provider].authentication === 'managed'
    const credentialBoundaryChanged =
      !before || before.baseUrl !== connection.baseUrl
    if (
      managed &&
      credentialBoundaryChanged &&
      !Object.hasOwn(credentials, connection.id)
    )
      issues.push({
        path: `credentials.${connection.id}`,
        message:
          'A new or re-addressed managed connection requires an explicit credential.',
      })
  })

  for (const [id, action] of Object.entries(credentials)) {
    const connection = submittedById.get(id)
    if (!connection) {
      issues.push({ path: `credentials.${id}`, message: 'Credential actions must name a submitted connection.' })
      continue
    }
    const { authentication } = providerTable[connection.provider]
    if (authentication === 'external') {
      issues.push({
        path: `credentials.${id}`,
        message: 'Externally authenticated providers have no FREE-managed credential.',
      })
    } else if (authentication === 'managed' && action === null) {
      issues.push({ path: `credentials.${id}`, message: 'This provider requires a credential.' })
    }
  }
  return issues
}

/**
 * A `managed` provider left out of the actions keeps whatever the keyring holds,
 * so this is the one validation step that has to ask the keyring.
 */
async function requireManagedCredentials(
  config: ModelConfig,
  credentials: CredentialActions,
  store: CredentialStore,
): Promise<void> {
  const issues: ValidationIssue[] = []
  for (const { id, provider } of config.connections) {
    if (providerTable[provider].authentication !== 'managed') continue
    if (Object.hasOwn(credentials, id)) continue
    if ((await requireKeyring(() => store.state(id))) === 'absent') {
      issues.push({ path: `credentials.${id}`, message: 'This provider requires a credential.' })
    }
  }
  if (issues.length > 0) throw invalidSubmitted(issues)
}

async function clearImplicitOptionalCredentials(
  previous: ModelConfig,
  config: ModelConfig,
  credentials: CredentialActions,
  store: CredentialStore,
): Promise<void> {
  const previousById = new Map(
    previous.connections.map((connection) => [connection.id, connection]),
  )
  for (const connection of config.connections) {
    const before = previousById.get(connection.id)
    if (
      providerTable[connection.provider].authentication === 'optional' &&
      !Object.hasOwn(credentials, connection.id) &&
      (!before || before.baseUrl !== connection.baseUrl)
    )
      await requireKeyring(() => store.delete(connection.id))
  }
}

/**
 * The account's configuration row stays locked from reading the previous document to committing the new one, so
 * one account's Applies run one at a time. Credentials move inside that transaction, before the commit, so a
 * committed route can never name a credential that was never stored. The keyring and PostgreSQL cannot commit
 * together: a failed commit leaves the new credential beside the old configuration, which the next successful Apply
 * overwrites. No rollback, no action journal.
 */
export async function updateAccountModelConfig(
  value: unknown,
  { researcherAccountId, store, credentialStore }: ModelConfigUpdateOptions,
): Promise<{ config: ModelConfig; credentialStates: Record<string, CredentialState> }> {
  const { config, credentials } = parseModelConfigUpdate(value)
  let previous = emptyModelConfig()

  await (store ?? modelConfigurations()).apply(researcherAccountId, async (stored) => {
    previous = stored === null ? emptyModelConfig() : storedModelConfig(stored)
    const issues = updateIssues(previous, config, credentials)
    if (issues.length > 0) throw invalidSubmitted(issues)
    await requireManagedCredentials(config, credentials, credentialStore)
    await clearImplicitOptionalCredentials(previous, config, credentials, credentialStore)
    for (const [id, action] of Object.entries(credentials)) {
      await requireKeyring(() => (action === null ? credentialStore.delete(id) : credentialStore.set(id, action)))
    }
    return config
  })

  // Past the commit the document is authoritative. Reusing a removed UUID cannot
  // reactivate a leftover credential: managed/new endpoints require an explicit
  // credential, while optional/new endpoints delete any leftover before commit.
  const submitted = new Set(config.connections.map(({ id }) => id))
  for (const { id, provider } of previous.connections) {
    if (submitted.has(id) || providerTable[provider].authentication === 'external') continue
    await credentialStore.delete(id).catch(() => undefined)
  }

  return { config, credentialStates: await credentialStates(config, credentialStore) }
}

/** The configured Extraction Model Choice, or `null` when every role keeps kei-exp's default. */
export async function configuredExtractionModels(
  researcherAccountId: string,
  source: ModelConfigurationStore = modelConfigurations(),
): Promise<ExtractionModelChoice | null> {
  const { extractionModels } = await readAccountModelConfig(researcherAccountId, source)
  return extractionModels.fields || extractionModels.reasoning ? extractionModels : null
}
