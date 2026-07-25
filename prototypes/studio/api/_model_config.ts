import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import envPaths from 'env-paths'
import { z } from 'zod'
import { ApiError, boundedValidationDetails, type ValidationIssue } from './_http.js'
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

export function validateModelConfig(value: unknown, path: string): ModelConfig {
  const parsed = modelConfigSchema.safeParse(value)
  if (!parsed.success) {
    throw invalidModelConfig(
      path,
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
      parsed.error,
    )
  }

  const issues = semanticIssues(parsed.data)
  if (issues.length > 0) throw invalidModelConfig(path, issues)
  return parsed.data
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
 * Group 2 injects the real OS-keyring reader. Until then every managed or
 * optional connection reports `unavailable` rather than claiming a state.
 */
export type CredentialStateReader = (connection: ModelConnection) => Promise<'present' | 'absent'>

export async function credentialStates(
  config: ModelConfig,
  read?: CredentialStateReader,
): Promise<Record<string, CredentialState>> {
  const states: Record<string, CredentialState> = {}
  for (const connection of config.connections) {
    if (providerTable[connection.provider].authentication === 'external') continue
    if (!read) {
      states[connection.id] = 'unavailable'
      continue
    }
    try {
      states[connection.id] = await read(connection)
    } catch {
      states[connection.id] = 'unavailable'
    }
  }
  return states
}
