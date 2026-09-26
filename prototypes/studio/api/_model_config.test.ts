import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEPLOYMENT_CONNECTION_IDS, type ModelConfig } from '../shared/modelConfig.contract.js'
import { ApiError } from './_http.js'
import { createModelKeyCache, type ModelKeyCache } from './_model_keys.js'
import {
  EMPTY_MODEL_CONFIG,
  configuredExtractionModels,
  configuredIngestionModels,
  readAccountModelConfig,
  validateModelConfig,
} from './_model_config.js'
import { PROVIDERS, appendProviderResource } from './_provider.js'
import { createResearcherApiHandlers, type ModelConfigDependencies } from './model_config.js'
import { inMemoryModelConfigurations } from './model_configuration.fixture.js'

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1'
const OTHER_ACCOUNT = '00000000-0000-4000-8000-0000000000a2'
const VLLM_ID = '00000000-0000-4000-8000-000000000001'
const OPENAI_ID = '00000000-0000-4000-8000-000000000002'
const OTHER_ID = '00000000-0000-4000-8000-000000000003'
const NO_DEPLOYMENT = { connections: [], defaultRoute: null }
/** The stored protocol flag Studio no longer has: the NuExtract protocol is derived, never submitted. */
const RETIRED_PROTOCOL = 'nuextract'

function configured(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    connections: [
      { id: VLLM_ID, name: 'Local vLLM', provider: 'vllm', baseUrl: 'http://127.0.0.1:8003/v1', hasKey: false },
      { id: OPENAI_ID, name: 'Research OpenAI', provider: 'openai', baseUrl: 'https://gateway.example/proxy/openai/v1', hasKey: true },
    ],
    routes: {
      schemaSuggestion: { connectionId: VLLM_ID, modelId: 'numind/NuExtract3-FP8' },
      interaction: { connectionId: OPENAI_ID, modelId: 'an opaque model id' },
    },
    extractionModels: { fields: 'nuextract' },
    ingestionModels: {},
    ...overrides,
  }
}

function expectInvalid(run: () => unknown, issuePath: string): void {
  expect(run).toThrow(ApiError)
  try {
    run()
  } catch (error) {
    expect(error).toMatchObject({ status: 409, code: 'invalid_model_config' })
    const { issues } = (error as ApiError).details as { issues: { path: string }[] }
    expect(issues.map(({ path }) => path)).toContain(issuePath)
  }
}

