import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateText, NoObjectGeneratedError, Output } from 'ai'
import { z } from 'zod'
import { DEPLOYMENT_CONNECTION_IDS, type ModelConfig, type ModelConnection } from '../shared/modelConfig.contract.js'
import {
  PROVIDERS,
  appendProviderResource,
  createRestrictedCodexProvider,
  keyedModel,
  probeConnection,
  providerTable,
  resolveCapabilityRoute,
  withThinkingOff,
  type ExecutionTarget,
  type NuExtractExecutionTarget,
  type RouteResolverDependencies,
} from './_provider.js'
import { ModelKeyRequiredError, createModelKeyCache } from './_model_keys.js'

const stepStatus = vi.hoisted(() => ({ current: undefined as undefined | { cancelSignal: AbortSignal } }))
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { get stepStatus() { return stepStatus.current } } }))

const ID = '11111111-1111-4111-8111-111111111111'
const connection: ModelConnection = {
  id: ID,
  name: 'Gateway',
  provider: 'openai-compatible',
  baseUrl: 'https://host.example/proxy/openai/v1',
  hasKey: false,
}
const ACCOUNT = '11111111-1111-4111-8111-1111111111a1'
const OTHER_ACCOUNT = '11111111-1111-4111-8111-1111111111a2'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.useRealTimers()
  stepStatus.current = undefined
})

function routed(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    connections: [connection],
    routes: {
      schemaSuggestion: { connectionId: ID, modelId: 'manual/model' },
      interaction: { connectionId: ID, modelId: 'manual/model' },
    },
    extractionModels: {},
    ingestionModels: {},
    ...overrides,
  }
}

