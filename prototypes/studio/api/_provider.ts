import { execFile as execFileCallback, type ExecFileException } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { createCodexAppServer, type CodexAppServerProvider } from 'ai-sdk-provider-codex-cli'
import type {
  ImmediateUpstreamDetail,
  ModelConfig,
  ModelConnection,
  ModelDescriptor,
  ProbeResult,
  ProbeStatus,
  ProviderDescriptor,
  ProviderKind,
} from '../shared/modelConfig.contract.js'
import { ApiError } from './_http.js'
import { systemCredentialStore, type CredentialStore } from './_keyring.js'


export type JsonOutputCapability = 'native' | 'prompt'
type ExecutionCapability = 'general' | 'nuextract-raw'
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type CodexModel = { id: string; displayName?: string; name?: string | null; hidden?: boolean }

export type ProviderProbeDependencies = {
  fetch?: Fetch
  codexListModels?: (signal: AbortSignal) => Promise<readonly CodexModel[]>
  claudeStatus?: (signal: AbortSignal) => Promise<void>
  now?: () => Date
  timeoutMs?: number
}

type DiscoveryContext = Required<Pick<ProviderProbeDependencies, 'fetch' | 'codexListModels' | 'claudeStatus'>> & {
  signal: AbortSignal
}
type DiscoveryObservation = Omit<ProbeResult, 'checkedAt'>
type ModelFactory = (connection: ModelConnection, modelId: string, credential: string | null) => LanguageModel

type ProviderEntry = ProviderDescriptor & {
  jsonOutput: JsonOutputCapability
  temperatureSupported: boolean
  execution: readonly ExecutionCapability[]
  discover(connection: ModelConnection, credential: string | null, context: DiscoveryContext): Promise<DiscoveryObservation>
  createModel: ModelFactory
}
export type ProviderTable = { [K in ProviderKind]: ProviderEntry & { kind: K } }

const MAX_DISCOVERY_BYTES = 1024 * 1024
const MAX_UPSTREAM_BYTES = 8192
const MAX_MODELS = 10_000
const MAX_MODEL_TEXT = 512
const MAX_MESSAGE_TEXT = 512
const PROBE_TIMEOUT_MS = 15_000
const execFile = promisify(execFileCallback)

