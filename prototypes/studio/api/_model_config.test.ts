import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEPLOYMENT_CONNECTION_IDS, type ModelConfig } from '../shared/modelConfig.contract.js'
import { ApiError } from './_http.js'
import { createCredentialStore, type CredentialStore } from './_keyring.js'
import {
  EMPTY_MODEL_CONFIG,
  configuredExtractionModels,
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
      { id: VLLM_ID, name: 'Local vLLM', provider: 'vllm', baseUrl: 'http://127.0.0.1:8003/v1' },
      { id: OPENAI_ID, name: 'Research OpenAI', provider: 'openai', baseUrl: 'https://gateway.example/proxy/openai/v1' },
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

/**
 * Isolated stand-in for the OS keyring. Every handler under test is constructed
 * with one of these, so no test can reach the researcher's real `FREE Studio`
 * entries — the machine-global resource this suite must never touch.
 */
function fakeCredentialStore(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial))
  const calls: string[] = []
  const store: CredentialStore = {
    async state(id) {
      calls.push(`state:${id}`)
      return values.has(id) ? 'present' : 'absent'
    },
    async set(id, credential) {
      calls.push(`set:${id}`)
      values.set(id, credential)
    },
    async delete(id) {
      calls.push(`delete:${id}`)
      values.delete(id)
    },
  }
  return { store, values, calls }
}

/** Stands in for a missing native binding or a locked keyring: every call rejects. */
const unavailableStore: CredentialStore = {
  state: () => Promise.reject(new Error('keyring unavailable')),
  set: () => Promise.reject(new Error('keyring unavailable')),
  delete: () => Promise.reject(new Error('keyring unavailable')),
}

