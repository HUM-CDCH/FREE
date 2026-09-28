import { createModelConfigurationStore, type ModelConfigurationStore } from 'db'
import { canonicalExtractionSettings, extractionSettingsIssues } from 'extraction/extraction-method'
import { z } from 'zod'
import {
  apiBaseIssue,
  modelConfigSchema,
  modelConfigUpdateSchema,
  modelProbeRequestSchema,
  type ExtractionModelChoice,
  type ModelConfig,
  type ModelConfigUpdate,
  type ModelConnection,
  type ModelProbeRequest,
} from '../shared/modelConfig.contract.js'
import { ApiError, boundedValidationDetails, type ValidationIssue } from './_http.js'
import { DEPLOYMENT_IDS } from './_deployment_models.js'
import { studioProcess, type ModelKeyCache } from './_model_keys.js'
import { providerTable } from './_provider.js'


function emptyModelConfig(): ModelConfig {
  return {
    connections: [],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {},
    ingestionModels: {},
    extractionSettings: {},
  }
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

  config.connections.forEach((connection, index) => {
    const at = `connections.${index}`
    if (connectionById.has(connection.id)) {
      issues.push({ path: `${at}.id`, message: 'Connection IDs must be unique.' })
    } else {
      connectionById.set(connection.id, connection)
    }

    const { authentication, transport } = providerTable[connection.provider]
    if (transport === 'cli') {
      issues.push({ path: `${at}.provider`, message: 'CLI providers run on the server\'s own login; the operator enables them as deployment connections.' })
      return
    }
    if (authentication === 'managed' && !connection.hasKey)
      issues.push({ path: `${at}.hasKey`, message: 'A hosted provider always uses a key.' })

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
  for (const key of ['schemaSuggestion', 'interaction'] as const) {
    const route = config.routes[key]
    if (route !== null && !routed(route.connectionId)) {
      issues.push({ path: `routes.${key}.connectionId`, message: 'Route must reference an existing connection.' })
    }
  }

  // The method rules the Parsing Service applies, addressed to the field that breaks them (design §3).
  for (const issue of extractionSettingsIssues(config.extractionSettings))
    issues.push({ path: `extractionSettings.${issue.path}`, message: issue.message })

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
export function parseModelConfigUpdate(value: unknown): ModelConfigUpdate {
  const parsed = modelConfigUpdateSchema.safeParse(value)
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'The request is invalid.', {
      details: boundedValidationDetails('request', zodIssues(parsed.error)),
      cause: parsed.error,
    })
  }

  // The submitted document is whole, so duplicate IDs, CLI connections, keys, API
  // bases and dangling routes are all decidable here, by the same rules a saved one obeys.
  const issues = semanticIssues(parsed.data.config)
  if (issues.length > 0) {
    throw invalidSubmitted(issues.map((issue) => ({ ...issue, path: `config.${issue.path}` })))
  }
  return { config: parsed.data.config }
}

/**
 * Probe request syntax is structural; connection-contract violations are semantic. A probe may carry a key, and Zod
 * issue paths and messages can echo a key placed under an unexpected property, so a malformed probe gets one fixed
 * answer with no details and no cause.
 */
export function parseModelProbeRequest(value: unknown): ModelProbeRequest {
  const parsed = modelProbeRequestSchema.safeParse(value)
  if (!parsed.success) throw new ApiError(400, 'invalid_request', 'The request is invalid.')
  const issues = semanticIssues({ ...emptyModelConfig(), connections: [parsed.data.connection] })
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

/** A connection's provider is fixed once it is added: delete it and add a new one instead. */
function providerChangeIssues(previous: ModelConfig, config: ModelConfig): ValidationIssue[] {
  const before = new Map(previous.connections.map((connection) => [connection.id, connection.provider]))
  return config.connections.flatMap((connection, index) =>
    before.has(connection.id) && before.get(connection.id) !== connection.provider
      ? [{ path: `config.connections.${index}.provider`, message: 'An existing connection cannot change provider kind. Delete it and create a new UUID.' }]
      : [])
}

/**
 * The account's configuration row stays locked from reading the previous document to committing the new one, so one
 * account's Applies run one at a time and each sees the previous commit. The document never holds a key: Studio's
 * copies live in `keys`, which follows the committed connections afterwards.
 */
export async function applyAccountModelConfig(
  value: unknown,
  options: Readonly<{ researcherAccountId: string; store?: ModelConfigurationStore; keys?: Pick<ModelKeyCache, 'retain'> }>,
): Promise<ModelConfig> {
  const { config: submitted } = parseModelConfigUpdate(value)
  // Stored as the page and admission compare it: no nulls, no empty Catalog members, an explicit Article in full.
  const config: ModelConfig = { ...submitted, extractionSettings: canonicalExtractionSettings(submitted.extractionSettings) }
  await (options.store ?? modelConfigurations()).apply(options.researcherAccountId, (stored) => {
    const previous = stored === null ? emptyModelConfig() : storedModelConfig(stored)
    const issues = providerChangeIssues(previous, config)
    if (issues.length > 0) throw invalidSubmitted(issues)
    return config
  })
  // A removed or re-addressed connection's cached key goes now; a call already under way finishes.
  ;(options.keys ?? studioProcess.keys).retain(options.researcherAccountId, config.connections)
  return config
}

/** The configured Extraction Model Choice, or `null` when every role keeps kei-exp's default. */
export async function configuredExtractionModels(
  researcherAccountId: string,
  source: ModelConfigurationStore = modelConfigurations(),
): Promise<ExtractionModelChoice | null> {
  const { extractionModels } = await readAccountModelConfig(researcherAccountId, source)
  return extractionModels.fields || extractionModels.reasoning ? extractionModels : null
}

/** The owner's Ingestion Model Choice per role, null where the role keeps kei's default. Admission freezes it into an
 *  ingestion's workflow input, so a recovered attempt runs the models it was admitted with (spec, decision 13). */
export async function configuredIngestionModels(
  researcherAccountId: string,
  source: ModelConfigurationStore = modelConfigurations(),
): Promise<{ ocr: string | null; layout: string | null }> {
  const { ingestionModels } = await readAccountModelConfig(researcherAccountId, source)
  return { ocr: ingestionModels.ocr ?? null, layout: ingestionModels.layout ?? null }
}