/** A provider API base already includes every researcher-supplied path prefix. */
export function appendProviderResource(baseUrl: string, resource: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${resource.replace(/^\/+/, '')}`
}

function isolatedCodexWorkingDirectory(): string {
  try {
    return mkdtempSync(join(tmpdir(), 'free-codex-sandbox-'))
  } catch (cause) {
    throw new ApiError(500, 'unexpected_failure', 'Could not initialize the Codex CLI provider.', { cause })
  }
}

// The app server owns a process and intentionally survives requests. Models are not cached.
let codexAppServer: CodexAppServerProvider | null = null
function codexProvider(): CodexAppServerProvider {
  codexAppServer ??= createCodexAppServer({
    defaultSettings: {
      approvalPolicy: 'never',
      codexPath: 'codex',
      cwd: isolatedCodexWorkingDirectory(),
      effort: 'none',
      sandboxPolicy: 'read-only',
      connectionTimeoutMs: PROBE_TIMEOUT_MS,
      requestTimeoutMs: PROBE_TIMEOUT_MS,
      idleTimeoutMs: 60_000,
      minCodexVersion: '0.144.0',
      logger: false,
      configOverrides: {
        mcp_servers: {},
        'tools.web_search': false,
        'features.apps': false,
        'features.browser_use': false,
        'features.code_mode_host': false,
        'features.computer_use': false,
        'features.image_generation': false,
        'features.multi_agent': false,
        'features.shell_snapshot': false,
        'features.shell_tool': false,
        'features.tool_suggest': false,
        'features.unified_exec': false,
      },
    },
  })
  return codexAppServer
}

async function productionCodexListModels(): Promise<readonly CodexModel[]> {
  return (await codexProvider().listModels()).models
}

async function productionClaudeStatus(signal: AbortSignal): Promise<void> {
  await execFile('claude', ['auth', 'status'], { signal })
}


function httpDiscovery(
  resource: string,
  headers: (credential: string | null) => Record<string, string>,
  parse: (value: unknown) => readonly ModelDescriptor[],
) {
  return async (
    connection: ModelConnection,
    credential: string | null,
    context: DiscoveryContext,
  ): Promise<DiscoveryObservation> => {
    let response: Response
    try {
      response = await context.fetch(appendProviderResource(connection.baseUrl!, resource), {
        method: 'GET',
        headers: headers(credential),
        signal: context.signal,
      })
    } catch (error) {
      if (context.signal.aborted) throw error
      return observation('unreachable', 'The provider could not be reached.')
    }

    const body = await readBoundedBody(response)
    const upstream = upstreamDetail(response.status, body.bytes)
    if (body.exceeded) {
      return observation('invalid_response', 'The provider response exceeded the 1 MiB limit.', upstream)
    }
    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? observation('authentication_failed', 'The provider rejected authentication.', upstream)
        : observation('discovery_failed', 'The provider could not list models.', upstream)
    }

    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(body.bytes))
    } catch {
      return observation('invalid_response', 'The provider returned invalid JSON.', upstream)
    }
    try {
      const catalog = boundedCatalog(parse(value))
      return {
        status: 'connected',
        message: boundText(`Connected. ${catalog.length} model${catalog.length === 1 ? '' : 's'} available.`, MAX_MESSAGE_TEXT),
        catalog,
      }
    } catch {
      return observation('invalid_response', 'The provider returned an invalid model catalog.', upstream)
    }
  }
}

async function readBoundedBody(response: Response): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  if (response.body === null) return { bytes: new Uint8Array(), exceeded: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let exceeded = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = MAX_DISCOVERY_BYTES - size
      if (remaining > 0) {
        const kept = value.byteLength <= remaining ? value : value.subarray(0, remaining)
        chunks.push(kept)
        size += kept.byteLength
      }
      if (value.byteLength > remaining) {
        exceeded = true
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { bytes, exceeded }
}

function upstreamDetail(status: number | null, bytes: Uint8Array): ImmediateUpstreamDetail {
  const truncated = bytes.byteLength > MAX_UPSTREAM_BYTES
  return {
    status,
    body: new TextDecoder().decode(truncated ? bytes.subarray(0, MAX_UPSTREAM_BYTES) : bytes),
    truncated,
  }
}

function observation(
  status: Exclude<ProbeStatus, 'connected' | 'timed_out'>,
  message: string,
  upstream?: ImmediateUpstreamDetail,
): DiscoveryObservation {
  return {
    status,
    message: boundText(message, MAX_MESSAGE_TEXT),
    catalog: [],
    ...(upstream ? { upstream } : {}),
  }
}

function boundText(value: string, limit: number): string {
  let codePoints = 0
  let end = 0
  for (const character of value) {
    if (codePoints === limit) break
    codePoints += 1
    end += character.length
  }
  return end === value.length ? value : value.slice(0, end)
}

function codePointLength(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) index += 1
    }
    count += 1
  }
  return count
}

function boundedCatalog(models: readonly ModelDescriptor[]): ModelDescriptor[] {
  const seen = new Set<string>()
  const catalog: ModelDescriptor[] = []
  for (const model of models) {
    if (
      typeof model.id !== 'string' ||
      typeof model.label !== 'string' ||
      model.id.length === 0 ||
      model.label.length === 0 ||
      codePointLength(model.id) > MAX_MODEL_TEXT ||
      codePointLength(model.label) > MAX_MODEL_TEXT
    ) {
      throw new Error('invalid model')
    }
    if (seen.has(model.id)) continue
    seen.add(model.id)
    if (seen.size > MAX_MODELS) throw new Error('too many models')
    catalog.push({ id: model.id, label: model.label })
  }
  return catalog
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('expected object')
  return value as Record<string, unknown>
}

function arrayField(value: unknown, field: string): readonly unknown[] {
  const array = record(value)[field]
  if (!Array.isArray(array)) throw new Error('expected array')
  return array
}

function stringField(value: unknown, field: string): string {
  const result = record(value)[field]
  if (typeof result !== 'string') throw new Error('expected string')
  return result
}

function openAiCatalog(value: unknown): ModelDescriptor[] {
  return arrayField(value, 'data').map((item) => {
    const id = stringField(item, 'id')
    const candidate = record(item).display_name
    return { id, label: typeof candidate === 'string' && candidate ? candidate : id }
  })
}

function ollamaCatalog(value: unknown): ModelDescriptor[] {
  return arrayField(value, 'models').map((item) => {
    const data = record(item)
    const id = typeof data.name === 'string' ? data.name : data.model
    if (typeof id !== 'string') throw new Error('expected model name')
    return { id, label: id }
  })
}

function googleCatalog(value: unknown): ModelDescriptor[] {
  return arrayField(value, 'models').map((item) => {
    const data = record(item)
    const name = stringField(data, 'name')
    const id = name.startsWith('models/') ? name.slice('models/'.length) : name
    return { id, label: typeof data.displayName === 'string' && data.displayName ? data.displayName : id }
  })
}

async function discoverCodex(
  _connection: ModelConnection,
  _credential: string | null,
  context: DiscoveryContext,
): Promise<DiscoveryObservation> {
  try {
    const models = await context.codexListModels(context.signal)
    const catalog = boundedCatalog(
      models.filter((model) => model.hidden !== true).map((model) => ({
        id: model.id,
        label: model.displayName || model.name || model.id,
      })),
    )
    return { status: 'connected', message: `Connected. ${catalog.length} models available.`, catalog }
  } catch (error) {
    if (context.signal.aborted) throw error
    return cliObservation(error)
  }
}

async function discoverClaude(
  _connection: ModelConnection,
  _credential: string | null,
  context: DiscoveryContext,
): Promise<DiscoveryObservation> {
  try {
    await context.claudeStatus(context.signal)
    const catalog = ['fable', 'opus', 'sonnet', 'haiku'].map((id) => ({ id, label: id }))
    return { status: 'connected', message: 'Connected. 4 models available.', catalog }
  } catch (error) {
    if (context.signal.aborted) throw error
    return cliObservation(error)
  }
}

function cliObservation(error: unknown): DiscoveryObservation {
  const data = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {}
  const code = data.code
  if (code === 'ENOENT') return observation('not_installed', 'The provider CLI is not installed.')
  const status = data.statusCode ?? data.exitCode
  const exception = error as ExecFileException
  const diagnostic = `${error instanceof Error ? error.message : ''} ${typeof exception.stderr === 'string' ? exception.stderr : ''}`
  if (status === 401 || /\b(auth(?:entication)?|unauthori[sz]ed|login|sign in)\b/i.test(diagnostic)) {
    return observation('authentication_failed', 'The provider CLI is not authenticated.')
  }
  return observation('discovery_failed', 'The provider CLI could not list models.')
}

const commonHttpHeaders = (credential: string | null): Record<string, string> => ({
  accept: 'application/json',
  ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
})

export const providerTable = {
  ollama: {
    kind: 'ollama',
    label: 'Ollama',
    transport: 'http',
    defaultBaseUrl: 'http://127.0.0.1:11434/api',
    authentication: 'optional',
    supportsNuextractRaw: true,
    jsonOutput: 'native',
    temperatureSupported: true,
    execution: ['general', 'nuextract-raw'],
    discover: httpDiscovery('tags', commonHttpHeaders, ollamaCatalog),
    createModel: (connection, modelId, credential) =>
      createOllama({ baseURL: connection.baseUrl!, ...(credential ? { apiKey: credential } : {}) })(modelId),
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    transport: 'http',
    defaultBaseUrl: 'https://api.openai.com/v1',
    authentication: 'managed',
    supportsNuextractRaw: false,
    jsonOutput: 'native',
    temperatureSupported: true,
    execution: ['general'],
    discover: httpDiscovery('models', commonHttpHeaders, openAiCatalog),
    createModel: (connection, modelId, credential) =>
      createOpenAI({ baseURL: connection.baseUrl!, apiKey: credential! }).responses(modelId),
  },
  anthropic: {
    kind: 'anthropic',
    label: 'Anthropic',
    transport: 'http',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    authentication: 'managed',
    supportsNuextractRaw: false,
    jsonOutput: 'prompt',
    temperatureSupported: true,
    execution: ['general'],
    discover: httpDiscovery(
      'models',
      (credential) => ({ accept: 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': credential! }),
      openAiCatalog,
    ),
    createModel: (connection, modelId, credential) =>
      createAnthropic({ baseURL: connection.baseUrl!, apiKey: credential! })(modelId),
  },
  google: {
    kind: 'google',
    label: 'Google',
    transport: 'http',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authentication: 'managed',
    supportsNuextractRaw: false,
    jsonOutput: 'native',
    temperatureSupported: true,
    execution: ['general'],
    discover: httpDiscovery(
      'models',
      (credential) => ({ accept: 'application/json', 'x-goog-api-key': credential! }),
      googleCatalog,
    ),
    createModel: (connection, modelId, credential) =>
      createGoogleGenerativeAI({ baseURL: connection.baseUrl!, apiKey: credential! })(modelId),
  },
  'codex-cli': {
    kind: 'codex-cli',
    label: 'Codex CLI',
    transport: 'cli',
    defaultBaseUrl: null,
    authentication: 'external',
    supportsNuextractRaw: false,
    jsonOutput: 'prompt',
    temperatureSupported: false,
    execution: ['general'],
    discover: discoverCodex,
    createModel: (_connection, modelId) => codexProvider()(modelId),
  },
  'claude-code': {
    kind: 'claude-code',
    label: 'Claude Code',
    transport: 'cli',
    defaultBaseUrl: null,
    authentication: 'external',
    supportsNuextractRaw: false,
    jsonOutput: 'prompt',
    temperatureSupported: false,
    execution: ['general'],
    discover: discoverClaude,
    createModel: (_connection, modelId) => claudeCode(modelId, { tools: [], settingSources: [] }),
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    transport: 'http',
    defaultBaseUrl: null,
    authentication: 'optional',
    supportsNuextractRaw: false,
    jsonOutput: 'prompt',
    temperatureSupported: true,
    execution: ['general'],
    discover: httpDiscovery('models', commonHttpHeaders, openAiCatalog),
    createModel: (connection, modelId, credential) =>
      createOpenAICompatible({
        name: 'free-openai-compatible',
        baseURL: connection.baseUrl!,
        ...(credential ? { apiKey: credential } : {}),
      }).chatModel(modelId),
  },
} as const satisfies ProviderTable

/** Serializable metadata only; backend capabilities and functions never cross HTTP. */
export const PROVIDERS: readonly ProviderDescriptor[] = Object.values(providerTable).map(
  ({ kind, label, transport, defaultBaseUrl, authentication, supportsNuextractRaw }) => ({
    kind,
    label,
    transport,
    defaultBaseUrl,
    authentication,
    supportsNuextractRaw,
  }),
)

export async function probeConnection(
  connection: ModelConnection,
  credential: string | null,
  dependencies: ProviderProbeDependencies = {},
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timeoutMs = dependencies.timeoutMs ?? PROBE_TIMEOUT_MS
  const timedOut = Symbol('timed out')
  let didTimeout = false
  const { promise: deadline, resolve: resolveDeadline } = Promise.withResolvers<typeof timedOut>()
  const timeout = setTimeout(() => {
    didTimeout = true
    resolveDeadline(timedOut)
    controller.abort()
  }, timeoutMs)
  const context: DiscoveryContext = {
    fetch: dependencies.fetch ?? fetch,
    codexListModels: dependencies.codexListModels ?? productionCodexListModels,
    claudeStatus: dependencies.claudeStatus ?? productionClaudeStatus,
    signal: controller.signal,
  }
  try {
    const pending = providerTable[connection.provider].discover(connection, credential, context)
    const result = await Promise.race([pending, deadline])
    if (result === timedOut) {
      return {
        checkedAt: (dependencies.now?.() ?? new Date()).toISOString(),
        status: 'timed_out',
        message: 'The provider check timed out.',
        catalog: [],
      }
    }
    return { checkedAt: (dependencies.now?.() ?? new Date()).toISOString(), ...result }
  } catch {
    if (didTimeout) {
      return {
        checkedAt: (dependencies.now?.() ?? new Date()).toISOString(),
        status: 'timed_out',
        message: 'The provider check timed out.',
        catalog: [],
      }
    }
    return {
      checkedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      ...observation('discovery_failed', 'The provider could not list models.'),
    }
  } finally {
    clearTimeout(timeout)
  }
}

export type ModelOperation = 'extraction' | 'schema-suggestion' | 'chat' | 'schema-edit'
export type GeneralExecutionTarget = {
  profile: 'general'
  model: LanguageModel
  jsonOutput: JsonOutputCapability
  temperatureSupported: boolean
}
export type NuExtractRawExecutionTarget = {
  profile: 'nuextract-raw'
  modelId: string
  baseUrl: string
  authorization: string | null
  temperatureSupported: boolean
}
export type ExecutionTarget = GeneralExecutionTarget | NuExtractRawExecutionTarget

export type RouteResolverDependencies = {
  config?: ModelConfig
  readConfig?: () => Promise<ModelConfig>
  credentialStore?: CredentialStore
  modelFactories?: Partial<Record<ProviderKind, ModelFactory>>
}


async function resolvedCredential(
  connection: ModelConnection,
  store: CredentialStore,
): Promise<string | null> {
  const authentication = providerTable[connection.provider].authentication
  if (authentication === 'external') return null
  try {
    const value = await store.get?.(connection.id)
    // Loose null: the keyring resolves `null`, not `undefined`, for a missing entry.
    if (value != null) return value
    if (authentication === 'optional') return null
  } catch (cause) {
    if (authentication === 'optional') return null
    throw new ApiError(503, 'keyring_unavailable', 'The operating system credential store is unavailable.', { cause })
  }
  throw new ApiError(409, 'invalid_model_config', 'The selected Model Connection requires a credential.')
}

export async function resolveCapabilityRoute(
  operation: ModelOperation,
  options: { temperature?: number } = {},
  dependencies: RouteResolverDependencies = {},
): Promise<ExecutionTarget> {
  let config = dependencies.config
  if (!config) {
    if (!dependencies.readConfig) {
      throw new ApiError(500, 'unexpected_failure', 'The model configuration reader is unavailable.')
    }
    config = await dependencies.readConfig()
  }
  const key = operation === 'extraction' || operation === 'schema-suggestion' ? 'extraction' : 'interaction'
  const route = config.routes?.[key]
  if (!route) {
    throw new ApiError(409, 'invalid_model_config', `The ${key} Capability Route is not configured.`)
  }
  const connection = config.connections.find(({ id }) => id === route.connectionId)
  if (!connection) {
    throw new ApiError(409, 'invalid_model_config', `The ${key} Capability Route is invalid.`)
  }
  const entry = providerTable[connection.provider]
  if (options.temperature !== undefined && !entry.temperatureSupported) {
    throw new ApiError(400, 'unsupported_temperature', `${entry.label} does not support an explicit temperature.`)
  }
  const credential = await resolvedCredential(connection, dependencies.credentialStore ?? systemCredentialStore)

  if (key === 'extraction' && 'nuextractRaw' in route && route.nuextractRaw === true) {
    if (connection.provider !== 'ollama' || connection.baseUrl === null) {
      throw new ApiError(409, 'invalid_model_config', 'Raw NuExtract requires an Ollama Model Connection.')
    }
    return {
      profile: 'nuextract-raw',
      modelId: route.modelId,
      baseUrl: connection.baseUrl,
      authorization: credential === null ? null : `Bearer ${credential}`,
      temperatureSupported: true,
    }
  }
  if (connection.baseUrl === null && entry.transport === 'http') {
    throw new ApiError(409, 'invalid_model_config', 'The selected Model Connection has no API base.')
  }
  const createModel = dependencies.modelFactories?.[connection.provider] ?? entry.createModel
  let model: LanguageModel
  try {
    model = createModel(connection, route.modelId, credential)
  } catch (cause) {
    throw new ApiError(502, 'model_operation_failed', 'The selected provider could not be initialized.', { cause })
  }
  return {
    profile: 'general',
    model,
    jsonOutput: entry.jsonOutput,
    temperatureSupported: entry.temperatureSupported,
  }
}
