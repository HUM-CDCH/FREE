import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './_http.js'
import {
  EMPTY_MODEL_CONFIG,
  modelConfigPath,
  nodeFileSystem,
  readModelConfig,
  validateModelConfig,
  writeModelConfig,
  type ModelConfig,
} from './_model_config.js'
import { PROVIDERS, appendProviderResource } from './_provider.js'
import { createGetModelConfig } from './model_config.js'

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
      { id: OLLAMA_ID, name: 'Local Ollama', provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/api' },
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

    const response = await createGetModelConfig({ configRoot: root })()

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

    const response = await createGetModelConfig({ configRoot: root })()

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
    const readCredentialState = vi.fn(async ({ id }: { id: string }) => {
      if (id === OPENAI_ID) throw new Error('keyring unavailable')
      return 'present' as const
    })

    const response = await createGetModelConfig({ configRoot: root, readCredentialState })()

    // codex-cli authenticates externally, so it never appears in the map.
    await expect(response.json()).resolves.toMatchObject({
      credentialStates: { [OLLAMA_ID]: 'present', [OPENAI_ID]: 'unavailable' },
    })
    expect(readCredentialState).toHaveBeenCalledTimes(2)
  })

  it('reports managed connections as unavailable until a keyring reader exists', async () => {
    const root = await temporaryRoot()
    await writeModelConfig(configured(), { configRoot: root })

    const response = await createGetModelConfig({ configRoot: root })()

    await expect(response.json()).resolves.toMatchObject({
      credentialStates: { [OLLAMA_ID]: 'unavailable', [OPENAI_ID]: 'unavailable' },
    })
  })

  it('maps a corrupt saved document to the stable bounded error envelope', async () => {
    const root = await temporaryRoot()
    await writeFile(modelConfigPath(root), '{')

    const response = await createGetModelConfig({ configRoot: root })()

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

    const response = await createGetModelConfig({ configRoot: root })()
    const body = (await response.json()) as {
      error: { details: { issues: unknown[]; truncated: boolean } }
    }

    expect(response.status).toBe(409)
    expect(body.error.details.issues).toHaveLength(20)
    expect(body.error.details.truncated).toBe(true)
  })
})
