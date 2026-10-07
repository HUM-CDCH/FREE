import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
  ResearcherProjectStore,
} from 'db'
import { generateText } from 'ai'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ModelConfig, ModelConnection } from '../shared/modelConfig.contract.js'
import {
  createApiDispatcher,
  createApiHandlerRegistry,
  type ApiDispatcher,
} from '../server/api-dispatcher.js'
import { createStudioApp, type StudioApp } from '../server/app.js'
import { createInMemoryEntraIdentityProvider } from '../test/support/inMemoryEntraIdentityProvider.js'
import { createSessionManager } from '../server/session.js'
import { readAccountModelConfig } from './_model_config.js'
import { ModelKeyRequiredError, createModelKeyCache, type ModelKeyCache } from './_model_keys.js'
import { resolveCapabilityRoute } from './_provider.js'
import { inMemoryModelConfigurations } from './model_configuration.fixture.js'
import { createResearcherApiHandlers as modelConfigHandlers } from './model_config.js'
import { createPutModelKeys } from './model_keys.js'
import { createResearcherApiHandlers as modelProbeHandlers } from './model_probe.js'

const ORIGIN = 'https://studio.example'
const SECRET = Buffer.alloc(32, 7)
const NOW = Date.UTC(2026, 7, 20, 12)
const ACCOUNT_ID = '30000000-0000-4000-8000-000000000001'
const OTHER_ACCOUNT_ID = '30000000-0000-4000-8000-000000000005'
const CONNECTION_ID = '30000000-0000-4000-8000-000000000002'
const OTHER_CONNECTION_ID = '30000000-0000-4000-8000-000000000006'
const NO_DEPLOYMENT = { connections: [], defaultRoute: null }

const researchConnection: ModelConnection = {
  id: CONNECTION_ID,
  name: 'Research OpenAI',
  provider: 'openai',
  baseUrl: 'https://gateway.example/openai/v1',
  hasKey: true,
}
const config: ModelConfig = {
  connections: [researchConnection],
  routes: {
    schemaSuggestion: { connectionId: CONNECTION_ID, modelId: 'gpt-research' },
    interaction: { connectionId: CONNECTION_ID, modelId: 'gpt-research' },
  },
  extractionModels: {},
  ingestionModels: {},
  extractionSettings: {},
}

const otherConfig: ModelConfig = {
  connections: [
    {
      id: OTHER_CONNECTION_ID,
      name: 'Other researcher OpenAI',
      provider: 'openai',
      baseUrl: 'https://other.example/openai/v1',
      hasKey: true,
    },
  ],
  routes: {
    schemaSuggestion: null,
    interaction: { connectionId: OTHER_CONNECTION_ID, modelId: 'gpt-other' },
  },
  extractionModels: { fields: 'instruct' },
  ingestionModels: {},
  extractionSettings: {},
}

const EMPTY_CONFIG: ModelConfig = {
  connections: [],
  routes: { schemaSuggestion: null, interaction: null },
  extractionModels: {},
  ingestionModels: {},
  extractionSettings: {},
}

type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type ModelAuthFixture = {
  app: StudioApp
  cookie: string
  otherCookie: string
  cookieFor: (researcherAccountId: string, issuedAt?: number) => string
  dispatcher: Mock<ApiDispatcher>
  readConfig: Mock<(researcherAccountId: string) => Promise<unknown>>
  /** Holds every configuration read until `release`, once `hold` is called. */
  gate: { hold(): void; reading: Promise<void>; release(): void }
  store: ReturnType<typeof inMemoryModelConfigurations>
  keys: ModelKeyCache
  providerFetch: Mock<ProviderFetch>
}

