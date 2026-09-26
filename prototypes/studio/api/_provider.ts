import { execFile as execFileCallback, type ExecFileException } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { wrapLanguageModel, type LanguageModel } from 'ai'
import { createOllama } from 'ai-sdk-ollama'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { createCodexAppServer, type CodexAppServerProvider } from 'ai-sdk-provider-codex-cli'
import type {
  DeploymentModels,
  ModelConfig,
  ModelConnection,
  ModelDescriptor,
  ProbeResult,
  ProbeStatus,
  ProviderDescriptor,
  ProviderKind,
} from '../shared/modelConfig.contract.js'
import { selectedRoute, usesNuextractProtocol } from '../shared/modelConfig.contract.js'
import { DEPLOYMENT_IDS, deploymentModels } from './_deployment_models.js'
import { ApiError } from './_http.js'
import { systemCredentialStore, type CredentialStore } from './_keyring.js'


/** Internal adapter capability; routes always select output formatting automatically. */
export type JsonOutputCapability = 'prompt' | 'schema' | 'native'
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
export type ModelFactory = (connection: ModelConnection, modelId: string, credential: string | null) => LanguageModel

type ProviderEntry = ProviderDescriptor & {
  temperatureSupported: boolean
  discover(connection: ModelConnection, credential: string | null, context: DiscoveryContext): Promise<DiscoveryObservation>
  createModel: ModelFactory
}
export type ProviderTable = { [K in ProviderKind]: ProviderEntry & { kind: K } }

const MAX_DISCOVERY_BYTES = 1024 * 1024
const MAX_MODELS = 10_000
const MAX_MODEL_TEXT = 512
const MAX_MESSAGE_TEXT = 512

/** Truncate to `limit` code points, so a surrogate pair is never split. */
const boundText = (value: string, limit: number) => [...value].slice(0, limit).join('')

const PROBE_TIMEOUT_MS = 15_000
const execFile = promisify(execFileCallback)

/** A provider base already includes every researcher-supplied path prefix. */
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

/**
 * The pinned native binary, resolved like @openai/codex's own launcher. Spawning it
 * directly avoids Node refusing to spawn codex.CMD on Windows (EINVAL) and lets
 * SIGTERM reach the server process instead of an orphaning wrapper.
 */
