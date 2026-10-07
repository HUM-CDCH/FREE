import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEPLOYMENT_CONNECTION_IDS, type ModelConfig, type ModelConnection } from '../shared/modelConfig.contract.js'
import { createModelKeyCache, type ModelKeyCache } from './_model_keys.js'
import { inMemoryModelConfigurations } from './model_configuration.fixture.js'
import { createPutModelKeys } from './model_keys.js'

const ACCOUNT = '40000000-0000-4000-8000-0000000000a1'
const OTHER_ACCOUNT = '40000000-0000-4000-8000-0000000000a2'
const OWN = '40000000-0000-4000-8000-000000000001'
const WRONG_BASE = '40000000-0000-4000-8000-000000000002'
const WRONG_PROVIDER = '40000000-0000-4000-8000-000000000003'
const KEYLESS = '40000000-0000-4000-8000-000000000004'
const UNKNOWN = '40000000-0000-4000-8000-000000000005'
const BASE = 'https://gateway.example/v1'

function connection(id: string, overrides: Partial<ModelConnection> = {}): ModelConnection {
  return { id, name: `Connection ${id.slice(-1)}`, provider: 'openai-compatible', baseUrl: BASE, hasKey: true, ...overrides }
}

function configOf(connections: ModelConnection[]): ModelConfig {
  return { connections, routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {}, extractionSettings: {} }
}

const accountConfig = configOf([
  connection(OWN),
  connection(WRONG_BASE),
  connection(WRONG_PROVIDER),
  connection(KEYLESS, { provider: 'vllm', hasKey: false }),
])

const entry = (key: string, overrides: Partial<{ provider: string; baseUrl: string | null }> = {}) =>
  ({ provider: 'openai-compatible', baseUrl: BASE, key, ...overrides })

