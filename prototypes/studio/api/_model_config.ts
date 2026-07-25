import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import envPaths from 'env-paths'
import { z } from 'zod'
import { ApiError, boundedValidationDetails, type ValidationIssue } from './_http.js'
import type { CredentialStore } from './_keyring.js'
import { providerTable, type ProviderKind } from './_provider.js'

export type ModelConnection = {
  id: string
  name: string
  provider: ProviderKind
  baseUrl: string | null
}
export type Route = { connectionId: string; modelId: string }
export type Routes = {
  extraction: (Route & { nuextractRaw?: true }) | null
  interaction: Route | null
}
export type ModelConfig = { connections: ModelConnection[]; routes: Routes }
export type CredentialState = 'present' | 'absent' | 'unavailable'
/** Omitted ID preserves, non-empty string replaces, `null` deletes. */
export type CredentialActions = Record<string, string | null>
export type ModelConfigUpdate = { config: ModelConfig; credentials: CredentialActions }

function emptyModelConfig(): ModelConfig {
  return { connections: [], routes: { extraction: null, interaction: null } }
}

/** Comparison value only. Readers return a fresh document so callers cannot alias it. */
export const EMPTY_MODEL_CONFIG: ModelConfig = emptyModelConfig()

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Must be a canonical lowercase UUID.',
  )
const connectionSchema = z
  .object({
    id: uuidSchema,
    name: z.string().min(1, 'Must not be empty.'),
    provider: z.enum(Object.keys(providerTable) as [ProviderKind, ...ProviderKind[]]),
    baseUrl: z.string().min(1).nullable(),
  })
  .strict()
const routeSchema = z
  .object({ connectionId: uuidSchema, modelId: z.string().min(1, 'Must not be empty.') })
  .strict()
const modelConfigSchema = z
  .object({
    connections: z.array(connectionSchema),
    routes: z
      .object({
        extraction: routeSchema.extend({ nuextractRaw: z.literal(true).optional() }).nullable(),
        interaction: routeSchema.nullable(),
      })
      .strict(),
  })
  .strict()

/**
 * The editable document is submitted unchanged, so PUT reuses the same schema GET
 * returns. An empty-string action is invalid rather than an alias for either
 * preserve or delete, which the value schema states rather than a later check.
 */
const modelConfigUpdateSchema = z
  .object({
    config: modelConfigSchema,
    credentials: z
      .record(uuidSchema, z.string().min(1, 'Must not be empty.').nullable())
      .optional(),
  })
  .strict()