describe('provider table', () => {
  it('validates Ollama output without hidden regeneration or fabricated fallback values', async () => {
    const request = vi.fn(async () => Response.json({
      model: 'manual/model', created_at: '2026-09-10T00:00:00Z',
      message: { role: 'assistant', content: '' },
      done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1,
    }))
    vi.stubGlobal('fetch', request)
    const model = providerTable.ollama.createModel(
      { ...connection, provider: 'ollama', baseUrl: 'http://ollama.example' }, 'manual/model', null,
    )
    const result = await generateText({
      model, prompt: 'Extract records.', maxRetries: 0, reasoning: 'none',
      output: Output.object({ schema: z.object({ records: z.array(z.object({ name: z.string() })).nullable() }) }),
    }).catch((error: unknown) => error)

    expect.soft(request).toHaveBeenCalledTimes(1)
    expect(result).toBeInstanceOf(NoObjectGeneratedError)
  })

  it('passes each Ollama request cancellation through to its HTTP transport', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    vi.stubGlobal('fetch', vi.fn(async (_input, init: RequestInit | undefined) => {
      requestSignal = init?.signal
      controller.abort()
      if (requestSignal?.aborted) throw requestSignal.reason
      return Response.json({ model: 'manual/model', created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'unexpected completion' }, done: true,
        done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 })
    }))
    const model = providerTable.ollama.createModel(
      { ...connection, provider: 'ollama', baseUrl: 'http://ollama.example' }, 'manual/model', null,
    )
    await expect(generateText({ model, prompt: 'test cancellation', abortSignal: controller.signal, maxRetries: 0 }))
      .rejects.toThrow()
    expect(requestSignal?.aborted).toBe(true)
  })

  it.each([
    ['a keyless connection calls ollama.com anonymously', null, null],
    ['a keyed connection sends its own key', 'sk-test-ollama-own', 'Bearer sk-test-ollama-own'],
  ])('never sends OLLAMA_API_KEY from the environment: %s', async (_label, credential, expected) => {
    vi.stubEnv('OLLAMA_API_KEY', 'sk-test-ollama-environment')
    const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      model: 'manual/model', created_at: '2026-09-26T00:00:00Z',
      message: { role: 'assistant', content: 'ok' },
      done: true, done_reason: 'stop', prompt_eval_count: 1, eval_count: 1,
    }))
    vi.stubGlobal('fetch', request)
    const model = providerTable.ollama.createModel(
      { ...connection, provider: 'ollama', baseUrl: 'https://ollama.com' }, 'manual/model', credential,
    )

    await generateText({ model, prompt: 'Hi', maxRetries: 0 })

    expect(request).toHaveBeenCalledTimes(1)
    expect(new Headers(request.mock.calls[0]![1]?.headers).get('authorization')).toBe(expected)
  })

  it('points Codex at the installed native executable, never a Windows launcher script', () => {
    const create = vi.fn<(options: { defaultSettings: { codexPath: string } }) => never>(() => ({}) as never)
    createRestrictedCodexProvider('/tmp/free-codex-sandbox', create as never)
    const { codexPath } = create.mock.calls[0]![0].defaultSettings
    expect(codexPath).not.toMatch(/\.(?:cmd|bat|js)$/i)
    expect(existsSync(codexPath)).toBe(true)
  })

  it('creates Codex with every local tool surface disabled', () => {
    const provider = vi.fn() as never
    const create = vi.fn(() => provider)

    expect(
      createRestrictedCodexProvider('/tmp/free-codex-sandbox', create as never),
    ).toBe(provider)
    expect(create).toHaveBeenCalledWith({
      defaultSettings: {
        approvalPolicy: 'never',
        codexPath: expect.stringMatching(/[\\/]vendor[\\/][^\\/]+[\\/]bin[\\/]codex(?:\.exe)?$/),
        cwd: '/tmp/free-codex-sandbox',
        effort: 'none',
        sandboxPolicy: 'read-only',
        connectionTimeoutMs: 15_000,
        requestTimeoutMs: 15_000,
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
  })

  it.each([
    ['default server', 'http://127.0.0.1:11434', 'http://127.0.0.1:11434/api/chat'],
    ['path-prefixed server', 'https://gateway.example/ollama/', 'https://gateway.example:443/ollama/api/chat'],
  ])('sends general Ollama generation from the %s base to the native chat endpoint', async (_label, baseUrl, expectedUrl) => {
    const request = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url !== expectedUrl) {
        return new Response('404 page not found', { status: 404 })
      }
      return new Response(JSON.stringify({
        model: 'manual/model',
        created_at: '2026-07-27T00:00:00Z',
        message: { role: 'assistant', content: '{"grave":[]}' },
        done: true,
        done_reason: 'stop',
        total_duration: 1,
        load_duration: 1,
        prompt_eval_count: 1,
        prompt_eval_duration: 1,
        eval_count: 1,
        eval_duration: 1,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', request)

    const model = providerTable.ollama.createModel(
      { ...connection, provider: 'ollama', baseUrl },
      'manual/model',
      null,
    )
    await generateText({ model, prompt: 'Generate a schema.' })

    expect(request).toHaveBeenCalled()
    expect(String(request.mock.calls[0][0])).toBe(expectedUrl)
  })

  it('exposes only all seven serializable descriptors in stable order', () => {
    expect(PROVIDERS.map(({ kind }) => kind)).toEqual([
      'ollama',
      'openai',
      'anthropic',
      'google',
      'codex-cli',
      'claude-code',
      'openai-compatible',
      'vllm',
    ])
    expect(Object.keys(providerTable)).toEqual(PROVIDERS.map(({ kind }) => kind))
    for (const descriptor of PROVIDERS) {
      expect(Object.keys(descriptor).sort()).toEqual([
        'authentication',
        'defaultBaseUrl',
        'kind',
        'label',
        'supportsNuextract',
        'transport',
      ])
    }
  })

  it('joins resources below the exact stored API base', () => {
    expect(appendProviderResource(connection.baseUrl!, 'models')).toBe(
      'https://host.example/proxy/openai/v1/models',
    )
    expect(appendProviderResource('https://host.example/v1/', '/chat/completions')).toBe(
      'https://host.example/v1/chat/completions',
    )
  })
})

describe('keyedModel', () => {
  const vllm: ModelConnection = { ...connection, provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1' }
  const completion = () => Response.json({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  it('builds the provider client per attempt with the key read inside that attempt', async () => {
    const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => completion())
    vi.stubGlobal('fetch', request)
    const keys = ['sk-test-attempt-1', 'sk-test-attempt-2']
    const key = vi.fn(async () => keys.shift()!)
    const model = keyedModel(providerTable.vllm.createModel, vllm, 'm', key)

    await generateText({ model, prompt: 'Hi', maxRetries: 0 })
    await generateText({ model, prompt: 'Hi', maxRetries: 0 })

    expect(key).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')))
      .toEqual(['Bearer sk-test-attempt-1', 'Bearer sk-test-attempt-2'])
  })

  it('never calls the server when the key is missing, and the AI SDK does not retry model_key_required', async () => {
    const request = vi.fn(async () => completion())
    vi.stubGlobal('fetch', request)
    const key = vi.fn(async () => {
      throw new ModelKeyRequiredError()
    })
    const model = keyedModel(providerTable.vllm.createModel, vllm, 'm', key)

    await expect(generateText({ model, prompt: 'Hi' })).rejects.toBeInstanceOf(ModelKeyRequiredError)
    expect(key).toHaveBeenCalledTimes(1)
    expect(request).not.toHaveBeenCalled()
  })

  it('stops before the provider when the signal aborts during the wait', async () => {
    const request = vi.fn(async () => completion())
    vi.stubGlobal('fetch', request)
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const arrival = Promise.withResolvers<string>()
    const key = vi.fn(() => arrival.promise)
    const model = keyedModel(providerTable.vllm.createModel, vllm, 'm', key)

    const call = generateText({ model, prompt: 'Hi', abortSignal: controller.signal, maxRetries: 0 })
      .catch((error: unknown) => error)
    await vi.waitFor(() => expect(key).toHaveBeenCalledOnce())
    controller.abort(reason)
    // The key still arrives after the abort; the attempt must not use it.
    arrival.resolve('sk-test-late')

    expect(await call).toBe(reason)
    expect(request).not.toHaveBeenCalled()
  })
})

describe('probeConnection', () => {
  it('discovers the selected HTTP protocol without generation', async () => {
    const request = vi.fn(async () => Response.json({ data: [{ id: 'custom-model' }] }))
    const result = await probeConnection(connection, 'secret', {
      fetch: request,
      now: () => new Date('2026-07-25T12:00:00Z'),
    })

    expect(request).toHaveBeenCalledWith('https://host.example/proxy/openai/v1/models', {
      method: 'GET',
      headers: { accept: 'application/json', authorization: 'Bearer secret' },
      signal: expect.any(AbortSignal),
    })
    expect(result).toMatchObject({
      checkedAt: '2026-07-25T12:00:00.000Z',
      status: 'connected',
      catalog: [{ id: 'custom-model', label: 'custom-model' }],
    })
  })

  it.each([
    ['ollama', 'api/tags', { models: [{ name: 'llama-local' }] }, 'llama-local', 'authorization', 'Bearer secret'],
    ['openai', 'models', { data: [{ id: 'gpt-native' }] }, 'gpt-native', 'authorization', 'Bearer secret'],
    ['anthropic', 'models', { data: [{ id: 'claude-native', display_name: 'Claude' }] }, 'claude-native', 'x-api-key', 'secret'],
    ['google', 'models', { models: [{ name: 'models/gemini-native', displayName: 'Gemini' }] }, 'gemini-native', 'x-goog-api-key', 'secret'],
    ['openai-compatible', 'models', { data: [{ id: 'chat-compatible' }] }, 'chat-compatible', 'authorization', 'Bearer secret'],
  ] as const)(
    'discovers %s with its native catalog shape and native auth header',
    async (provider, resource, payload, modelId, headerName, headerValue) => {
      const request = vi.fn(async () => Response.json(payload))
      const result = await probeConnection(
        { ...connection, provider, baseUrl: 'https://gateway.example/prefix/v1' },
        'secret',
        { fetch: request },
      )
      expect(request).toHaveBeenCalledWith(
        `https://gateway.example/prefix/v1/${resource}`,
        expect.objectContaining({ method: 'GET' }),
      )
      // The credential must ride the provider's own header and nowhere else: not
      // in the URL, and not under another provider's header name.
      const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
      const headers = init.headers as Record<string, string>
      expect(headers[headerName]).toBe(headerValue)
      expect(url).not.toContain('secret')
      for (const other of ['authorization', 'x-api-key', 'x-goog-api-key'].filter((key) => key !== headerName)) {
        expect(headers[other]).toBeUndefined()
      }
      expect(result).toMatchObject({ status: 'connected', catalog: [expect.objectContaining({ id: modelId })] })
    },
  )

  it('discovers Codex models through listModels without generation', async () => {
    const listModels = vi.fn(async () => [{ id: 'gpt-codex', displayName: 'Codex' }])
    const result = await probeConnection(
      { ...connection, provider: 'codex-cli', baseUrl: null },
      null,
      { codexListModels: listModels },
    )
    expect(listModels).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ status: 'connected', catalog: [{ id: 'gpt-codex', label: 'Codex' }] })
  })

  it('enforces FREE wall-clock timeout independently of an adapter', async () => {
    const result = await probeConnection(connection, null, {
      fetch: async () => Promise.withResolvers<Response>().promise,
      timeoutMs: 5,
    })
    expect(result).toMatchObject({ status: 'timed_out', catalog: [] })
  })

  it('returns negative HTTP observations as bounded results', async () => {
    const result = await probeConnection(connection, null, {
      fetch: async () => new Response('denied', { status: 401 }),
    })
    expect(result).toMatchObject({
      status: 'authentication_failed',
      catalog: [],
    })
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain('denied')
  })

  it.each([
    [401, 'denied'],
    [403, 'forbidden'],
    [200, '{malformed'],
    [200, JSON.stringify({ unexpected: [] })],
  ])('suppresses upstream detail for credential-bearing HTTP observations (%s)', async (status, body) => {
    const result = await probeConnection(connection, 'secret', {
      fetch: async () => new Response(body, { status }),
    })
    expect(result.status).toBe(status === 401 || status === 403 ? 'authentication_failed' : 'invalid_response')
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it.each([
    ['unreachable', async () => { throw new TypeError('fetch failed') }],
    ['discovery_failed', async () => new Response('failed', { status: 500 })],
    ['invalid_response', async () => Response.json({ unexpected: [] })],
  ] as const)('classifies HTTP %s observations without throwing', async (status, request) => {
    const result = await probeConnection(connection, null, { fetch: request })
    expect(result).toMatchObject({ status, catalog: [] })
  })

  it('classifies a missing CLI without generation', async () => {
    const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' })
    const result = await probeConnection(
      { ...connection, provider: 'codex-cli', baseUrl: null },
      null,
      { codexListModels: async () => { throw missing } },
    )
    expect(result).toMatchObject({ status: 'not_installed', catalog: [] })
  })

  it('rejects oversized responses, catalogs, and model fields at their exact boundaries', async () => {
    const oversized = await probeConnection(connection, null, {
      fetch: async () => new Response('x'.repeat(1_048_577)),
    })
    const tooMany = await probeConnection(connection, null, {
      fetch: async () => Response.json({
        data: Array.from({ length: 10_001 }, (_, id) => ({ id: String(id) })),
      }),
    })
    const tooLong = await probeConnection(connection, null, {
      fetch: async () => Response.json({ data: [{ id: 'x'.repeat(513) }] }),
    })
    expect([oversized.status, tooMany.status, tooLong.status]).toEqual([
      'invalid_response',
      'invalid_response',
      'invalid_response',
    ])
    expect(oversized).not.toHaveProperty('upstream')
  })

  it('keeps concurrent probes independent', async () => {
    // Task 3.4: probes are ephemeral and hold no shared state, so overlapping
    // checks of different connections must not exchange catalogs or statuses.
    const respond = (body: string, init?: ResponseInit) => async (url: string | URL | Request) => {
      await new Promise((resolve) => setTimeout(resolve, String(url).includes('slow') ? 10 : 0))
      return new Response(body, init)
    }
    const [fast, slow, failing] = await Promise.all([
      probeConnection({ ...connection, baseUrl: 'https://fast.example/v1' }, null, {
        fetch: respond(JSON.stringify({ data: [{ id: 'fast-model' }] })),
      }),
      probeConnection({ ...connection, baseUrl: 'https://slow.example/v1' }, null, {
        fetch: respond(JSON.stringify({ data: [{ id: 'slow-model' }] })),
      }),
      probeConnection({ ...connection, baseUrl: 'https://denied.example/v1' }, null, {
        fetch: respond('denied', { status: 401 }),
      }),
    ])

    expect(fast.catalog.map(({ id }) => id)).toEqual(['fast-model'])
    expect(slow.catalog.map(({ id }) => id)).toEqual(['slow-model'])
    expect(failing).toMatchObject({ status: 'authentication_failed', catalog: [] })
  })

  it('returns the exact static Claude aliases after an auth check', async () => {
    const result = await probeConnection(
      { ...connection, provider: 'claude-code', baseUrl: null },
      null,
      { claudeStatus: async () => undefined },
    )
    expect(result.catalog.map(({ id }) => id)).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })
})

describe('a route reads its key inside each provider attempt', () => {
  const keyed: ModelConnection = { ...connection, provider: 'vllm', baseUrl: 'http://lab.example:8000/v1', hasKey: true }
  const address = { provider: keyed.provider, baseUrl: keyed.baseUrl }
  const NO_DEPLOYMENT = { connections: [], defaultRoute: null }
  const completion = () => Response.json({
    id: 'x', object: 'chat.completion', created: 0, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
  function serve() {
    const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => completion())
    vi.stubGlobal('fetch', request)
    return request
  }
  const authorizations = (request: ReturnType<typeof serve>) =>
    request.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))
  function model(target: ExecutionTarget) {
    if (target.profile !== 'general') throw new Error('Expected general execution')
    return target.model
  }
  const resolveInteraction = (dependencies: Partial<RouteResolverDependencies> = {}) => resolveCapabilityRoute('schema-edit', {}, {
    researcherAccountId: ACCOUNT,
    readConfig: async () => routed({ connections: [keyed] }),
    deployment: NO_DEPLOYMENT,
    keyWaitMs: 50,
    ...dependencies,
  })

  it('a hasKey route with no cached key waits, then fails with model_key_required without calling its server', async () => {
    vi.useFakeTimers()
    const request = serve()
    const target = await resolveInteraction({ keys: createModelKeyCache() })
    let settled: unknown
    const call = generateText({ model: model(target), prompt: 'Hi' }).catch((error: unknown) => (settled = error))

    await vi.advanceTimersByTimeAsync(49)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await call

    // Not retried by the AI SDK: one wait, then the terminal failure.
    expect(settled).toBeInstanceOf(ModelKeyRequiredError)
    expect(settled).toMatchObject({ status: 409, code: 'model_key_required', isRetryable: false })
    expect(request).not.toHaveBeenCalled()
  })

  it('a managed provider never falls back to its key in the environment: an empty cache ends in model_key_required', async () => {
    vi.useFakeTimers()
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai-environment')
    const request = serve()
    const openai: ModelConnection = { ...keyed, provider: 'openai', baseUrl: 'https://api.openai.com/v1' }
    const target = await resolveInteraction({ keys: createModelKeyCache(), readConfig: async () => routed({ connections: [openai] }) })
    const call = generateText({ model: model(target), prompt: 'Hi' }).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(50)

    expect(await call).toMatchObject({ code: 'model_key_required' })
    expect(request).not.toHaveBeenCalled()
  })

  it('a key sent during the wait is used for that attempt', async () => {
    vi.useFakeTimers()
    const request = serve()
    const keys = createModelKeyCache()
    const target = await resolveInteraction({ keys })
    const call = generateText({ model: model(target), prompt: 'Hi', maxRetries: 0 })

    await vi.advanceTimersByTimeAsync(20)
    expect(request).not.toHaveBeenCalled()
    keys.put(ACCOUNT, keyed.id, address, 'sk-test-late')
    await call

    expect(authorizations(request)).toEqual(['Bearer sk-test-late'])
  })

  it('a keyless connection calls its server anonymously and never reads the cache', async () => {
    const request = serve()
    const keys = createModelKeyCache()
    keys.put(ACCOUNT, keyed.id, address, 'sk-test-never-used')
    const read = vi.spyOn(keys, 'read')
    const wait = vi.spyOn(keys, 'wait')
    const target = await resolveInteraction({ keys, readConfig: async () => routed({ connections: [{ ...keyed, hasKey: false }] }) })

    await generateText({ model: model(target), prompt: 'Hi', maxRetries: 0 })

    expect(authorizations(request)).toEqual([null])
    expect(read).not.toHaveBeenCalled()
    expect(wait).not.toHaveBeenCalled()
  })

  it('a deployment connection is anonymous', async () => {
    const request = serve()
    const keys = createModelKeyCache()
    const deployed: ModelConnection = {
      id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment', provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1', hasKey: false,
    }
    keys.put(ACCOUNT, deployed.id, { provider: 'vllm', baseUrl: deployed.baseUrl }, 'sk-test-never-used')
    const wait = vi.spyOn(keys, 'wait')
    const target = await resolveInteraction({
      keys,
      readConfig: async () => routed({ connections: [], routes: { schemaSuggestion: null, interaction: null } }),
      deployment: { connections: [deployed], defaultRoute: { connectionId: deployed.id, modelId: 'm' } },
    })

    await generateText({ model: model(target), prompt: 'Hi', maxRetries: 0 })

    expect(authorizations(request)).toEqual([null])
    expect(wait).not.toHaveBeenCalled()
  })

  it("no account's call uses another account's key", async () => {
    vi.useFakeTimers()
    const request = serve()
    const keys = createModelKeyCache()
    // Both accounts name the same connection ID; only A's browser sent a key.
    keys.put(ACCOUNT, keyed.id, address, 'sk-test-account-a')
    const target = await resolveInteraction({ keys, researcherAccountId: OTHER_ACCOUNT })
    const call = generateText({ model: model(target), prompt: 'Hi', maxRetries: 0 }).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(50)

    expect(await call).toBeInstanceOf(ModelKeyRequiredError)
    expect(request).not.toHaveBeenCalled()
  })

  it('an aborted call stops waiting for its key and never reaches the server', async () => {
    const request = serve()
    const target = await resolveInteraction({ keys: createModelKeyCache(), keyWaitMs: 60_000 })
    const controller = new AbortController()
    const reason = new Error('client disconnected')
    const call = generateText({ model: model(target), prompt: 'Hi', abortSignal: controller.signal, maxRetries: 0 })
      .catch((error: unknown) => error)

    controller.abort(reason)

    expect(await call).toBe(reason)
    expect(request).not.toHaveBeenCalled()
  })

  /** A v4 model stand-in that records each attempt's abortSignal and answers one word. */
  function recordingModel() {
    const signals: (AbortSignal | undefined)[] = []
    const model = {
      specificationVersion: 'v4' as const,
      provider: 'stand-in',
      modelId: 'stand-in',
      supportedUrls: {},
      doGenerate: async (params: { abortSignal?: AbortSignal }) => {
        signals.push(params.abortSignal)
        return {
          content: [{ type: 'text' as const, text: 'ok' }],
          finishReason: 'stop' as const,
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }
      },
      doStream: async () => { throw new Error('not streamed') },
    }
    return { model, signals }
  }

  it("every general model's provider call receives the step's cancel signal, keyed or keyless", async () => {
    const cancel = new AbortController()
    stepStatus.current = { cancelSignal: cancel.signal }
    const keys = createModelKeyCache()
    keys.put(ACCOUNT, keyed.id, address, 'sk-test-present')
    const withKey = recordingModel()
    const keyless = recordingModel()
    const keyedTarget = await resolveInteraction({ keys, modelFactories: { vllm: () => withKey.model as never } })
    const keylessTarget = await resolveInteraction({
      keys, readConfig: async () => routed({ connections: [{ ...keyed, hasKey: false }] }), modelFactories: { vllm: () => keyless.model as never },
    })

    await generateText({ model: model(keyedTarget), prompt: 'x', maxRetries: 0 })
    await generateText({ model: model(keylessTarget), prompt: 'x', maxRetries: 0 })
    expect(withKey.signals).toHaveLength(1)
    expect(keyless.signals).toHaveLength(1)
    expect(withKey.signals[0]?.aborted).toBe(false)
    cancel.abort(new Error('workflow cancelled'))

    expect(withKey.signals[0]?.aborted).toBe(true)
    expect(keyless.signals[0]?.aborted).toBe(true)
  })

  it("a keyed model's key wait ends on the step's cancel signal and never calls the provider", async () => {
    const cancel = new AbortController()
    stepStatus.current = { cancelSignal: cancel.signal }
    const standIn = recordingModel()
    const target = await resolveInteraction({ keys: createModelKeyCache(), keyWaitMs: 60_000, modelFactories: { vllm: () => standIn.model as never } })
    const reason = new Error('workflow cancelled')
    const call = generateText({ model: model(target), prompt: 'x', maxRetries: 0 }).catch((error: unknown) => error)

    cancel.abort(reason)

    expect(await call).toBe(reason)
    expect(standIn.signals).toHaveLength(0)
  })

  it('the NuExtract target of a hasKey connection reads the same key lazily', async () => {
    const keys = createModelKeyCache()
    const target = await resolveCapabilityRoute('schema-suggestion', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({
        connections: [keyed],
        routes: { schemaSuggestion: { connectionId: keyed.id, modelId: 'numind/NuExtract3-FP8' }, interaction: null },
      }),
      deployment: NO_DEPLOYMENT,
      keys,
      keyWaitMs: 50,
    }) as NuExtractExecutionTarget

    keys.put(ACCOUNT, keyed.id, address, 'sk-test-nuextract')
    await expect(target.key(undefined)).resolves.toBe('sk-test-nuextract')
    keys.remove(ACCOUNT, keyed.id)
    vi.useFakeTimers()
    const missing = target.key(undefined).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(50)
    expect(await missing).toBeInstanceOf(ModelKeyRequiredError)
  })
})

describe('resolveCapabilityRoute', () => {
  it.each(['schema-suggestion', 'schema-edit'] as const)(
    'keeps an existing route usable for %s without an output setting', async (operation) => {
      const config = routed()
      const createModel = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
      await expect(resolveCapabilityRoute(operation, {}, {
        researcherAccountId: ACCOUNT,
        readConfig: async () => config,
        modelFactories: { 'openai-compatible': createModel },
      })).resolves.toMatchObject({ profile: 'general', jsonOutput: 'schema', automaticOutputKey: expect.any(String) })
      expect(createModel).toHaveBeenCalledOnce()
    },
  )

  it('passes an arbitrary saved model ID to the exact selected factory', async () => {
    const createModel = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    const target = await resolveCapabilityRoute('schema-edit', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed(),
      modelFactories: { 'openai-compatible': createModel },
    })
    expect(target).toMatchObject({ profile: 'general', jsonOutput: 'schema' })
    expect(createModel).toHaveBeenCalledWith(connection, 'manual/model', null)
  })

  it.each([
    ['ollama', 'http://127.0.0.1:11434', 'native', true],
    ['openai', 'https://api.openai.com/v1', 'native', true],
    ['anthropic', 'https://api.anthropic.com/v1', 'schema', true],
    ['google', 'https://generativelanguage.googleapis.com/v1beta', 'native', true],
    ['codex-cli', null, 'native', false],
    ['claude-code', null, 'schema', false],
    ['openai-compatible', 'https://gateway.example/v1', 'schema', true],
    ['vllm', 'http://extraction_model:8000/v1', 'schema', true],
  ] as const)('constructs the exact %s general target', async (provider, baseUrl, jsonOutput, temperatureSupported) => {
    // A hosted provider always uses a key, so its model is the keyed wrapper around the same provider model.
    const selected = { ...connection, provider, baseUrl, hasKey: ['openai', 'anthropic', 'google'].includes(provider) }
    // A CLI kind is never a researcher connection: it is the deployment's, under its reserved ID.
    const cliId = provider === 'codex-cli' ? DEPLOYMENT_CONNECTION_IDS.codexCli : DEPLOYMENT_CONNECTION_IDS.claudeCode
    const cli = { ...selected, id: cliId, name: 'CLI on this server' }
    const isCli = provider === 'codex-cli' || provider === 'claude-code'
    const config = isCli
      ? routed({ connections: [], routes: { schemaSuggestion: { connectionId: cliId, modelId: 'manual/model' }, interaction: null } })
      : routed({ connections: [selected] })
    const target = await resolveCapabilityRoute('schema-suggestion', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => config,
      deployment: { connections: isCli ? [cli] : [], defaultRoute: null },
    })
    expect(target).toMatchObject({ profile: 'general', jsonOutput, temperatureSupported })
    expect(target).toMatchObject({ automaticOutputKey: expect.any(String) })
    if (target.profile === 'general') {
      expect(target.model).toMatchObject({ modelId: 'manual/model' })
    }
  })

  it('shares automatic learning within a route and isolates it across routes', async () => {
    const dependencies = { researcherAccountId: ACCOUNT, readConfig: async () => routed() }
    const suggestion = await resolveCapabilityRoute('schema-suggestion', {}, dependencies)
    const again = await resolveCapabilityRoute('schema-suggestion', {}, dependencies)
    const interaction = await resolveCapabilityRoute('schema-edit', {}, dependencies)
    if (suggestion.profile !== 'general') throw new Error('Expected general execution')
    expect(again).toMatchObject({ automaticOutputKey: suggestion.automaticOutputKey })
    expect(interaction).not.toMatchObject({ automaticOutputKey: suggestion.automaticOutputKey })
  })

  it('keeps native OpenAI Responses distinct from compatible Chat Completions', async () => {
    const construct = async (provider: 'openai' | 'openai-compatible') => {
      const selected = { ...connection, provider, hasKey: provider === 'openai' }
      return resolveCapabilityRoute('schema-suggestion', {}, {
        researcherAccountId: ACCOUNT,
        readConfig: async () => routed({ connections: [selected] }),
      })
    }
    const [native, compatible] = await Promise.all([construct('openai'), construct('openai-compatible')])
    expect(native.profile === 'general' ? native.model : {}).toMatchObject({ provider: 'openai.responses' })
    expect(compatible.profile === 'general' ? compatible.model : {}).toMatchObject({
      provider: 'free-openai-compatible.chat',
    })
  })

  const NUEXTRACT = 'numind/NuExtract3-FP8'
  const QWEN = 'Qwen/Qwen3.8-27B-FP8'
  const INTERACTION_ID = '22222222-2222-4222-8222-222222222222'
  const onVllm = { ...connection, provider: 'vllm' as const, baseUrl: 'http://nuextract_model:8000/v1' }
  const general = () => ({ specificationVersion: 'v4' }) as never

  it.each([
    ['vllm', NUEXTRACT, 'nuextract'],
    ['vllm', QWEN, 'general'],
    ['openai-compatible', NUEXTRACT, 'general'],
    ['openai-compatible', QWEN, 'general'],
  ] as const)(
    'Schema Suggestion uses the NuExtract protocol exactly for a NuExtract model on a vLLM connection (%s, %s)',
    async (provider, modelId, profile) => {
      const selected = { ...onVllm, provider }
      const target = await resolveCapabilityRoute('schema-suggestion', {}, {
        researcherAccountId: ACCOUNT,
        readConfig: async () => routed({
          connections: [selected],
          routes: { schemaSuggestion: { connectionId: ID, modelId }, interaction: null },
        }),
        deployment: { connections: [], defaultRoute: null },
        modelFactories: { vllm: general, 'openai-compatible': general },
      })
      expect(target.profile).toBe(profile)
      if (profile === 'nuextract') {
        expect(target).toEqual({
          profile: 'nuextract',
          modelId: NUEXTRACT,
          baseUrl: 'http://nuextract_model:8000/v1',
          key: expect.any(Function),
          temperatureSupported: true,
          attribution: { provider: 'vllm', modelId: NUEXTRACT },
        })
        // A keyless connection's NuExtract target is anonymous.
        await expect((target as NuExtractExecutionTarget).key(undefined)).resolves.toBeNull()
      }
    },
  )

  it.each(['schema-edit'] as const)('no other route ever uses the NuExtract protocol (%s)', async (operation) => {
    const target = await resolveCapabilityRoute(operation, {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({
        connections: [onVllm],
        routes: { schemaSuggestion: null, interaction: { connectionId: ID, modelId: NUEXTRACT } },
      }),
      deployment: { connections: [], defaultRoute: null },
      modelFactories: { vllm: general },
    })
    expect(target).toMatchObject({ profile: 'general', attribution: { provider: 'vllm', modelId: NUEXTRACT } })
  })

  it('an inherited NuExtract target runs the protocol', async () => {
    const target = await resolveCapabilityRoute('schema-suggestion', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({
        connections: [onVllm],
        routes: { schemaSuggestion: null, interaction: { connectionId: ID, modelId: NUEXTRACT } },
      }),
      deployment: { connections: [], defaultRoute: null },
    })
    expect(target).toMatchObject({ profile: 'nuextract', modelId: NUEXTRACT, baseUrl: onVllm.baseUrl })
  })

  it('an unset Schema Suggestion route follows the Interaction Route, then the deployment default', async () => {
    const createModel = vi.fn(general)
    const deployment = {
      connections: [{ id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment', provider: 'vllm' as const, baseUrl: 'http://extraction_model:8000/v1', hasKey: false }],
      defaultRoute: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: QWEN },
    }
    const dependencies = (routes: ModelConfig['routes']) => ({
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({ routes }),
      deployment,
      modelFactories: { vllm: createModel, 'openai-compatible': createModel },
    })

    await expect(resolveCapabilityRoute('schema-suggestion', {}, dependencies({
      schemaSuggestion: null, interaction: { connectionId: ID, modelId: 'assistant-model' },
    }))).resolves.toMatchObject({ attribution: { provider: 'openai-compatible', modelId: 'assistant-model' } })
    expect(createModel).toHaveBeenLastCalledWith(connection, 'assistant-model', null)

    await expect(resolveCapabilityRoute('schema-suggestion', {}, dependencies({
      schemaSuggestion: null, interaction: null,
    }))).resolves.toMatchObject({ attribution: { provider: 'vllm', modelId: QWEN } })
    expect(createModel).toHaveBeenLastCalledWith(deployment.connections[0], QWEN, null)
  })

  it('an explicit Schema Suggestion route is used even when the Interaction Route differs or equals it', async () => {
    const second = { ...connection, id: INTERACTION_ID, name: 'Second gateway' }
    const createModel = vi.fn(general)
    const resolve = (routes: ModelConfig['routes']) => resolveCapabilityRoute('schema-suggestion', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({ connections: [connection, second], routes }),
      deployment: { connections: [], defaultRoute: null },
      modelFactories: { 'openai-compatible': createModel },
    })
    const explicit = { connectionId: ID, modelId: 'suggestion-model' }

    await resolve({ schemaSuggestion: explicit, interaction: { connectionId: INTERACTION_ID, modelId: 'assistant-model' } })
    expect(createModel).toHaveBeenLastCalledWith(connection, 'suggestion-model', null)

    await resolve({ schemaSuggestion: explicit, interaction: { ...explicit } })
    expect(createModel).toHaveBeenLastCalledWith(connection, 'suggestion-model', null)
    expect(createModel).toHaveBeenCalledTimes(2)
  })

  it('runs an unset route on the deployment default, and fails closed without one', async () => {
    const createModel = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    const deployment = {
      connections: [{ id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment', provider: 'vllm' as const, baseUrl: 'http://extraction_model:8000/v1', hasKey: false }],
      defaultRoute: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: 'Qwen/Qwen3.8-27B-FP8' },
    }
    const unset = routed({ connections: [], routes: { schemaSuggestion: null, interaction: null } })
    await expect(resolveCapabilityRoute('schema-suggestion', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => unset, deployment, modelFactories: { vllm: createModel },
    })).resolves.toMatchObject({ profile: 'general', attribution: { provider: 'vllm', modelId: 'Qwen/Qwen3.8-27B-FP8' } })
    // The deployment's own server is called anonymously.
    expect(createModel).toHaveBeenCalledWith(deployment.connections[0], 'Qwen/Qwen3.8-27B-FP8', null)

    await expect(resolveCapabilityRoute('schema-suggestion', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => unset, deployment: { connections: [], defaultRoute: null },
    })).rejects.toMatchObject({ status: 409, code: 'invalid_model_config', message: 'No model is configured for the Schema Suggestion route.' })
  })

  it('a route may name an enabled CLI deployment connection', async () => {
    const createModel = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    const claudeCode = {
      id: DEPLOYMENT_CONNECTION_IDS.claudeCode, name: 'Claude Code on this server', provider: 'claude-code' as const, baseUrl: null, hasKey: false,
    }
    const keys = createModelKeyCache()
    const read = vi.spyOn(keys, 'read')

    const target = await resolveCapabilityRoute('schema-edit', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({ connections: [], routes: { schemaSuggestion: null, interaction: { connectionId: claudeCode.id, modelId: 'opus' } } }),
      deployment: { connections: [claudeCode], defaultRoute: null },
      keys,
      modelFactories: { 'claude-code': createModel },
    })

    expect(target).toMatchObject({ profile: 'general', attribution: { provider: 'claude-code', modelId: 'opus' } })
    // The server's own CLI login runs the call: no key is read, none is passed.
    expect(createModel).toHaveBeenCalledWith(claudeCode, 'opus', null)
    expect(read).not.toHaveBeenCalled()
  })

  it('refuses a saved route naming a deployment connection this deployment no longer serves', async () => {
    await expect(resolveCapabilityRoute('schema-edit', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({ routes: { schemaSuggestion: null, interaction: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: 'm' } } }),
      deployment: { connections: [], defaultRoute: null },
    })).rejects.toMatchObject({ status: 409, code: 'invalid_model_config' })
  })

  it('refuses a saved route naming a CLI deployment connection this deployment no longer enables', async () => {
    const createModel = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    // Only Claude Code is enabled now; the route still names the Codex CLI deployment connection.
    const claudeCode = {
      id: DEPLOYMENT_CONNECTION_IDS.claudeCode, name: 'Claude Code on this server', provider: 'claude-code' as const, baseUrl: null, hasKey: false,
    }
    await expect(resolveCapabilityRoute('schema-edit', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({
        connections: [], routes: { schemaSuggestion: null, interaction: { connectionId: DEPLOYMENT_CONNECTION_IDS.codexCli, modelId: 'gpt-5' } },
      }),
      deployment: { connections: [claudeCode], defaultRoute: null },
      modelFactories: { 'codex-cli': createModel, 'claude-code': createModel },
    })).rejects.toMatchObject({
      status: 409, code: 'invalid_model_config', message: 'The Assistant model route names a Model Connection that does not exist.',
    })
    expect(createModel).not.toHaveBeenCalled()
  })

  it('sends vLLM requests with thinking off unless a call chooses otherwise', async () => {
    const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
    vi.stubGlobal('fetch', request)
    const model = providerTable.vllm.createModel(
      { ...connection, provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1' }, 'Qwen/Qwen3.8-27B-FP8', null,
    )
    await generateText({ model, prompt: 'Hi', maxRetries: 0 })
    const body = JSON.parse(String(request.mock.calls[0]![1]!.body))
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(withThinkingOff({ chat_template_kwargs: { enable_thinking: true, mode: 'x' } }))
      .toEqual({ chat_template_kwargs: { enable_thinking: true, mode: 'x' } })
  })

  it.each([
    ['schema-suggestion', 'extract-model', 'schemaSuggestion'],
    ['schema-edit', 'interaction-model', 'interaction'],
  ] as const)('maps %s exactly once to the %s route', async (operation, modelId, selectedRoute) => {
    const interactionId = '00000000-0000-4000-8000-000000000002'
    const extractionFactory = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    const interactionFactory = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    await resolveCapabilityRoute(operation, {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => ({
        connections: [
          { ...connection, provider: 'ollama', baseUrl: 'http://ollama.example' },
          { ...connection, id: interactionId, provider: 'vllm', baseUrl: 'http://vllm.example:8000/v1' },
        ],
        routes: {
          schemaSuggestion: { connectionId: ID, modelId: 'extract-model' },
          interaction: { connectionId: interactionId, modelId: 'interaction-model' },
        },
        extractionModels: {},
        ingestionModels: {},
      }),
      modelFactories: { ollama: extractionFactory, vllm: interactionFactory },
    })
    const selected = selectedRoute === 'schemaSuggestion' ? extractionFactory : interactionFactory
    const unselected = selectedRoute === 'schemaSuggestion' ? interactionFactory : extractionFactory
    expect(selected).toHaveBeenCalledOnce()
    expect(selected).toHaveBeenCalledWith(expect.anything(), modelId, null)
    expect(unselected).not.toHaveBeenCalled()
  })

  it('rejects unsupported temperature before constructing a CLI model', async () => {
    const createModel = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    const cli = {
      id: DEPLOYMENT_CONNECTION_IDS.codexCli, name: 'Codex CLI on this server', provider: 'codex-cli' as const, baseUrl: null, hasKey: false,
    }
    await expect(
      resolveCapabilityRoute('schema-suggestion', { temperature: 0.3 }, {
        researcherAccountId: ACCOUNT,
        readConfig: async () => routed({
          connections: [], routes: { schemaSuggestion: { connectionId: cli.id, modelId: 'manual/model' }, interaction: null },
        }),
        deployment: { connections: [cli], defaultRoute: null },
        modelFactories: { 'codex-cli': createModel },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'unsupported_temperature' })
    expect(createModel).not.toHaveBeenCalled()
  })

  it("resolving a route that names another account's connection is 409", async () => {
    const createModel = vi.fn(() => ({ specificationVersion: 'v4' }) as never)
    // A's connection exists only in A's configuration; B's route names its ID.
    const other: ModelConfig = routed({
      connections: [{ ...connection, id: '22222222-2222-4222-8222-222222222222', name: 'B gateway' }],
    })
    await expect(resolveCapabilityRoute('schema-edit', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => other,
      deployment: { connections: [], defaultRoute: null },
      modelFactories: { 'openai-compatible': createModel },
    })).rejects.toMatchObject({
      status: 409,
      code: 'invalid_model_config',
      message: 'The Assistant model route names a Model Connection that does not exist.',
    })
    expect(createModel).not.toHaveBeenCalled()
  })

  it('a resolution error names the route that supplied the target, not the one that follows it', async () => {
    const missing = { connectionId: '22222222-2222-4222-8222-222222222222', modelId: 'gone' }
    const resolve = (routes: ModelConfig['routes']) => resolveCapabilityRoute('schema-suggestion', {}, {
      researcherAccountId: ACCOUNT,
      readConfig: async () => routed({ routes }),
      deployment: { connections: [], defaultRoute: null },
    })

    await expect(resolve({ schemaSuggestion: null, interaction: missing })).rejects.toMatchObject({
      status: 409,
      message: 'The Assistant model route names a Model Connection that does not exist.',
    })
    await expect(resolve({ schemaSuggestion: missing, interaction: null })).rejects.toMatchObject({
      status: 409,
      message: 'The Schema Suggestion route names a Model Connection that does not exist.',
    })
  })

  it('fails closed instead of consulting another route', async () => {
    await expect(
      resolveCapabilityRoute('schema-edit', {}, {
        researcherAccountId: ACCOUNT,
        readConfig: async () => routed({ routes: { schemaSuggestion: { connectionId: ID, modelId: 'model' }, interaction: null } }),
        deployment: { connections: [], defaultRoute: null },
      }),
    ).rejects.toMatchObject({ status: 409, code: 'invalid_model_config' })
  })
})