function putRequest(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://local.test/api/model-keys', {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function fixture(documents: Record<string, unknown> = { [ACCOUNT]: accountConfig }) {
  const configurations = inMemoryModelConfigurations(documents)
  const keys = createModelKeyCache()
  const put = (accountId = ACCOUNT, cache: ModelKeyCache = keys) =>
    createPutModelKeys(accountId, { configurations, keys: cache })
  return { configurations, keys, put }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PUT /api/model-keys', () => {
  it("caches a key only for the account's own hasKey connection at its current provider and base", async () => {
    const { keys, put } = fixture()

    const response = await put()(putRequest({
      account: ACCOUNT,
      keys: {
        [OWN]: entry('sk-test-own'),
        [WRONG_BASE]: entry('sk-test-wrong-base', { baseUrl: 'https://elsewhere.example/v1' }),
        [WRONG_PROVIDER]: entry('sk-test-wrong-provider', { provider: 'vllm' }),
        [KEYLESS]: entry('sk-test-keyless', { provider: 'vllm' }),
        [UNKNOWN]: entry('sk-test-unknown'),
        [DEPLOYMENT_CONNECTION_IDS.instruct]: entry('sk-test-deployment', { provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1' }),
      },
    }))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ accepted: [OWN] })
    expect(keys.read(ACCOUNT, connection(OWN))).toBe('sk-test-own')
    for (const [id, address] of [
      [WRONG_BASE, { baseUrl: 'https://elsewhere.example/v1' }],
      [WRONG_BASE, {}],
      [WRONG_PROVIDER, { provider: 'vllm' as const }],
      [WRONG_PROVIDER, {}],
      [KEYLESS, { provider: 'vllm' as const }],
      [UNKNOWN, {}],
    ] as const)
      expect(keys.read(ACCOUNT, connection(id, address))).toBeNull()
    expect(keys.read(ACCOUNT, {
      id: DEPLOYMENT_CONNECTION_IDS.instruct, provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1',
    })).toBeNull()
  })

  it('a null entry removes the cached key and is accepted', async () => {
    const { keys, put } = fixture()
    keys.put(ACCOUNT, OWN, { provider: 'openai-compatible', baseUrl: BASE }, 'sk-test-removed')

    const response = await put()(putRequest({ account: ACCOUNT, keys: { [OWN]: null } }))

    await expect(response.json()).resolves.toEqual({ accepted: [OWN] })
    expect(keys.read(ACCOUNT, connection(OWN))).toBeNull()
  })

  it("a stale tab's handoff under another signed-in account is rejected", async () => {
    const { keys, put } = fixture({ [ACCOUNT]: accountConfig, [OTHER_ACCOUNT]: accountConfig })

    const response = await put(OTHER_ACCOUNT)(putRequest({ account: ACCOUNT, keys: { [OWN]: entry('sk-test-stale-tab') } }))

    expect(response.status).toBe(409)
    const text = await response.text()
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'account_mismatch' } })
    expect(text).not.toContain('sk-test-stale-tab')
    expect(keys.read(ACCOUNT, connection(OWN))).toBeNull()
    expect(keys.read(OTHER_ACCOUNT, connection(OWN))).toBeNull()
  })

  it.each([
    ['invalid JSON', `{"account":"${ACCOUNT}","keys":{"${OWN}":"sk-test-planted-1"`, 'application/json'],
    ['a valid shape with an extra property', { account: ACCOUNT, keys: {}, 'sk-test-planted-2': 'sk-test-planted-2' }, 'application/json'],
    ['a key entry with a non-string baseUrl', { account: ACCOUNT, keys: { [OWN]: { provider: 'openai-compatible', baseUrl: 42, key: 'sk-test-planted-4' } } }, 'application/json'],
    ['a wrong media type', { account: ACCOUNT, keys: { [OWN]: entry('sk-test-planted-5') } }, 'text/plain'],
    ['a key with a line feed', { account: ACCOUNT, keys: { [OWN]: entry('sk-test-planted-6\nrest') } }, 'application/json'],
    ['a key with a carriage return', { account: ACCOUNT, keys: { [OWN]: entry('sk-test-planted-7\rrest') } }, 'application/json'],
    ['a key with a NUL', { account: ACCOUNT, keys: { [OWN]: entry('sk-test-planted-8\u0000rest') } }, 'application/json'],
    ['a key outside printable ASCII', { account: ACCOUNT, keys: { [OWN]: entry('sk-test-planted-9-cl\u00e9') } }, 'application/json'],
    ['a key with a trailing space', { account: ACCOUNT, keys: { [OWN]: entry('sk-test-planted-10 ') } }, 'application/json'],
  ])('a malformed body (%s) echoes nothing and logs nothing', async (_label, body, contentType) => {
    const { keys, put } = fixture()
    const logs = (['error', 'warn', 'log', 'info'] as const).map((level) => vi.spyOn(console, level))

    const response = await put()(putRequest(body, contentType))

    expect(response.status).toBe(400)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: { code: 'invalid_request', message: 'The request is invalid.' } })
    expect(text).not.toMatch(/sk-test-planted/)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
    expect(keys.read(ACCOUNT, connection(OWN))).toBeNull()
  })

  it('the response names connection IDs only', async () => {
    const { put } = fixture()

    const response = await put()(putRequest({ account: ACCOUNT, keys: { [OWN]: entry('sk-test-response'), [KEYLESS]: null } }))

    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ accepted: [OWN, KEYLESS] })
    expect(text).not.toContain('sk-test-response')
    expect(text).not.toContain(BASE)
  })

  it("account B naming account A's connection ID never overwrites, removes or reads A's key", async () => {
    // B even owns a connection with the same UUID: IDs are unique per account, not across accounts.
    const { keys, put } = fixture({ [ACCOUNT]: accountConfig, [OTHER_ACCOUNT]: configOf([connection(OWN, { baseUrl: 'https://b.example/v1' })]) })
    keys.put(ACCOUNT, OWN, { provider: 'openai-compatible', baseUrl: BASE }, 'sk-test-account-a')

    const overwrite = await put(OTHER_ACCOUNT)(putRequest({ account: OTHER_ACCOUNT, keys: { [OWN]: entry('sk-test-account-b') } }))
    await expect(overwrite.json()).resolves.toEqual({ accepted: [] })
    const own = await put(OTHER_ACCOUNT)(putRequest({
      account: OTHER_ACCOUNT, keys: { [OWN]: entry('sk-test-account-b', { baseUrl: 'https://b.example/v1' }) },
    }))
    await expect(own.json()).resolves.toEqual({ accepted: [OWN] })
    const removal = await put(OTHER_ACCOUNT)(putRequest({ account: OTHER_ACCOUNT, keys: { [OWN]: null } }))
    await expect(removal.json()).resolves.toEqual({ accepted: [OWN] })

    expect(keys.read(ACCOUNT, connection(OWN))).toBe('sk-test-account-a')
    expect(keys.read(OTHER_ACCOUNT, connection(OWN))).toBeNull()
    expect(keys.read(OTHER_ACCOUNT, connection(OWN, { baseUrl: 'https://b.example/v1' }))).toBeNull()
  })

  it('a handoff still in flight when its account signs out stores nothing', async () => {
    const { configurations, keys } = fixture()
    const release = Promise.withResolvers<void>()
    const reading = Promise.withResolvers<void>()
    const gated = {
      ...configurations,
      read: async (accountId: string) => {
        reading.resolve()
        await release.promise
        return configurations.read(accountId)
      },
    }
    const put = createPutModelKeys(ACCOUNT, { configurations: gated, keys })

    const pending = put(putRequest({ account: ACCOUNT, keys: { [OWN]: entry('sk-test-signed-out') } }))
    await reading.promise
    keys.forgetAccount(ACCOUNT)
    release.resolve()

    const response = await pending
    await expect(response.json()).resolves.toEqual({ accepted: [] })
    expect(keys.read(ACCOUNT, connection(OWN))).toBeNull()

    // A handoff that begins after the sign-out is a new one and is served.
    const later = await put(putRequest({ account: ACCOUNT, keys: { [OWN]: entry('sk-test-signed-in-again') } }))
    await expect(later.json()).resolves.toEqual({ accepted: [OWN] })
    expect(keys.read(ACCOUNT, connection(OWN))).toBe('sk-test-signed-in-again')
  })
})