async function modelAuthFixture(): Promise<ModelAuthFixture> {
  const account = (id: string, objectId: string): ResearcherAccountRecord => ({
    id,
    tenantId: '30000000-0000-4000-8000-000000000003',
    objectId,
    displayName: 'Researcher',
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  })
  const accounts = [
    account(ACCOUNT_ID, '30000000-0000-4000-8000-000000000004'),
    account(OTHER_ACCOUNT_ID, '30000000-0000-4000-8000-000000000007'),
  ]
  const accountStore: ResearcherAccountStore = {
    findOrCreate: vi.fn(async () => accounts[0]),
    findById: vi.fn(async (id) => accounts.find((candidate) => candidate.id === id) ?? null),
  }

  // One configuration store and one key cache shared by both accounts, as in the deployment.
  const store = inMemoryModelConfigurations()
  let held: PromiseWithResolvers<void> | null = null
  const reading = Promise.withResolvers<void>()
  const readConfig = vi.fn(async (researcherAccountId: string) => {
    reading.resolve()
    await held?.promise
    return store.read(researcherAccountId)
  })
  const configurations = { ...store, read: readConfig }
  const keys = createModelKeyCache()
  const providerFetch = vi.fn<ProviderFetch>(
    async () => Response.json({ data: [{ id: 'gpt-research' }] }),
  )
  const deployment = () => NO_DEPLOYMENT
  const registry = createApiHandlerRegistry({
    '../api/model_config.ts': {
      createResearcherApiHandlers: (projects: ResearcherProjectStore) =>
        modelConfigHandlers(projects, { configurations, deployment, keys }),
    },
    '../api/model_probe.ts': {
      createResearcherApiHandlers: (projects: ResearcherProjectStore) =>
        modelProbeHandlers(projects, { deployment, fetch: providerFetch }),
    },
    '../api/model_keys.ts': {
      createResearcherApiHandlers: (projects: ResearcherProjectStore) =>
        ({ PUT: createPutModelKeys(projects.researcherAccountId, { configurations, keys }) }),
    },
  })
  const dispatcher = vi.fn(createApiDispatcher(registry))
  const app = await createStudioApp({
    studioOrigin: ORIGIN,
    basePath: '/',
    sessionSecret: SECRET,
    now: () => NOW,
    accountStore,
    identityProvider: createInMemoryEntraIdentityProvider({ now: () => NOW }),
    apiDispatcher: dispatcher,
    modelKeys: { bootId: 'boot-test', keys },
    researcherProjectStore: (researcherAccountId) =>
      ({ researcherAccountId }) as ResearcherProjectStore,
  })
  const cookieFor = (researcherAccountId: string, issuedAt = NOW) => {
    const sessions = createSessionManager(SECRET, () => issuedAt)
    const payload = sessions.issue(researcherAccountId, NOW + 75 * 60 * 1_000)
    if (!payload) throw new Error('Test session could not be issued.')
    return sessions.serialize(payload).split(';', 1)[0]
  }

  return {
    app,
    cookie: cookieFor(ACCOUNT_ID),
    otherCookie: cookieFor(OTHER_ACCOUNT_ID),
    cookieFor,
    dispatcher,
    readConfig,
    gate: {
      hold: () => { held = Promise.withResolvers<void>() },
      reading: reading.promise,
      release: () => held?.resolve(),
    },
    store,
    keys,
    providerFetch,
  }
}

async function modelRequest(
  test: ModelAuthFixture,
  path: '/api/model_config' | '/api/model_probe' | '/api/model-keys',
  method: 'GET' | 'PUT' | 'POST',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  if (method !== 'GET') {
    headers.set('content-type', 'application/json')
    headers.set('origin', ORIGIN)
  }
  return test.app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { clientAddress: '192.0.2.30' },
  )
}

const keyEntry = (connection: ModelConnection, key: string) =>
  ({ provider: connection.provider, baseUrl: connection.baseUrl, key })