function putRequest(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://local.test/api/model_config', {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** The account's GET and PUT handlers, always over an isolated store, never the process one. */
function handlers(dependencies: ModelConfigDependencies & Required<Pick<ModelConfigDependencies, 'configurations'>>) {
  return createResearcherApiHandlers({ researcherAccountId: ACCOUNT }, dependencies)
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
      connections: [{ id: 'sk-test-stored-garbage', name: 'Connection', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }],
      routes: { extraction: null, interaction: null },
    }
    const store = inMemoryModelConfigurations({ [ACCOUNT]: hostile })

    await expect(readAccountModelConfig(ACCOUNT, store)).rejects.toMatchObject({
      status: 500,
      code: 'invalid_model_config',
      details: undefined,
      cause: undefined,
    })
    const response = await handlers({ configurations: store, credentialStore: fakeCredentialStore().store }).GET()
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

  it('enforces null CLI bases and at most one connection per CLI kind', () => {
    for (const provider of ['codex-cli', 'claude-code'] as const) {
      const twice = configured({
        connections: [
          { id: VLLM_ID, name: 'One', provider, baseUrl: null },
          { id: OPENAI_ID, name: 'Two', provider, baseUrl: null },
        ],
        routes: { schemaSuggestion: null, interaction: null },
      })
      expectInvalid(() => validateModelConfig(twice), 'connections.1.provider')

      const withBase = configured({
        connections: [{ id: VLLM_ID, name: 'CLI', provider, baseUrl: 'https://example.test' }],
        routes: { schemaSuggestion: null, interaction: null },
      })
      expectInvalid(() => validateModelConfig(withBase), 'connections.0.baseUrl')
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

describe('GET /api/model_config', () => {
  it('reports the deployment\'s own model servers from the environment, never from the stored document', async () => {
    vi.stubEnv('FREE_DEPLOYMENT_INSTRUCT_URL', 'http://extraction_model:8000/v1')
    vi.stubEnv('FREE_DEPLOYMENT_INSTRUCT_MODEL', 'Qwen/Qwen3.8-27B-FP8')
    vi.stubEnv('FREE_DEPLOYMENT_NUEXTRACT_URL', 'http://nuextract_model:8000/v1')
    const configurations = inMemoryModelConfigurations()

    const response = await handlers({ configurations, credentialStore: fakeCredentialStore().store }).GET()

    const body = await response.json()
    expect(body.config).toEqual(EMPTY_MODEL_CONFIG)
    expect(body.credentialStates).toEqual({})
    expect(body.deployment).toEqual({
      connections: [
        { id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment instruction model', provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1' },
        { id: DEPLOYMENT_CONNECTION_IDS.nuextract, name: 'Deployment NuExtract', provider: 'vllm', baseUrl: 'http://nuextract_model:8000/v1' },
      ],
      defaultRoute: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: 'Qwen/Qwen3.8-27B-FP8' },
    })
  })


  it('returns the empty configuration and every descriptor without probing or reading AI_*', async () => {
    vi.stubEnv('AI_PROVIDER', 'claude-code')
    vi.stubEnv('AI_MODEL', 'must-not-be-read')
    vi.stubEnv('AI_BASE_URL', 'https://ignored.example')
    vi.stubEnv('AI_API_KEY', 'must-not-be-read')
    const configurations = inMemoryModelConfigurations()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const response = await handlers({
      configurations, credentialStore: fakeCredentialStore().store, deployment: () => NO_DEPLOYMENT,
    }).GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      config: EMPTY_MODEL_CONFIG,
      credentialStates: {},
      providers: PROVIDERS,
      deployment: NO_DEPLOYMENT,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('does not reach a provider even when connections are saved', async () => {
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const response = await handlers({ configurations, credentialStore: fakeCredentialStore().store }).GET()

    expect(response.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('reports credential state per connection and degrades a failed read to unavailable', async () => {
    const configurations = inMemoryModelConfigurations()
    const config = configured({
      connections: [
        ...configured().connections,
        { id: OTHER_ID, name: 'Codex', provider: 'codex-cli', baseUrl: null },
      ],
    })
    configurations.documents.set(ACCOUNT, config)
    const partial = fakeCredentialStore({ [VLLM_ID]: 'stored' })
    const store: CredentialStore = {
      ...partial.store,
      state: (id) => (id === OPENAI_ID ? Promise.reject(new Error('locked')) : partial.store.state(id)),
    }

    const response = await handlers({ configurations, credentialStore: store }).GET()

    // codex-cli authenticates externally, so it never appears in the map at all.
    await expect(response.json()).resolves.toMatchObject({
      credentialStates: { [VLLM_ID]: 'present', [OPENAI_ID]: 'unavailable' },
    })
  })

  it('keeps reading configuration when the whole keyring is unavailable', async () => {
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })

    const response = await handlers({ configurations, credentialStore: unavailableStore }).GET()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      config: configured(),
      credentialStates: { [VLLM_ID]: 'unavailable', [OPENAI_ID]: 'unavailable' },
    })
  })
})

describe('OS credential adapter', () => {
  it('addresses every operation by the fixed service and the UUID-derived account', async () => {
    const entry = {
      getPassword: vi.fn(async () => undefined),
      setPassword: vi.fn(async () => undefined),
      deleteCredential: vi.fn(async () => true),
    }
    const openEntry = vi.fn(async () => entry)
    const store = createCredentialStore(openEntry)

    await expect(store.state(OPENAI_ID)).resolves.toBe('absent')
    await store.set(OPENAI_ID, 'write-only-secret')
    await store.delete(OPENAI_ID)

    // Naming is asserted through the factory, so renaming or reordering the
    // service and account arguments cannot pass unnoticed.
    expect(openEntry.mock.calls).toEqual([
      ['FREE Studio', `model-connection/${OPENAI_ID}`],
      ['FREE Studio', `model-connection/${OPENAI_ID}`],
      ['FREE Studio', `model-connection/${OPENAI_ID}`],
    ])
    expect(entry.setPassword).toHaveBeenCalledWith('write-only-secret')
    expect(entry.deleteCredential).toHaveBeenCalledOnce()
  })

  it('reads a missing entry as absent when the keyring resolves null', async () => {
    const store = createCredentialStore(async () => ({
      getPassword: async () => null as unknown as undefined,
      setPassword: async () => undefined,
      deleteCredential: async () => true,
    }))

    await expect(store.state(OPENAI_ID)).resolves.toBe('absent')
  })
})

describe('PUT /api/model_config', () => {
  it.each(['auto', 'prompt', 'schema', 'native'])('rejects the retired %s output override', async (jsonOutput) => {
    const config = configured()
    const response = await handlers({ configurations: inMemoryModelConfigurations(), credentialStore: fakeCredentialStore().store }).PUT(putRequest({
      config: { ...config, routes: { ...config.routes, schemaSuggestion: { ...config.routes.schemaSuggestion, jsonOutput } } },
    }))
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })

  it.each([
    ['a wrong media type', { config: EMPTY_MODEL_CONFIG }, 'text/plain'],
    ['malformed JSON', '{ definitely not JSON', 'application/json'],
    ['an unknown top-level field', { config: EMPTY_MODEL_CONFIG, extra: 1 }, 'application/json'],
    ['a server-owned sibling inside config', { config: { ...EMPTY_MODEL_CONFIG, credentialStates: {} } }, 'application/json'],
    ['an empty-string credential action', { config: EMPTY_MODEL_CONFIG, credentials: { [OPENAI_ID]: '' } }, 'application/json'],
    ['a credential key that is not a UUID', { config: EMPTY_MODEL_CONFIG, credentials: { 'not-a-uuid': 'x' } }, 'application/json'],
  ])('rejects %s as a structural 400 before reaching storage', async (_label, body, contentType) => {
    const fake = fakeCredentialStore()
    const put = handlers({ configurations: inMemoryModelConfigurations(), credentialStore: fake.store }).PUT

    const response = await put(putRequest(body, contentType))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(fake.calls).toEqual([])
  })

  it('round-trips the editable document unchanged and returns no descriptor or secret', async () => {
    const configurations = inMemoryModelConfigurations()
    const fake = fakeCredentialStore()
    const config = configured()
    // A base whose trailing slash must survive, and a model ID no probe could suggest.
    config.connections[1].baseUrl = 'https://gateway.example/proxy/openai/v1/'
    config.routes.interaction = { connectionId: OPENAI_ID, modelId: 'an opaque model id' }
    const put = handlers({ configurations, credentialStore: fake.store }).PUT

    const response = await put(putRequest({ config, credentials: { [OPENAI_ID]: 'sk-secret' } }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      config,
      credentialStates: { [VLLM_ID]: 'absent', [OPENAI_ID]: 'present' },
    })
    expect(body).not.toHaveProperty('providers')
    expect(JSON.stringify(body)).not.toContain('sk-secret')

    // The trailing slash is stored verbatim; it is insignificant at the join instead.
    expect(JSON.stringify(configurations.documents.get(ACCOUNT))).not.toContain('sk-secret')
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(config)
    expect(appendProviderResource(config.connections[1].baseUrl!, 'models')).toBe(
      'https://gateway.example/proxy/openai/v1/models',
    )
  })

  it('preserves, replaces, and deletes a credential from the action tri-state alone', async () => {
    const configurations = inMemoryModelConfigurations()
    const fake = fakeCredentialStore()
    // vLLM authenticates optionally, so it stays valid with no credential at all.
    const config = configured({
      connections: [configured().connections[0]],
      routes: { schemaSuggestion: { connectionId: VLLM_ID, modelId: 'vendor/model:latest' }, interaction: null },
    })
    const put = handlers({ configurations, credentialStore: fake.store }).PUT

    await put(putRequest({ config, credentials: { [VLLM_ID]: 'first' } }))
    expect(fake.values.get(VLLM_ID)).toBe('first')

    await put(putRequest({ config, credentials: { [VLLM_ID]: 'second' } }))
    expect(fake.values.get(VLLM_ID)).toBe('second')

    const preserved = await put(putRequest({ config }))
    expect(fake.values.get(VLLM_ID)).toBe('second')
    await expect(preserved.json()).resolves.toMatchObject({
      credentialStates: { [VLLM_ID]: 'present' },
    })

    const deleted = await put(putRequest({ config, credentials: { [VLLM_ID]: null } }))
    expect(fake.values.has(VLLM_ID)).toBe(false)
    await expect(deleted.json()).resolves.toMatchObject({
      credentialStates: { [VLLM_ID]: 'absent' },
    })
  })

  it('refuses to change the provider kind of an already-saved UUID', async () => {
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })
    const fake = fakeCredentialStore({ [OPENAI_ID]: 'sk-existing' })
    const changed = configured()
    changed.connections[1] = { ...changed.connections[1], provider: 'anthropic' }

    const response = await handlers({ configurations, credentialStore: fake.store }).PUT(
      putRequest({ config: changed }),
    )

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { details: { issues: { path: string }[] } } }
    expect(body.error.details.issues.map(({ path }) => path)).toContain('config.connections.1.provider')
    // The researcher must delete the connection and create a new UUID instead.
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(configured())
  })

  it('requires a new credential before a managed endpoint can change', async () => {
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })
    const fake = fakeCredentialStore({ [OPENAI_ID]: 'sk-existing' })
    const changed = configured()
    changed.connections[1] = {
      ...changed.connections[1],
      baseUrl: 'https://other-gateway.example/openai/v1',
    }

    const response = await handlers({
      configurations,
      credentialStore: fake.store,
    }).PUT(putRequest({ config: changed }))

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        details: {
          issues: [{ path: `credentials.${OPENAI_ID}` }],
        },
      },
    })
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(
      configured(),
    )
    expect(fake.values.get(OPENAI_ID)).toBe('sk-existing')
  })

  it.each([
    [
      'a route left dangling by a removed connection',
      () => ({
        config: configured({ connections: [configured().connections[0]] }),
        credentials: {},
      }),
      'config.routes.interaction.connectionId',
    ],
    [
      'an action naming a connection that was not submitted',
      () => ({ config: configured(), credentials: { [OPENAI_ID]: 'sk', [OTHER_ID]: 'sk' } }),
      `credentials.${OTHER_ID}`,
    ],
    [
      'an action against externally authenticated CLI login',
      () => ({
        config: configured({
          connections: [...configured().connections, { id: OTHER_ID, name: 'Codex', provider: 'codex-cli' as const, baseUrl: null }],
        }),
        credentials: { [OPENAI_ID]: 'sk', [OTHER_ID]: 'sk' },
      }),
      `credentials.${OTHER_ID}`,
    ],
    [
      'a managed provider whose credential is explicitly deleted',
      () => ({ config: configured(), credentials: { [OPENAI_ID]: null } }),
      `credentials.${OPENAI_ID}`,
    ],
    [
      'a managed provider preserving a credential that was never stored',
      () => ({ config: configured() }),
      `credentials.${OPENAI_ID}`,
    ],
  ])('rejects %s as a semantic 409 with bounded details', async (_label, build, issuePath) => {
    const configurations = inMemoryModelConfigurations()
    const fake = fakeCredentialStore()
    const put = handlers({ configurations, credentialStore: fake.store }).PUT

    const response = await put(putRequest(build()))

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
    expect(body.error.code).toBe('invalid_model_config')
    expect(body.error.details.issues.map(({ path }) => path)).toContain(issuePath)
    // Nothing was committed and no credential moved.
    expect(configurations.documents.size).toBe(0)
    expect(fake.values.size).toBe(0)
  })

  it('maps a required keyring operation failure to 503 without any fallback', async () => {
    const configurations = inMemoryModelConfigurations()
    const put = handlers({ configurations, credentialStore: unavailableStore }).PUT

    const response = await put(
      putRequest({
        config: configured(),
        credentials: { [OPENAI_ID]: 'sk' },
      }),
    )
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'keyring_unavailable',
        message: 'The operating system credential store is unavailable.',
      },
    })
    // No plaintext, environment, or file fallback: nothing was written.
    expect(configurations.documents.size).toBe(0)
  })

  it('commits a removal even when best-effort orphan cleanup fails', async () => {
    const configurations = inMemoryModelConfigurations({ [ACCOUNT]: configured() })
    const fake = fakeCredentialStore({ [OPENAI_ID]: 'sk-orphan' })
    const store: CredentialStore = { ...fake.store, delete: () => Promise.reject(new Error('locked')) }
    const remaining = configured({
      connections: [configured().connections[0]],
      routes: { schemaSuggestion: configured().routes.schemaSuggestion, interaction: null },
    })

    const response = await handlers({ configurations, credentialStore: store }).PUT(
      putRequest({ config: remaining }),
    )

    expect(response.status).toBe(200)
    // The removed UUID is gone from the authoritative document, so the credential
    // it left behind is inert: no saved connection can reach it.
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(remaining)
    await expect(response.json()).resolves.toMatchObject({
      credentialStates: { [VLLM_ID]: 'absent' },
    })
    expect(fake.values.get(OPENAI_ID)).toBe('sk-orphan')

    const reintroduced = await handlers({
      configurations,
      credentialStore: store,
    }).PUT(putRequest({ config: configured() }))
    expect(reintroduced.status).toBe(409)
    await expect(reintroduced.json()).resolves.toMatchObject({
      error: {
        details: {
          issues: [{ path: `credentials.${OPENAI_ID}` }],
        },
      },
    })
    expect(fake.values.get(OPENAI_ID)).toBe('sk-orphan')
  })

  it('a submitted schemaSuggestion protocol is refused as an unknown field', async () => {
    const configurations = inMemoryModelConfigurations()
    const fake = fakeCredentialStore()
    const config = configured()
    const response = await handlers({ configurations, credentialStore: fake.store }).PUT(putRequest({
      config: { ...config, routes: { ...config.routes, schemaSuggestion: { ...config.routes.schemaSuggestion, protocol: RETIRED_PROTOCOL } } },
      credentials: { [OPENAI_ID]: 'sk-test-protocol' },
    }))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(configurations.documents.has(ACCOUNT)).toBe(false)
    expect(fake.calls).toEqual([])
  })

  it('an explicit Schema Suggestion route equal to the Interaction Route is stored as submitted', async () => {
    const configurations = inMemoryModelConfigurations()
    const route = { connectionId: OPENAI_ID, modelId: 'an opaque model id' }
    const config = configured({ routes: { schemaSuggestion: { ...route }, interaction: route } })

    const response = await handlers({ configurations, credentialStore: fakeCredentialStore().store }).PUT(
      putRequest({ config, credentials: { [OPENAI_ID]: 'sk-test-explicit-route' } }),
    )

    expect(response.status).toBe(200)
    const stored = await readAccountModelConfig(ACCOUNT, configurations)
    expect(stored.routes.schemaSuggestion).toEqual(route)
    expect(stored).toEqual(config)
  })

  it('the Ingestion Model Choice is stored as submitted, and any key string is accepted', async () => {
    const configurations = inMemoryModelConfigurations()
    // kei refuses a key it does not serve at conversion; a saved choice the listing no longer offers stays saved.
    const config = configured({ ingestionModels: { ocr: 'retired-ocr-model', layout: 'layout_heron_101' } })

    const response = await handlers({ configurations, credentialStore: fakeCredentialStore().store }).PUT(
      putRequest({ config, credentials: { [OPENAI_ID]: 'sk-test-ingestion-choice' } }),
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ config: { ingestionModels: config.ingestionModels } })
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toMatchObject({
      ingestionModels: { ocr: 'retired-ocr-model', layout: 'layout_heron_101' },
    })

    for (const ingestionModels of [{ table: 'x' }, { ocr: '' }, { layout: 'k'.repeat(129) }]) {
      const refused = await handlers({ configurations, credentialStore: fakeCredentialStore().store }).PUT(
        putRequest({ config: { ...config, ingestionModels } }),
      )
      expect(refused.status).toBe(400)
    }
    await expect(readAccountModelConfig(ACCOUNT, configurations)).resolves.toEqual(config)
  })
})