export type ConfigFileHandle = {
  writeFile(contents: string, options: { encoding: 'utf8' }): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export type ConfigFileSystem = {
  readFile(path: string): Promise<Uint8Array>
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined | void>
  open(path: string, flags: 'wx', mode: number): Promise<ConfigFileHandle>
  rename(from: string, to: string): Promise<void>
  unlink(path: string): Promise<void>
}

export const nodeFileSystem: ConfigFileSystem = {
  readFile: (path) => readFile(path),
  mkdir,
  open,
  rename,
  unlink,
}

export type ConfigStorageOptions = { configRoot?: string; fileSystem?: ConfigFileSystem }

export function modelConfigPath(configRoot: string = envPaths('FREE Studio').config): string {
  return join(configRoot, 'model-config.json')
}

function invalidModelConfig(path: string, issues: readonly ValidationIssue[], cause?: unknown): ApiError {
  return new ApiError(409, 'invalid_model_config', 'The saved model configuration is invalid.', {
    details: boundedValidationDetails(path, issues),
    cause,
  })
}

/**
 * `new URL()` silently normalises away a bare `@`, backslashes, surrounding
 * whitespace, and control characters, so a lenient check would store a base
 * that differs from the one FREE later fetches and shows the researcher.
 * Each rejection below is a case URL parsing alone does not catch.
 */
function apiBaseIssue(value: string): string | null {
  if (value.trim() !== value) return 'API base must not have surrounding whitespace.'
  if (/\p{Cc}/u.test(value)) return 'API base must not contain control characters.'
  if (value.includes('\\')) return 'API base must not contain backslashes.'

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'API base must be an absolute HTTP or HTTPS URL.'
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.host === '') {
    return 'API base must be an absolute HTTP or HTTPS URL.'
  }
  const authority = /^https?:\/\/([^/?#]*)/i.exec(value)?.[1] ?? ''
  if (parsed.username !== '' || parsed.password !== '' || authority.includes('@')) {
    return 'API base must not contain embedded userinfo.'
  }
  if (parsed.search !== '') return 'API base must not contain a query.'
  if (parsed.hash !== '') return 'API base must not contain a fragment.'
  return null
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

  const { extraction, interaction } = config.routes
  if (extraction !== null) {
    const connection = connectionById.get(extraction.connectionId)
    if (!connection) {
      issues.push({
        path: 'routes.extraction.connectionId',
        message: 'Route must reference an existing connection.',
      })
    } else if (extraction.nuextractRaw === true && connection.provider !== 'ollama') {
      issues.push({
        path: 'routes.extraction.nuextractRaw',
        message: 'Raw NuExtract requires an Ollama connection.',
      })
    }
  }
  if (interaction !== null && !connectionById.has(interaction.connectionId)) {
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

export function validateModelConfig(value: unknown, path: string): ModelConfig {
  const parsed = modelConfigSchema.safeParse(value)
  if (!parsed.success) throw invalidModelConfig(path, zodIssues(parsed.error), parsed.error)

  const issues = semanticIssues(parsed.data)
  if (issues.length > 0) throw invalidModelConfig(path, issues)
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

  // The submitted document is whole, so duplicate IDs, CLI singletons, API bases
  // and dangling routes are all decidable here, by the same rules a saved one obeys.
  const issues = semanticIssues(parsed.data.config)
  if (issues.length > 0) {
    throw invalidSubmitted(issues.map((issue) => ({ ...issue, path: `config.${issue.path}` })))
  }
  return { config: parsed.data.config, credentials: parsed.data.credentials ?? {} }
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** An absent file is the valid empty configuration. Anything else fails closed. */
export async function readModelConfig(options: ConfigStorageOptions = {}): Promise<ModelConfig> {
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const path = modelConfigPath(options.configRoot)

  let bytes: Uint8Array
  try {
    bytes = await fileSystem.readFile(path)
  } catch (error) {
    if (isMissingFile(error)) return emptyModelConfig()
    throw new ApiError(500, 'storage_failure', 'The model configuration could not be read.', {
      cause: error,
    })
  }

  let contents: string
  try {
    contents = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw invalidModelConfig(path, [{ path: '', message: 'Document must contain valid UTF-8.' }], error)
  }

  let document: unknown
  try {
    document = JSON.parse(contents)
  } catch (error) {
    throw invalidModelConfig(path, [{ path: '', message: 'Document must contain valid JSON.' }], error)
  }
  return validateModelConfig(document, path)
}

/** Flushed sibling temporary then rename, so the document is never half-written. */
export async function writeModelConfig(
  config: unknown,
  options: ConfigStorageOptions = {},
): Promise<ModelConfig> {
  const fileSystem = options.fileSystem ?? nodeFileSystem
  const path = modelConfigPath(options.configRoot)
  const validated = validateModelConfig(config, path)
  const directory = dirname(path)
  const temporaryPath = join(directory, `.${basename(path)}.${randomUUID()}.tmp`)
  let handle: ConfigFileHandle | undefined

  try {
    await fileSystem.mkdir(directory, { recursive: true })
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = undefined
    await fileSystem.rename(temporaryPath, path)
  } catch (error) {
    // The original failure stays authoritative; cleanup is best effort.
    await handle?.close().catch(() => undefined)
    await fileSystem.unlink(temporaryPath).catch(() => undefined)
    throw new ApiError(500, 'storage_failure', 'The model configuration could not be saved.', {
      cause: error,
    })
  }
  return validated
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

export type ModelConfigUpdateOptions = ConfigStorageOptions & { credentialStore: CredentialStore }

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

/**
 * Credentials move before the JSON commit so a committed route can never name a
 * credential that was never stored. The two stores cannot commit together: a
 * failure between them leaves the new credential beside the old configuration,
 * which the next successful Apply overwrites. No rollback, no action journal.
 */
export async function updateModelConfig(
  value: unknown,
  options: ModelConfigUpdateOptions,
): Promise<{ config: ModelConfig; credentialStates: Record<string, CredentialState> }> {
  const { config, credentials } = parseModelConfigUpdate(value)
  const store = options.credentialStore
  const previous = await readModelConfig(options)

  const issues = updateIssues(previous, config, credentials)
  if (issues.length > 0) throw invalidSubmitted(issues)
  await requireManagedCredentials(config, credentials, store)

  for (const [id, action] of Object.entries(credentials)) {
    await requireKeyring(() => (action === null ? store.delete(id) : store.set(id, action)))
  }

  const committed = await writeModelConfig(config, options)

  // Past the commit the JSON is authoritative, so a credential the removed UUID
  // left behind is inert: no saved connection can reach it. Cleanup may fail.
  const submitted = new Set(config.connections.map(({ id }) => id))
  for (const { id, provider } of previous.connections) {
    if (submitted.has(id) || providerTable[provider].authentication === 'external') continue
    await store.delete(id).catch(() => undefined)
  }

  return { config: committed, credentialStates: await credentialStates(committed, store) }
}
