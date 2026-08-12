import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelConfig } from '../shared/modelConfig.contract.js'
import { ApiError } from './_http.js'
import { createCredentialStore, type CredentialStore } from './_keyring.js'
import {
  EMPTY_MODEL_CONFIG,
  modelConfigPath,
  nodeFileSystem,
  readModelConfig,
  validateModelConfig,
  writeModelConfig,
} from './_model_config.js'
import { PROVIDERS, appendProviderResource } from './_provider.js'
import { createGetModelConfig, createPutModelConfig } from './model_config.js'

const OLLAMA_ID = '00000000-0000-4000-8000-000000000001'
const OPENAI_ID = '00000000-0000-4000-8000-000000000002'
const OTHER_ID = '00000000-0000-4000-8000-000000000003'
const AT = '/config/model-config.json'
const roots: string[] = []

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'free-model-config-test-'))
  roots.push(root)
  return root
}

function configured(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    connections: [
      { id: OLLAMA_ID, name: 'Local Ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
      { id: OPENAI_ID, name: 'Research OpenAI', provider: 'openai', baseUrl: 'https://gateway.example/proxy/openai/v1' },
    ],
    routes: {
      extraction: { connectionId: OLLAMA_ID, modelId: 'vendor/model:latest', nuextractRaw: true },
      interaction: { connectionId: OPENAI_ID, modelId: 'an opaque model id' },
    },
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

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('model configuration storage', () => {
  it('reads an absent file as a fresh empty configuration it does not create', async () => {
    const root = await temporaryRoot()

    const first = await readModelConfig({ configRoot: root })
    expect(first).toEqual(EMPTY_MODEL_CONFIG)
    first.connections.push(configured().connections[0])

    await expect(readModelConfig({ configRoot: root })).resolves.toEqual(EMPTY_MODEL_CONFIG)
    await expect(readFile(modelConfigPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('round-trips a saved document without transforming a supplied version prefix', async () => {
    const root = await temporaryRoot()
    const config = configured()
    config.connections[1].baseUrl = 'https://gateway.example/proxy/openai/v1/'

    await writeModelConfig(config, { configRoot: root })

    await expect(readModelConfig({ configRoot: root })).resolves.toEqual(config)
    expect((await stat(modelConfigPath(root))).mode & 0o777).toBe(0o600)
    expect(appendProviderResource(config.connections[1].baseUrl, 'models')).toBe(
      'https://gateway.example/proxy/openai/v1/models',
    )
  })

  it.each([
    ['malformed JSON', '{ definitely not JSON', 'Document must contain valid JSON.'],
    ['malformed UTF-8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), 'Document must contain valid UTF-8.'],
  ])('fails closed on %s and leaves the bytes untouched', async (_label, corrupt, message) => {
    const root = await temporaryRoot()
    const path = modelConfigPath(root)
    const bytes = Buffer.from(corrupt as string | Buffer)
    await writeFile(path, bytes)

    await expect(readModelConfig({ configRoot: root })).rejects.toMatchObject({
      status: 409,
      code: 'invalid_model_config',
      details: { path, issues: [{ path: '', message }], truncated: false },
    })
    await expect(readFile(path)).resolves.toEqual(bytes)
  })

  it('reports an unreadable file as a storage failure rather than invalid configuration', async () => {
    const fileSystem = {
      ...nodeFileSystem,
      readFile: () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    }

    await expect(readModelConfig({ configRoot: '/config', fileSystem })).rejects.toMatchObject({
      status: 500,
      code: 'storage_failure',
    })
  })

  it('rejects duplicate IDs, dangling routes, and non-Ollama raw extraction', () => {
    const duplicate = configured()
    duplicate.connections[1] = { ...duplicate.connections[1], id: OLLAMA_ID }
    expectInvalid(() => validateModelConfig(duplicate, AT), 'connections.1.id')

    for (const route of ['extraction', 'interaction'] as const) {
      const dangling = configured()
      dangling.routes[route] = { connectionId: OTHER_ID, modelId: 'missing' }
      expectInvalid(() => validateModelConfig(dangling, AT), `routes.${route}.connectionId`)
    }

    const wrongProvider = configured()
    wrongProvider.routes.extraction = { connectionId: OPENAI_ID, modelId: 'gpt', nuextractRaw: true }
    expectInvalid(() => validateModelConfig(wrongProvider, AT), 'routes.extraction.nuextractRaw')
  })

  it('enforces null CLI bases and at most one connection per CLI kind', () => {
    for (const provider of ['codex-cli', 'claude-code'] as const) {
      const twice = configured({
        connections: [
          { id: OLLAMA_ID, name: 'One', provider, baseUrl: null },
          { id: OPENAI_ID, name: 'Two', provider, baseUrl: null },
        ],
        routes: { extraction: null, interaction: null },
      })
      expectInvalid(() => validateModelConfig(twice, AT), 'connections.1.provider')

      const withBase = configured({
        connections: [{ id: OLLAMA_ID, name: 'CLI', provider, baseUrl: 'https://example.test' }],
        routes: { extraction: null, interaction: null },
      })
      expectInvalid(() => validateModelConfig(withBase, AT), 'connections.0.baseUrl')
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
    expectInvalid(() => validateModelConfig(config, AT), 'connections.0.baseUrl')
  })

  it('rejects unknown fields, non-canonical UUIDs, and empty model IDs', () => {
    // A strict object reports unrecognized keys against the object, not the key.
    expectInvalid(() => validateModelConfig({ ...configured(), version: 1 }, AT), '')
    expectInvalid(
      () => validateModelConfig({ ...configured(), connections: [{ ...configured().connections[0], id: 'nope' }] }, AT),
      'connections.0.id',
    )

    const empty = configured()
    empty.routes.interaction = { connectionId: OPENAI_ID, modelId: '' }
    expectInvalid(() => validateModelConfig(empty, AT), 'routes.interaction.modelId')
  })

  it('leaves the prior document in place when atomic replacement fails', async () => {
    const root = await temporaryRoot()
    const path = modelConfigPath(root)
    const original = '{"original":true}\n'
    await writeFile(path, original)
    let temporaryPath = ''
    const order: string[] = []

    const fileSystem = {
      ...nodeFileSystem,
      async open(target: string, flags: 'wx', mode: number) {
        expect([flags, mode]).toEqual(['wx', 0o600])
        temporaryPath = target
        const handle = await nodeFileSystem.open(target, flags, mode)
        return {
          writeFile: (...args: Parameters<typeof handle.writeFile>) => {
            order.push('write')
            return handle.writeFile(...args)
          },
          sync: () => (order.push('sync'), handle.sync()),
          close: () => (order.push('close'), handle.close()),
        }
      },
      rename: () => Promise.reject(new Error('injected replacement failure')),
    }

    await expect(writeModelConfig(configured(), { configRoot: root, fileSystem })).rejects.toMatchObject({
      status: 500,
      code: 'storage_failure',
    })
    expect(order).toEqual(['write', 'sync', 'close'])
    await expect(readFile(path, 'utf8')).resolves.toBe(original)
    await expect(readFile(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('GET /api/model_config', () => {
  it('returns the empty configuration and every descriptor without probing or reading AI_*', async () => {
    vi.stubEnv('AI_PROVIDER', 'claude-code')
    vi.stubEnv('AI_MODEL', 'must-not-be-read')
    vi.stubEnv('AI_BASE_URL', 'https://ignored.example')
    vi.stubEnv('AI_API_KEY', 'must-not-be-read')
    const root = await temporaryRoot()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const response = await createGetModelConfig({ configRoot: root, credentialStore: fakeCredentialStore().store })()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      config: EMPTY_MODEL_CONFIG,
      credentialStates: {},
      providers: PROVIDERS,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('does not reach a provider even when connections are saved', async () => {
    const root = await temporaryRoot()
    await writeModelConfig(configured(), { configRoot: root })
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const response = await createGetModelConfig({ configRoot: root, credentialStore: fakeCredentialStore().store })()

    expect(response.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })

  it('reports credential state per connection and degrades a failed read to unavailable', async () => {
    const root = await temporaryRoot()
    const config = configured({
      connections: [
        ...configured().connections,
        { id: OTHER_ID, name: 'Codex', provider: 'codex-cli', baseUrl: null },
      ],
    })
    await writeModelConfig(config, { configRoot: root })
    const partial = fakeCredentialStore({ [OLLAMA_ID]: 'stored' })
    const store: CredentialStore = {
      ...partial.store,
      state: (id) => (id === OPENAI_ID ? Promise.reject(new Error('locked')) : partial.store.state(id)),
    }

    const response = await createGetModelConfig({ configRoot: root, credentialStore: store })()

    // codex-cli authenticates externally, so it never appears in the map at all.
    await expect(response.json()).resolves.toMatchObject({
      credentialStates: { [OLLAMA_ID]: 'present', [OPENAI_ID]: 'unavailable' },
    })
  })

  it('keeps reading configuration when the whole keyring is unavailable', async () => {
    const root = await temporaryRoot()
    await writeModelConfig(configured(), { configRoot: root })

    const response = await createGetModelConfig({ configRoot: root, credentialStore: unavailableStore })()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      config: configured(),
      credentialStates: { [OLLAMA_ID]: 'unavailable', [OPENAI_ID]: 'unavailable' },
    })
  })

  it('maps a corrupt saved document to the stable bounded error envelope', async () => {
    const root = await temporaryRoot()
    await writeFile(modelConfigPath(root), '{')

    const response = await createGetModelConfig({ configRoot: root, credentialStore: fakeCredentialStore().store })()

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toEqual({
      error: {
        code: 'invalid_model_config',
        message: 'The saved model configuration is invalid.',
        details: {
          path: modelConfigPath(root),
          issues: [{ path: '', message: 'Document must contain valid JSON.' }],
          truncated: false,
        },
      },
    })
  })

  it('bounds validation issues from a hostile saved document', async () => {
    const root = await temporaryRoot()
    await writeFile(
      modelConfigPath(root),
      JSON.stringify({
        connections: Array.from({ length: 25 }, (_, index) => ({
          id: `not-a-uuid-${index}`,
          name: 'Connection',
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
        })),
        routes: { extraction: null, interaction: null },
      }),
    )

    const response = await createGetModelConfig({ configRoot: root, credentialStore: fakeCredentialStore().store })()
    const body = (await response.json()) as {
      error: { details: { issues: unknown[]; truncated: boolean } }
    }

    expect(response.status).toBe(409)
    expect(body.error.details.issues).toHaveLength(20)
    expect(body.error.details.truncated).toBe(true)
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
  it.each([
    ['a wrong media type', { config: EMPTY_MODEL_CONFIG }, 'text/plain'],
    ['malformed JSON', '{ definitely not JSON', 'application/json'],
    ['an unknown top-level field', { config: EMPTY_MODEL_CONFIG, extra: 1 }, 'application/json'],
    ['a server-owned sibling inside config', { config: { ...EMPTY_MODEL_CONFIG, credentialStates: {} } }, 'application/json'],
    ['an empty-string credential action', { config: EMPTY_MODEL_CONFIG, credentials: { [OPENAI_ID]: '' } }, 'application/json'],
    ['a credential key that is not a UUID', { config: EMPTY_MODEL_CONFIG, credentials: { 'not-a-uuid': 'x' } }, 'application/json'],
  ])('rejects %s as a structural 400 before reaching storage', async (_label, body, contentType) => {
    const fake = fakeCredentialStore()
    const put = createPutModelConfig({ configRoot: await temporaryRoot(), credentialStore: fake.store })

    const response = await put(putRequest(body, contentType))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(fake.calls).toEqual([])
  })

  it('round-trips the editable document unchanged and returns no descriptor or secret', async () => {
    const root = await temporaryRoot()
    const fake = fakeCredentialStore()
    const config = configured()
    // A base whose trailing slash must survive, and a model ID no probe could suggest.
    config.connections[1].baseUrl = 'https://gateway.example/proxy/openai/v1/'
    config.routes.interaction = { connectionId: OPENAI_ID, modelId: 'an opaque model id' }
    const put = createPutModelConfig({ configRoot: root, credentialStore: fake.store })

    const response = await put(putRequest({ config, credentials: { [OPENAI_ID]: 'sk-secret' } }))

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({
      config,
      credentialStates: { [OLLAMA_ID]: 'absent', [OPENAI_ID]: 'present' },
    })
    expect(body).not.toHaveProperty('providers')
    expect(JSON.stringify(body)).not.toContain('sk-secret')

    // The trailing slash is stored verbatim; it is insignificant at the join instead.
    const saved = await readFile(modelConfigPath(root), 'utf8')
    expect(saved).not.toContain('sk-secret')
    await expect(readModelConfig({ configRoot: root })).resolves.toEqual(config)
    expect(appendProviderResource(config.connections[1].baseUrl!, 'models')).toBe(
      'https://gateway.example/proxy/openai/v1/models',
    )
  })

  it('preserves, replaces, and deletes a credential from the action tri-state alone', async () => {
    const root = await temporaryRoot()
    const fake = fakeCredentialStore()
    // Ollama authenticates optionally, so it stays valid with no credential at all.
    const config = configured({
      connections: [configured().connections[0]],
      routes: { extraction: { connectionId: OLLAMA_ID, modelId: 'vendor/model:latest' }, interaction: null },
    })
    const put = createPutModelConfig({ configRoot: root, credentialStore: fake.store })

    await put(putRequest({ config, credentials: { [OLLAMA_ID]: 'first' } }))
    expect(fake.values.get(OLLAMA_ID)).toBe('first')

    await put(putRequest({ config, credentials: { [OLLAMA_ID]: 'second' } }))
    expect(fake.values.get(OLLAMA_ID)).toBe('second')

    const preserved = await put(putRequest({ config }))
    expect(fake.values.get(OLLAMA_ID)).toBe('second')
    await expect(preserved.json()).resolves.toMatchObject({
      credentialStates: { [OLLAMA_ID]: 'present' },
    })

    const deleted = await put(putRequest({ config, credentials: { [OLLAMA_ID]: null } }))
    expect(fake.values.has(OLLAMA_ID)).toBe(false)
    await expect(deleted.json()).resolves.toMatchObject({
      credentialStates: { [OLLAMA_ID]: 'absent' },
    })
  })

  it('refuses to change the provider kind of an already-saved UUID', async () => {
    const root = await temporaryRoot()
    await writeModelConfig(configured(), { configRoot: root })
    const fake = fakeCredentialStore({ [OPENAI_ID]: 'sk-existing' })
    const changed = configured()
    changed.connections[1] = { ...changed.connections[1], provider: 'anthropic' }

    const response = await createPutModelConfig({ configRoot: root, credentialStore: fake.store })(
      putRequest({ config: changed }),
    )

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { details: { issues: { path: string }[] } } }
    expect(body.error.details.issues.map(({ path }) => path)).toContain('config.connections.1.provider')
    // The researcher must delete the connection and create a new UUID instead.
    await expect(readModelConfig({ configRoot: root })).resolves.toEqual(configured())
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
    const root = await temporaryRoot()
    const fake = fakeCredentialStore()
    const put = createPutModelConfig({ configRoot: root, credentialStore: fake.store })

    const response = await put(putRequest(build()))

    expect(response.status).toBe(409)
    const body = (await response.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
    expect(body.error.code).toBe('invalid_model_config')
    expect(body.error.details.issues.map(({ path }) => path)).toContain(issuePath)
    // Nothing was committed and no credential moved.
    await expect(readFile(modelConfigPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fake.values.size).toBe(0)
  })

  it('maps a required keyring operation failure to 503 without any fallback', async () => {
    const root = await temporaryRoot()
    const put = createPutModelConfig({ configRoot: root, credentialStore: unavailableStore })

    for (const body of [{ config: configured() }, { config: configured(), credentials: { [OPENAI_ID]: 'sk' } }]) {
      const response = await put(putRequest(body))

      expect(response.status).toBe(503)
      await expect(response.json()).resolves.toEqual({
        error: {
          code: 'keyring_unavailable',
          message: 'The operating system credential store is unavailable.',
        },
      })
    }
    // No plaintext, environment, or file fallback: nothing was written.
    await expect(readFile(modelConfigPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the applied credential when the atomic JSON replacement fails', async () => {
    const root = await temporaryRoot()
    const fake = fakeCredentialStore()
    const fileSystem = { ...nodeFileSystem, rename: () => Promise.reject(new Error('disk full')) }
    const put = createPutModelConfig({ configRoot: root, credentialStore: fake.store, fileSystem })

    const response = await put(putRequest({ config: configured(), credentials: { [OPENAI_ID]: 'sk-new' } }))

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'storage_failure' } })
    // Credentials precede the commit and are never rolled back: JSON stays authoritative
    // and the next successful Apply overwrites the pairing.
    expect(fake.values.get(OPENAI_ID)).toBe('sk-new')
    await expect(readFile(modelConfigPath(root))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('commits a removal even when best-effort orphan cleanup fails', async () => {
    const root = await temporaryRoot()
    await writeModelConfig(configured(), { configRoot: root })
    const fake = fakeCredentialStore({ [OPENAI_ID]: 'sk-orphan' })
    const store: CredentialStore = { ...fake.store, delete: () => Promise.reject(new Error('locked')) }
    const remaining = configured({
      connections: [configured().connections[0]],
      routes: { extraction: configured().routes.extraction, interaction: null },
    })

    const response = await createPutModelConfig({ configRoot: root, credentialStore: store })(
      putRequest({ config: remaining }),
    )

    expect(response.status).toBe(200)
    // The removed UUID is gone from the authoritative document, so the credential
    // it left behind is inert: no saved connection can reach it.
    await expect(readModelConfig({ configRoot: root })).resolves.toEqual(remaining)
    await expect(response.json()).resolves.toMatchObject({
      credentialStates: { [OLLAMA_ID]: 'absent' },
    })
    expect(fake.values.get(OPENAI_ID)).toBe('sk-orphan')
  })
})