function expectNoModelSideEffects(test: ModelAuthFixture): void {
  expect(test.dispatcher).not.toHaveBeenCalled()
  expect(test.readConfig).not.toHaveBeenCalled()
  expect(test.providerFetch).not.toHaveBeenCalled()
  expect(test.keys.read(ACCOUNT_ID, researchConnection)).toBeNull()
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('model API authentication boundary', () => {
  it('denies unauthenticated GET, PUT, and probe before configuration or provider access', async () => {
    const test = await modelAuthFixture()
    const responses = await Promise.all([
      modelRequest(test, '/api/model_config', 'GET'),
      modelRequest(test, '/api/model_config', 'PUT', { config }),
      modelRequest(test, '/api/model_probe', 'POST', {
        connection: researchConnection,
        credential: 'sk-test-unauthenticated-probe',
      }),
    ])

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401])
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'authentication_required' },
      })
    }
    expectNoModelSideEffects(test)
  })

  it('unauthenticated model-keys PUT is 401 with no side effects', async () => {
    const test = await modelAuthFixture()
    const response = await modelRequest(test, '/api/model-keys', 'PUT', {
      account: ACCOUNT_ID,
      keys: { [CONNECTION_ID]: keyEntry(researchConnection, 'sk-test-unauthenticated') },
    })

    expect(response.status).toBe(401)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'authentication_required' } })
    expect(text).not.toContain('sk-test-unauthenticated')
    expectNoModelSideEffects(test)
  })

  it('allows a fully authenticated researcher to replace, read, and probe their own state without exposing keys', async () => {
    const test = await modelAuthFixture()
    const put = await modelRequest(test, '/api/model_config', 'PUT', { config }, test.cookie)

    expect(put.status).toBe(200)
    await expect(put.json()).resolves.toEqual({ config })
    expect(test.providerFetch).not.toHaveBeenCalled()

    const get = await modelRequest(test, '/api/model_config', 'GET', undefined, test.cookie)
    expect(get.status).toBe(200)
    const read = await get.json()
    expect(read).toMatchObject({ config, deployment: NO_DEPLOYMENT })
    expect(Object.keys(read).sort()).toEqual(['config', 'deployment', 'providers'])
    expect(read.providers.length).toBeGreaterThan(0)

    const probe = await modelRequest(
      test,
      '/api/model_probe',
      'POST',
      { connection: researchConnection, credential: 'sk-test-page-probe' },
      test.cookie,
    )
    const probeText = await probe.text()
    expect(probe.status).toBe(200)
    expect(JSON.parse(probeText)).toMatchObject({ status: 'connected', catalog: [{ id: 'gpt-research' }] })
    expect(probeText).not.toContain('sk-test-page-probe')
    expect(test.providerFetch).toHaveBeenCalledWith(
      'https://gateway.example/openai/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer sk-test-page-probe' }),
      }),
    )
  })

  it('each account reads only its own configuration', async () => {
    const test = await modelAuthFixture()
    const read = async (cookie: string) => {
      const response = await modelRequest(test, '/api/model_config', 'GET', undefined, cookie)
      expect(response.status).toBe(200)
      return (await response.json()) as { config: ModelConfig }
    }

    expect((await modelRequest(test, '/api/model_config', 'PUT', { config }, test.cookie)).status).toBe(200)
    expect(await read(test.otherCookie)).toMatchObject({ config: EMPTY_CONFIG })

    expect((await modelRequest(test, '/api/model_config', 'PUT', { config: otherConfig }, test.otherCookie)).status).toBe(200)
    expect(await read(test.otherCookie)).toMatchObject({ config: otherConfig })
    const first = await read(test.cookie)
    expect(first).toMatchObject({ config })
    expect(JSON.stringify(first)).not.toContain(OTHER_CONNECTION_ID)
    expect(new Set(test.readConfig.mock.calls.map(([id]) => id))).toEqual(new Set([ACCOUNT_ID, OTHER_ACCOUNT_ID]))
  })

  it("each account's key serves only its own calls", async () => {
    const test = await modelAuthFixture()
    // Both accounts name one connection UUID at one address: IDs are unique per account, not across accounts.
    const lab: ModelConnection = { id: CONNECTION_ID, name: 'Lab vLLM', provider: 'vllm', baseUrl: 'http://lab.example:8000/v1', hasKey: true }
    const labConfig: ModelConfig = { ...EMPTY_CONFIG, connections: [lab], routes: { schemaSuggestion: null, interaction: { connectionId: lab.id, modelId: 'm' } } }
    for (const cookie of [test.cookie, test.otherCookie])
      expect((await modelRequest(test, '/api/model_config', 'PUT', { config: labConfig }, cookie)).status).toBe(200)
    const request = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      id: 'x', object: 'chat.completion', created: 0, model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }))
    vi.stubGlobal('fetch', request)
    const call = async (researcherAccountId: string) => {
      const target = await resolveCapabilityRoute('schema-edit', {}, {
        researcherAccountId,
        readConfig: () => readAccountModelConfig(researcherAccountId, test.store),
        deployment: NO_DEPLOYMENT,
        keys: test.keys,
        keyWaitMs: 10,
      })
      if (target.profile !== 'general') throw new Error('Expected general execution')
      request.mockClear()
      const failure = await generateText({ model: target.model, prompt: 'Hi', maxRetries: 0 }).then(() => null, (error: unknown) => error)
      return { failure, authorization: request.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization')) }
    }
    const handoff = async (cookie: string, account: string, entry: ReturnType<typeof keyEntry> | null) =>
      (await modelRequest(test, '/api/model-keys', 'PUT', { account, keys: { [lab.id]: entry } }, cookie)).json()

    await expect(handoff(test.cookie, ACCOUNT_ID, keyEntry(lab, 'sk-test-account-a'))).resolves.toEqual({ accepted: [lab.id] })
    const withoutKey = await call(OTHER_ACCOUNT_ID)
    expect(withoutKey.failure).toBeInstanceOf(ModelKeyRequiredError)
    expect(withoutKey.authorization).toEqual([])

    // B's removal of "its" key for that ID leaves A's key in place.
    await expect(handoff(test.otherCookie, OTHER_ACCOUNT_ID, null)).resolves.toEqual({ accepted: [lab.id] })
    expect(await call(ACCOUNT_ID)).toEqual({ failure: null, authorization: ['Bearer sk-test-account-a'] })

    await expect(handoff(test.otherCookie, OTHER_ACCOUNT_ID, keyEntry(lab, 'sk-test-account-b'))).resolves.toEqual({ accepted: [lab.id] })
    expect(await call(OTHER_ACCOUNT_ID)).toEqual({ failure: null, authorization: ['Bearer sk-test-account-b'] })
    expect(await call(ACCOUNT_ID)).toEqual({ failure: null, authorization: ['Bearer sk-test-account-a'] })
  })

  it('a handoff in flight when its session signs out stores nothing; that session hands off no more; another session of the account still can', async () => {
    const test = await modelAuthFixture()
    expect((await modelRequest(test, '/api/model_config', 'PUT', { config }, test.cookie)).status).toBe(200)
    const body = { account: ACCOUNT_ID, keys: { [CONNECTION_ID]: keyEntry(researchConnection, 'sk-test-signing-out') } }

    test.gate.hold()
    const inFlight = modelRequest(test, '/api/model-keys', 'PUT', body, test.cookie)
    await test.gate.reading
    const logout = await test.app.request(`${ORIGIN}/auth/logout`, {
      method: 'POST',
      headers: { origin: ORIGIN, cookie: test.cookie },
    })
    expect(logout.status).toBe(302)
    test.gate.release()

    const response = await inFlight
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ accepted: [] })
    expect(test.keys.read(ACCOUNT_ID, researchConnection)).toBeNull()

    // A handoff the signed-out page sent before signing out, arriving after it.
    const late = await modelRequest(test, '/api/model-keys', 'PUT', body, test.cookie)
    expect(late.status).toBe(401)
    expect(test.keys.read(ACCOUNT_ID, researchConnection)).toBeNull()

    // Another browser of the same account, signed in earlier, sends its own copy again.
    const other = test.cookieFor(ACCOUNT_ID, NOW - 60_000)
    const again = await modelRequest(test, '/api/model-keys', 'PUT', {
      account: ACCOUNT_ID, keys: { [CONNECTION_ID]: keyEntry(researchConnection, 'sk-test-other-browser') },
    }, other)
    await expect(again.json()).resolves.toEqual({ accepted: [CONNECTION_ID] })
    expect(test.keys.read(ACCOUNT_ID, researchConnection)).toBe('sk-test-other-browser')
  })
})