function nativeCodexExecutable(): string {
  const launcher = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
  const platformPackage = createRequire(launcher).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)
  const systems: Record<string, string> = { win32: 'pc-windows-msvc', darwin: 'apple-darwin' }
  const target = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${systems[process.platform] ?? 'unknown-linux-musl'}`
  return join(dirname(platformPackage), 'vendor', target, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
}

export function createRestrictedCodexProvider(
  cwd: string,
  factory: typeof createCodexAppServer = createCodexAppServer,
): CodexAppServerProvider {
  return factory({
    defaultSettings: {
      approvalPolicy: 'never',
      codexPath: nativeCodexExecutable(),
      cwd,
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
        // Newer CLIs save this as a table, which the pinned CLI cannot parse; force the boolean.
        'features.context_management': false,
        'features.image_generation': false,
        'features.multi_agent': false,
        'features.shell_snapshot': false,
        'features.shell_tool': false,
        'features.tool_suggest': false,
        'features.unified_exec': false,
      },
    },
  })
}

// The app server owns a process and intentionally survives requests. Models are not cached.
let codexAppServer: CodexAppServerProvider | null = null
let codexSandboxDirectory: string | null = null
function codexProvider(): CodexAppServerProvider {
  if (codexAppServer) return codexAppServer
  const workingDirectory = isolatedCodexWorkingDirectory()
  try {
    codexAppServer = createRestrictedCodexProvider(workingDirectory)
    codexSandboxDirectory = workingDirectory
  } catch (cause) {
    try {
      rmSync(workingDirectory, { recursive: true, force: true })
    } catch {
      // Preserve the provider initialization failure.
    }
    throw cause
  }
  return codexAppServer
}

export async function closeProviderRuntime(): Promise<void> {
  const provider = codexAppServer
  const workingDirectory = codexSandboxDirectory
  codexAppServer = null
  codexSandboxDirectory = null
  try {
    await provider?.close()
  } finally {
    if (workingDirectory) await removeSandboxDirectory(workingDirectory)
  }
}

/** close() only signals the server; Windows keeps its cwd locked until the process exits. */
async function removeSandboxDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      rmSync(directory, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 19) console.warn('Could not remove the Codex sandbox directory.', directory, error)
      else await sleep(250)
    }
  }
}

export const providerRuntime = { close: closeProviderRuntime }

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
    if (body.exceeded) {
      return observation('invalid_response', 'The provider response exceeded the 1 MiB limit.')
    }
    if (!response.ok) {
      return response.status === 401 || response.status === 403
        ? observation('authentication_failed', 'The provider rejected authentication.')
        : observation('discovery_failed', 'The provider could not list models.')
    }

    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(body.bytes))
    } catch {
      return observation('invalid_response', 'The provider returned invalid JSON.')
    }
    try {
      const catalog = boundedCatalog(parse(value))
      return {
        status: 'connected',
        message: boundText(`Connected. ${catalog.length} model${catalog.length === 1 ? '' : 's'} available.`, MAX_MESSAGE_TEXT),
        catalog,
      }
    } catch {
      return observation('invalid_response', 'The provider returned an invalid model catalog.')
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

function observation(
  status: Exclude<ProbeStatus, 'connected' | 'timed_out'>,
  message: string,
): DiscoveryObservation {
  return {
    status,
    message: boundText(message, MAX_MESSAGE_TEXT),
    catalog: [],
  }
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
      [...model.id].length > MAX_MODEL_TEXT ||
      [...model.label].length > MAX_MODEL_TEXT
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

export const THINKING_OFF = { enable_thinking: false } as const

export function withThinkingOff(body: Record<string, unknown>): Record<string, unknown> {
  const kwargs = body.chat_template_kwargs
  return {
    ...body,
    chat_template_kwargs: { ...THINKING_OFF, ...(kwargs && typeof kwargs === 'object' ? kwargs : {}) },
  }
}

export const providerTable = {
  ollama: {
    // The SDK appends api/chat; FREE appends api/tags at its own call site.
    kind: 'ollama',
    label: 'Ollama',
    transport: 'http',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    authentication: 'optional',
    supportsNuextract: false,
    temperatureSupported: true,
    discover: httpDiscovery('api/tags', commonHttpHeaders, ollamaCatalog),
    createModel: (connection, modelId, credential) => {
      // ai-sdk-ollama does not forward call abort signals to client.chat.
      // Scope the HTTP signal to this call so cancellation also stops Ollama.
      // FREE validates output; the adapter must not regenerate or invent fallback values.
      const create = (signal?: AbortSignal) => createOllama({
        baseURL: connection.baseUrl!,
        ...(credential ? { apiKey: credential } : {}),
        fetch: (input, init) => fetch(input, { ...init, ...(signal ? {
          signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
        } : {}) }),
      })(modelId, { reliableObjectGeneration: false })
      return wrapLanguageModel({
        model: create(),
        middleware: {
          specificationVersion: 'v4',
          wrapGenerate: ({ params }) => create(params.abortSignal).doGenerate(params),
          wrapStream: ({ params }) => create(params.abortSignal).doStream(params),
        },
      })
    },
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI',
    transport: 'http',
    defaultBaseUrl: 'https://api.openai.com/v1',
    authentication: 'managed',
    supportsNuextract: false,
    temperatureSupported: true,
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
    supportsNuextract: false,
    temperatureSupported: true,
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
    supportsNuextract: false,
    temperatureSupported: true,
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
    supportsNuextract: false,
    temperatureSupported: false,
    discover: discoverCodex,
    createModel: (_connection, modelId) => codexProvider()(modelId),
  },
  'claude-code': {
    kind: 'claude-code',
    label: 'Claude Code',
    transport: 'cli',
    defaultBaseUrl: null,
    authentication: 'external',
    supportsNuextract: false,
    temperatureSupported: false,
    discover: discoverClaude,
    createModel: (_connection, modelId) => claudeCode(modelId, { tools: [], settingSources: [] }),
  },
  'openai-compatible': {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    transport: 'http',
    defaultBaseUrl: null,
    authentication: 'optional',
    supportsNuextract: false,
    temperatureSupported: true,
    discover: httpDiscovery('models', commonHttpHeaders, openAiCatalog),
    createModel: (connection, modelId, credential) =>
      createOpenAICompatible({
        name: 'free-openai-compatible',
        baseURL: connection.baseUrl!,
        supportsStructuredOutputs: true,
        ...(credential ? { apiKey: credential } : {}),
      }).chatModel(modelId),
  },
  vllm: {
    // An OpenAI-compatible vLLM server. Thinking is off unless a call asks for
    // it: under greedy decoding Qwen3.x can reason until max_tokens and answer
    // nothing. vLLM passes chat_template_kwargs to the model's chat template.
    kind: 'vllm',
    label: 'vLLM',
    transport: 'http',
    defaultBaseUrl: null,
    authentication: 'optional',
    supportsNuextract: true,
    temperatureSupported: true,
    discover: httpDiscovery('models', commonHttpHeaders, openAiCatalog),
    createModel: (connection, modelId, credential) =>
      createOpenAICompatible({
        name: 'free-vllm',
        baseURL: connection.baseUrl!,
        supportsStructuredOutputs: true,
        ...(credential ? { apiKey: credential } : {}),
        transformRequestBody: withThinkingOff,
      }).chatModel(modelId),
  },
} as const satisfies ProviderTable

/** A factory's result as the provider-model interface; the table's factories never return a global model ID. */
function providerModel(model: LanguageModel) {
  if (typeof model === 'string' || model.specificationVersion !== 'v4')
    throw new TypeError('A model factory returned no language model of the current specification.')
  return model
}

/**
 * A route's model for a connection with `hasKey`: the key is read inside each provider attempt and the provider
 * client is built for that attempt alone, as the Ollama adapter already builds its client per call. A replayed step
 * whose call is checkpointed never reaches here, so it never needs a key. The base model supplies metadata only and
 * is never called, so an anonymous request cannot happen.
 */
export function keyedModel(
  createModel: ModelFactory,
  connection: ModelConnection,
  modelId: string,
  key: (signal: AbortSignal | undefined) => Promise<string>,
): LanguageModel {
  const attempt = async (signal: AbortSignal | undefined) => {
    const credential = await key(signal)
    signal?.throwIfAborted()
    return providerModel(createModel(connection, modelId, credential))
  }
  return wrapLanguageModel({
    model: providerModel(createModel(connection, modelId, null)),
    middleware: {
      specificationVersion: 'v4',
      wrapGenerate: async ({ params }) => (await attempt(params.abortSignal)).doGenerate(params),
      wrapStream: async ({ params }) => (await attempt(params.abortSignal)).doStream(params),
    },
  })
}

/** Serializable metadata only; backend capabilities and functions never cross HTTP. */
export const PROVIDERS: readonly ProviderDescriptor[] = Object.values(providerTable).map(
  ({ kind, label, transport, defaultBaseUrl, authentication, supportsNuextract }) => ({
    kind,
    label,
    transport,
    defaultBaseUrl,
    authentication,
    supportsNuextract,
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

export type ModelOperation = 'schema-suggestion' | 'chat' | 'schema-edit'
/**
 * What actually ran, as the persisted result records it. Absent only for a
 * target a caller constructed itself instead of resolving from a route.
 */
export type ModelAttribution = { provider: ProviderKind; modelId: string }
export type GeneralExecutionTarget = {
  /** Automatic capability learning is scoped to the selected endpoint, model and route. */
  automaticOutputKey?: string
  profile: 'general'
  model: LanguageModel
  jsonOutput: JsonOutputCapability
  temperatureSupported: boolean
  attribution?: ModelAttribution
}
/** NuExtract on vLLM, driven by its chat template's own controls. */
export type NuExtractExecutionTarget = {
  profile: 'nuextract'
  modelId: string
  baseUrl: string
  authorization: string | null
  temperatureSupported: boolean
  attribution?: ModelAttribution
}
export type ExecutionTarget = GeneralExecutionTarget | NuExtractExecutionTarget

export type RouteResolverDependencies = {
  /** The configuration whose routes and connections the call may use: its caller's, never another account's. */
  readConfig: () => Promise<ModelConfig>
  /** The deployment's own model servers; read from the environment when omitted. */
  deployment?: DeploymentModels
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

const ROUTE_LABELS = { schemaSuggestion: 'Schema Suggestion', interaction: 'Interaction' } as const

export async function resolveCapabilityRoute(
  operation: ModelOperation,
  options: { temperature?: number } = {},
  dependencies: RouteResolverDependencies,
): Promise<ExecutionTarget> {
  const config = await dependencies.readConfig()
  const deployment = dependencies.deployment ?? deploymentModels()
  const routeKey = operation === 'schema-suggestion' ? 'schemaSuggestion' : 'interaction'
  const label = ROUTE_LABELS[routeKey]
  // An unset Schema Suggestion route follows the Interaction Route; an unset Interaction Route runs on the
  // deployment's instruction model, when it serves one.
  const route = selectedRoute(config.routes, routeKey, deployment.defaultRoute)
  if (!route) {
    throw new ApiError(409, 'invalid_model_config', `No model is configured for ${label}.`)
  }
  const connection = [...config.connections, ...deployment.connections].find(({ id }) => id === route.connectionId)
  if (!connection) {
    throw new ApiError(409, 'invalid_model_config', `The ${label} Route names a Model Connection that does not exist.`)
  }
  const entry = providerTable[connection.provider]
  if (options.temperature !== undefined && !entry.temperatureSupported) {
    throw new ApiError(400, 'unsupported_temperature', `${entry.label} does not support an explicit temperature.`)
  }
  // The deployment's own servers take no FREE-managed credential.
  const credential = DEPLOYMENT_IDS.has(connection.id)
    ? null
    : await resolvedCredential(connection, dependencies.credentialStore ?? systemCredentialStore)

  if (routeKey === 'schemaSuggestion' && usesNuextractProtocol(entry, route.modelId)) {
    if (connection.baseUrl === null) {
      throw new ApiError(409, 'invalid_model_config', 'The NuExtract protocol requires a vLLM Model Connection.')
    }
    return {
      profile: 'nuextract',
      modelId: route.modelId,
      baseUrl: connection.baseUrl,
      authorization: credential === null ? null : `Bearer ${credential}`,
      temperatureSupported: true,
      attribution: { provider: connection.provider, modelId: route.modelId },
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
    jsonOutput: ['anthropic', 'claude-code', 'openai-compatible', 'vllm'].includes(connection.provider) ? 'schema' : 'native',
    automaticOutputKey: JSON.stringify([connection.id, connection.provider, connection.baseUrl, route.modelId, routeKey]),
    temperatureSupported: entry.temperatureSupported,
    attribution: { provider: connection.provider, modelId: route.modelId },
  }
}