function putRequest(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://local.test/api/model_config', {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** The account's GET and PUT handlers, always over an isolated store and key cache, never the process ones. */
function handlers(dependencies: ModelConfigDependencies & Required<Pick<ModelConfigDependencies, 'configurations'>>) {
  return createResearcherApiHandlers({ researcherAccountId: ACCOUNT }, { keys: createModelKeyCache(), ...dependencies })
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('model configuration storage', () => {
  it('an account that never applied reads the empty configuration', async () => {
    const store = inMemoryModelConfigurations({ [OTHER_ACCOUNT]: configured() })

    const first = await readAccountModelConfig(ACCOUNT, store)
    expect(first).toEqual(EMPTY_MODEL_CONFIG)
    first.connections.push(configured().connections[0])

    await expect(readAccountModelConfig(ACCOUNT, store)).resolves.toEqual(EMPTY_MODEL_CONFIG)
    expect(store.documents.has(ACCOUNT)).toBe(false)
  })

  it('a stored document that fails validation is a 500 that echoes nothing', async () => {
    const hostile = {
      connections: [{ id: 'sk-test-stored-garbage', name: 'Connection', provider: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: true }],
      routes: { extraction: null, interaction: null },
    }
    const store = inMemoryModelConfigurations({ [ACCOUNT]: hostile })

    await expect(readAccountModelConfig(ACCOUNT, store)).rejects.toMatchObject({
      status: 500,
      code: 'invalid_model_config',
      details: undefined,
      cause: undefined,
    })
    const response = await handlers({ configurations: store }).GET()
    expect(response.status).toBe(500)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({
      error: { code: 'invalid_model_config', message: 'The saved model configuration is invalid.' },
    })
    expect(text).not.toContain('sk-test-stored-garbage')
    expect(store.documents.get(ACCOUNT)).toEqual(hostile)
  })

  it("configuredExtractionModels reads the given account's choice", async () => {
    const store = inMemoryModelConfigurations({
      [ACCOUNT]: configured({ extractionModels: { fields: 'nuextract', reasoning: 'instruct' } }),
      [OTHER_ACCOUNT]: configured({ extractionModels: {} }),
    })

    await expect(configuredExtractionModels(ACCOUNT, store)).resolves.toEqual({ fields: 'nuextract', reasoning: 'instruct' })
    await expect(configuredExtractionModels(OTHER_ACCOUNT, store)).resolves.toBeNull()
  })

  it("configuredIngestionModels answers the owner's saved roles and null for an unchosen one", async () => {
    const store = inMemoryModelConfigurations({
      [ACCOUNT]: configured({ ingestionModels: { ocr: 'surya', layout: 'layout_heron_101' } }),
      [OTHER_ACCOUNT]: configured({ ingestionModels: { layout: 'layout_egret_large' } }),
    })

    await expect(configuredIngestionModels(ACCOUNT, store)).resolves.toEqual({ ocr: 'surya', layout: 'layout_heron_101' })
    await expect(configuredIngestionModels(OTHER_ACCOUNT, store)).resolves.toEqual({ ocr: null, layout: 'layout_egret_large' })
    // Before an account's first Apply, both roles keep kei's defaults.
    await expect(configuredIngestionModels('00000000-0000-4000-8000-0000000000a9', store)).resolves.toEqual({ ocr: null, layout: null })
  })

  it('rejects duplicate IDs and dangling routes', () => {
    const duplicate = configured()
    duplicate.connections[1] = { ...duplicate.connections[1], id: VLLM_ID }
    expectInvalid(() => validateModelConfig(duplicate), 'connections.1.id')

    for (const route of ['schemaSuggestion', 'interaction'] as const) {
      const dangling = configured()
      dangling.routes[route] = { connectionId: OTHER_ID, modelId: 'missing' }
      expectInvalid(() => validateModelConfig(dangling), `routes.${route}.connectionId`)
    }
  })

  it('bounds extraction model keys as the extraction contract does', () => {
    const long = configured({ extractionModels: { fields: 'k'.repeat(129) } })
    expectInvalid(() => validateModelConfig(long), 'extractionModels.fields')
    for (const extractionModels of [{ fields: '' }, { planner: 'instruct' }])
      expect(() => validateModelConfig(configured({ extractionModels } as never))).toThrow(ApiError)
  })

  it('lets routes name a deployment connection but reserves its ID', () => {
    const routed = configured({
      routes: {
        schemaSuggestion: { connectionId: DEPLOYMENT_CONNECTION_IDS.nuextract, modelId: 'n' },
        interaction: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: 'q' },
      },
    })
    expect(validateModelConfig(routed)).toEqual(routed)

    const squatting = configured()
    squatting.connections[1] = { ...squatting.connections[1], id: DEPLOYMENT_CONNECTION_IDS.instruct }
    squatting.routes.interaction = null
    expectInvalid(() => validateModelConfig(squatting), 'connections.1.id')
  })

  it('a researcher connection may not reuse a CLI deployment ID', () => {
    for (const id of [DEPLOYMENT_CONNECTION_IDS.codexCli, DEPLOYMENT_CONNECTION_IDS.claudeCode]) {
      const squatting = configured()
      squatting.connections[0] = { ...squatting.connections[0], id }
      squatting.routes.schemaSuggestion = null
      expectInvalid(() => validateModelConfig(squatting), 'connections.0.id')
    }
  })

  it.each([
    ['relative', '/v1'],
    ['non-HTTP', 'ftp://host.example/v1'],
    ['embedded userinfo', 'https://researcher:secret@host.example/v1'],
    ['bare userinfo marker', 'https://@host.example/v1'],
    ['a query', 'https://host.example/v1?tenant=secret'],
    ['a fragment', 'https://host.example/v1#models'],
    ['a backslash', 'https://host.example\\v1'],
    ['surrounding whitespace', ' https://host.example/v1'],
    ['a control character', 'https://host.\texample/v1'],
  ])('rejects an API base with %s', (_label, baseUrl) => {
    const config = configured()
    config.connections[0] = { ...config.connections[0], baseUrl }
    expectInvalid(() => validateModelConfig(config), 'connections.0.baseUrl')
  })

  it('rejects unknown fields, non-canonical UUIDs, and empty model IDs', () => {
    // A strict object reports unrecognized keys against the object, not the key.
    expectInvalid(() => validateModelConfig({ ...configured(), version: 1 }), '')
    expectInvalid(
      () => validateModelConfig({ ...configured(), connections: [{ ...configured().connections[0], id: 'nope' }] }),
      'connections.0.id',
    )

    const empty = configured()
    empty.routes.interaction = { connectionId: OPENAI_ID, modelId: '' }
    expectInvalid(() => validateModelConfig(empty), 'routes.interaction.modelId')
  })
})

describe('key rules of a stored document', () => {
  it('a managed connection must have hasKey', () => {
    for (const provider of ['openai', 'anthropic', 'google'] as const) {
      const config = configured()
      config.connections[1] = { ...config.connections[1], provider, hasKey: false }
      expectInvalid(() => validateModelConfig(config), 'connections.1.hasKey')
    }
    // An optional-key provider may run with or without one.
    for (const hasKey of [true, false]) {
      const config = configured()
      config.connections[0] = { ...config.connections[0], hasKey }
      expect(validateModelConfig(config)).toEqual(config)
    }
  })
})

describe('GET /api/model_config', () => {
  it('reports the deployment\'s own model servers from the environment, never from the stored document', async () => {
    vi.stubEnv('FREE_DEPLOYMENT_INSTRUCT_URL', 'http://extraction_model:8000/v1')
    vi.stubEnv('FREE_DEPLOYMENT_INSTRUCT_MODEL', 'Qwen/Qwen3.8-27B-FP8')
    vi.stubEnv('FREE_DEPLOYMENT_NUEXTRACT_URL', 'http://nuextract_model:8000/v1')
    vi.stubEnv('FREE_DEPLOYMENT_CLI_PROVIDERS', '')
    const configurations = inMemoryModelConfigurations()

    const response = await handlers({ configurations }).GET()

    const body = await response.json()
    expect(body.config).toEqual(EMPTY_MODEL_CONFIG)
    expect(body.deployment).toEqual({
      connections: [
        { id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment instruction model', provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1', hasKey: false },
        { id: DEPLOYMENT_CONNECTION_IDS.nuextract, name: 'Deployment NuExtract', provider: 'vllm', baseUrl: 'http://nuextract_model:8000/v1', hasKey: false },
      ],
      defaultRoute: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: 'Qwen/Qwen3.8-27B-FP8' },
    })
  })

  it('returns the configuration, every descriptor and the deployment, and nothing about keys, without probing or reading AI_*', async () => {
    vi.stubEnv('AI_PROVIDER', 'claude-code')
    vi.stubEnv('AI_MODEL', 'must-not-be-read')
    vi.stubEnv('AI_BASE_URL', 'https://ignored.example')
    vi.stubEnv('AI_API_KEY', 'must-not-be-read')
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })
    const keys = createModelKeyCache()
    keys.put(ACCOUNT, OPENAI_ID, { provider: 'openai', baseUrl: configured().connections[1].baseUrl }, 'sk-test-cached-for-get')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const response = await handlers({ configurations, keys, deployment: () => NO_DEPLOYMENT }).GET()

    expect(response.status).toBe(200)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ config: configured(), providers: PROVIDERS, deployment: NO_DEPLOYMENT })
    expect(text).not.toContain('sk-test-cached-for-get')
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('PUT /api/model_config', () => {
  it.each(['auto', 'prompt', 'schema', 'native'])('rejects the retired %s output override', async (jsonOutput) => {
    const config = configured()
    const response = await handlers({ configurations: inMemoryModelConfigurations() }).PUT(putRequest({
      config: { ...config, routes: { ...config.routes, schemaSuggestion: { ...config.routes.schemaSuggestion, jsonOutput } } },
    }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })

  it.each([
    ['a wrong media type', { config: EMPTY_MODEL_CONFIG }, 'text/plain'],
    ['malformed JSON', '{ definitely not JSON', 'application/json'],
    ['an unknown top-level field', { config: EMPTY_MODEL_CONFIG, extra: 1 }, 'application/json'],
    ['a server-owned sibling inside config', { config: { ...EMPTY_MODEL_CONFIG, providers: [] } }, 'application/json'],
    ['the retired credential actions', { config: EMPTY_MODEL_CONFIG, credentials: { [OPENAI_ID]: 'sk-test-retired' } }, 'application/json'],
    ['a connection without hasKey', { config: { ...EMPTY_MODEL_CONFIG, connections: [{ ...configured().connections[0], hasKey: undefined }] } }, 'application/json'],
    ['a key inside a connection', { config: { ...EMPTY_MODEL_CONFIG, connections: [{ ...configured().connections[1], key: 'sk-test-inline' }] } }, 'application/json'],
  ])('rejects %s as a structural 400 before reaching storage', async (_label, body, contentType) => {
    const configurations = inMemoryModelConfigurations()
    const response = await handlers({ configurations }).PUT(putRequest(body, contentType))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(configurations.documents.size).toBe(0)
  })

  it('round-trips the editable document unchanged and returns only the configuration', async () => {
    const configurations = inMemoryModelConfigurations()
    const config = configured()
    // A base whose trailing slash must survive, and a model ID no probe could suggest.
    config.connections[1].baseUrl = 'https://gateway.example/proxy/openai/v1/'
    config.routes.interaction = { connectionId: OPENAI_ID, modelId: 'an opaque model id' }

    const response = await handlers({ configurations }).PUT(putRequest({ config }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ config })
    // The trailing slash is stored verbatim; it is insignificant at the join instead.
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(config)
    expect(appendProviderResource(config.connections[1].baseUrl!, 'models')).toBe(
      'https://gateway.example/proxy/openai/v1/models',
    )
  })

  it('an existing connection cannot change provider', async () => {
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })
    const changed = configured()
    changed.connections[1] = { ...changed.connections[1], provider: 'anthropic' }

    const response = await handlers({ configurations }).PUT(putRequest({ config: changed }))

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { details: { issues: { path: string }[] } } }
    expect(body.error.details.issues.map(({ path }) => path)).toContain('config.connections.1.provider')
    // The researcher must delete the connection and create a new UUID instead.
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(configured())
  })

  it('Apply rejects a researcher-defined CLI connection', async () => {
    for (const provider of ['codex-cli', 'claude-code'] as const) {
      const configurations = inMemoryModelConfigurations()
      const config = configured({
        connections: [{ id: OTHER_ID, name: 'My CLI', provider, baseUrl: null, hasKey: false }],
        routes: { schemaSuggestion: null, interaction: { connectionId: OTHER_ID, modelId: 'opus' } },
      })

      const response = await handlers({ configurations }).PUT(putRequest({ config }))

      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
      expect(body.error.code).toBe('invalid_model_config')
      expect(body.error.details.issues.map(({ path }) => path)).toEqual(['config.connections.0.provider'])
      expect(configurations.documents.size).toBe(0)
    }
  })

  it.each([
    [
      'a route left dangling by a removed connection',
      () => configured({ connections: [configured().connections[0]] }),
      'config.routes.interaction.connectionId',
    ],
    [
      'a managed connection without a key',
      () => configured({ connections: [configured().connections[0], { ...configured().connections[1], hasKey: false }] }),
      'config.connections.1.hasKey',
    ],
  ])('rejects %s as a semantic 409 with bounded details', async (_label, build, issuePath) => {
    const configurations = inMemoryModelConfigurations()
    const response = await handlers({ configurations }).PUT(putRequest({ config: build() }))

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
    expect(body.error.code).toBe('invalid_model_config')
    expect(body.error.details.issues.map(({ path }) => path)).toContain(issuePath)
    expect(configurations.documents.size).toBe(0)
  })

  it('Apply drops cached keys of removed and re-addressed connections', async () => {
    const C1 = OPENAI_ID
    const C2 = OTHER_ID
    const C3 = VLLM_ID
    const baseA = 'https://a.example/v1'
    const baseB = 'https://b.example/v1'
    const before = configured({
      connections: [
        { id: C1, name: 'C1', provider: 'openai', baseUrl: baseA, hasKey: true },
        { id: C2, name: 'C2', provider: 'openai', baseUrl: baseA, hasKey: true },
        { id: C3, name: 'C3', provider: 'vllm', baseUrl: baseA, hasKey: true },
      ],
      routes: { schemaSuggestion: null, interaction: null },
    })
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: before })
    const keys = createModelKeyCache()
    for (const { id, provider } of before.connections) keys.put(ACCOUNT, id, { provider, baseUrl: baseA }, `sk-test-${id}`)
    keys.put(OTHER_ACCOUNT, C2, { provider: 'openai', baseUrl: baseA }, 'sk-test-other-account')
    const after = { ...before, connections: [{ ...before.connections[0], baseUrl: baseB }, before.connections[2]] }

    const response = await handlers({ configurations, keys }).PUT(putRequest({ config: after }))

    expect(response.status).toBe(200)
    expect(keys.read(ACCOUNT, { id: C1, provider: 'openai', baseUrl: baseA })).toBeNull()
    expect(keys.read(ACCOUNT, { id: C1, provider: 'openai', baseUrl: baseB })).toBeNull()
    expect(keys.read(ACCOUNT, { id: C2, provider: 'openai', baseUrl: baseA })).toBeNull()
    expect(keys.read(ACCOUNT, { id: C3, provider: 'vllm', baseUrl: baseA })).toBe(`sk-test-${C3}`)
    expect(keys.read(OTHER_ACCOUNT, { id: C2, provider: 'openai', baseUrl: baseA })).toBe('sk-test-other-account')
  })

  it('a rejected Apply leaves every cached key in place', async () => {
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })
    const keys = createModelKeyCache()
    const address = { provider: 'openai' as const, baseUrl: configured().connections[1].baseUrl }
    keys.put(ACCOUNT, OPENAI_ID, address, 'sk-test-kept')
    const changed = configured()
    changed.connections[1] = { ...changed.connections[1], provider: 'anthropic' }

    expect((await handlers({ configurations, keys }).PUT(putRequest({ config: changed }))).status).toBe(409)
    expect(keys.read(ACCOUNT, { id: OPENAI_ID, ...address })).toBe('sk-test-kept')
  })

  it("two concurrent Applies of one account serialize, each sees the previous commit, and the cache follows the last commit", async () => {
    const store = inMemoryModelConfigurations()
    const events: string[] = []
    const configurations: typeof store = {
      ...store,
      apply: async (accountId, next) => {
        const committed = await store.apply(accountId, next)
        events.push(`commit:${(committed as ModelConfig).connections[0]?.baseUrl}`)
        return committed
      },
    }
    const cache = createModelKeyCache()
    const keys: Pick<ModelKeyCache, 'retain'> = {
      retain: (accountId, connections) => {
        events.push(`retain:${connections[0]?.baseUrl}`)
        cache.retain(accountId, connections)
      },
    }
    const baseA = 'https://a.example/v1'
    const baseB = 'https://b.example/v1'
    const single = (name: string, provider: 'openai' | 'anthropic', baseUrl: string) => configured({
      connections: [{ id: OPENAI_ID, name, provider, baseUrl, hasKey: true }],
      routes: { schemaSuggestion: null, interaction: null },
    })
    const first = single('first', 'openai', baseA)
    // Only an Apply that sees the first's commit knows this ID's provider is already fixed.
    const conflicting = single('conflicting', 'anthropic', baseB)
    const second = single('second', 'openai', baseB)
    cache.put(ACCOUNT, OPENAI_ID, { provider: 'openai', baseUrl: baseA }, 'sk-test-base-a')
    const { PUT } = handlers({ configurations, keys })

    const [one, two, three] = await Promise.all([
      PUT(putRequest({ config: first })),
      PUT(putRequest({ config: conflicting })),
      PUT(putRequest({ config: second })),
    ])

    expect([one.status, two.status, three.status]).toEqual([200, 409, 200])
    expect(events).toEqual([`commit:${baseA}`, `retain:${baseA}`, `commit:${baseB}`, `retain:${baseB}`])
    await expect(readAccountModelConfig(ACCOUNT, store)).resolves.toEqual(second)
    expect(cache.read(ACCOUNT, { id: OPENAI_ID, provider: 'openai', baseUrl: baseA })).toBeNull()
  })

  it('a submitted schemaSuggestion protocol is refused as an unknown field', async () => {
    const configurations = inMemoryModelConfigurations()
    const config = configured()
    const response = await handlers({ configurations }).PUT(putRequest({
      config: { ...config, routes: { ...config.routes, schemaSuggestion: { ...config.routes.schemaSuggestion, protocol: RETIRED_PROTOCOL } } },
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(configurations.documents.has(ACCOUNT)).toBe(false)
  })

  it('an explicit Schema Suggestion route equal to the Interaction Route is stored as submitted', async () => {
    const configurations = inMemoryModelConfigurations()
    const route = { connectionId: OPENAI_ID, modelId: 'an opaque model id' }
    const config = configured({ routes: { schemaSuggestion: { ...route }, interaction: route } })

    const response = await handlers({ configurations }).PUT(putRequest({ config }))

    expect(response.status).toBe(200)
    const stored = await readAccountModelConfig(ACCOUNT, configurations)
    expect(stored.routes.schemaSuggestion).toEqual(route)
    expect(stored).toEqual(config)
  })

  it('the Ingestion Model Choice is stored as submitted, and any key string is accepted', async () => {
    const configurations = inMemoryModelConfigurations()
    // kei refuses a key it does not serve at conversion; a saved choice the listing no longer offers stays saved.
    const config = configured({ ingestionModels: { ocr: 'retired-ocr-model', layout: 'layout_heron_101' } })

    const response = await handlers({ configurations }).PUT(putRequest({ config }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ config: { ingestionModels: config.ingestionModels } })
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toMatchObject({
      ingestionModels: { ocr: 'retired-ocr-model', layout: 'layout_heron_101' },
    })

    for (const ingestionModels of [{ table: 'x' }, { ocr: '' }, { layout: 'k'.repeat(129) }]) {
      const refused = await handlers({ configurations }).PUT(putRequest({ config: { ...config, ingestionModels } }))
      expect(refused.status).toBe(400)
    }
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(config)
  })
})
