import { describe, expect, it, vi } from 'vitest'
import type { ModelConfig, ModelConnection } from '../shared/modelConfig.contract.js'
import {
  PROVIDERS,
  appendProviderResource,
  probeConnection,
  providerTable,
  resolveCapabilityRoute,
} from './_provider.js'

const ID = '11111111-1111-4111-8111-111111111111'
const connection: ModelConnection = {
  id: ID,
  name: 'Gateway',
  provider: 'openai-compatible',
  baseUrl: 'https://host.example/proxy/openai/v1',
}
const presentCredentialStore = {
  state: async () => 'present' as const,
  get: async () => 'secret',
  set: async () => undefined,
  delete: async () => undefined,
}

function routed(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    connections: [connection],
    routes: {
      extraction: { connectionId: ID, modelId: 'manual/model' },
      interaction: { connectionId: ID, modelId: 'manual/model' },
    },
    ...overrides,
  }
}

describe('provider table', () => {
  it('exposes only all seven serializable descriptors in stable order', () => {
    expect(PROVIDERS.map(({ kind }) => kind)).toEqual([
      'ollama',
      'openai',
      'anthropic',
      'google',
      'codex-cli',
      'claude-code',
      'openai-compatible',
    ])
    expect(Object.keys(providerTable)).toEqual(PROVIDERS.map(({ kind }) => kind))
    for (const descriptor of PROVIDERS) {
      expect(Object.keys(descriptor).sort()).toEqual([
        'authentication',
        'defaultBaseUrl',
        'kind',
        'label',
        'supportsNuextractRaw',
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
    ['ollama', 'tags', { models: [{ name: 'llama-local' }] }, 'llama-local', 'authorization', 'Bearer secret'],
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
      upstream: { status: 401, body: 'denied', truncated: false },
    })
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
    expect(oversized.upstream).toMatchObject({ truncated: true })
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

describe('resolveCapabilityRoute', () => {
  it('passes an arbitrary saved model ID to the exact selected factory', async () => {
    const createModel = vi.fn(() => ({}) as never)
    const target = await resolveCapabilityRoute('chat', {}, {
      config: routed(),
      credentialStore: { state: async () => 'absent', get: async () => undefined, set: async () => {}, delete: async () => {} },
      modelFactories: { 'openai-compatible': createModel },
    })
    expect(target.profile).toBe('general')
    expect(createModel).toHaveBeenCalledWith(connection, 'manual/model', null)
  })

  it.each([
    ['ollama', 'http://127.0.0.1:11434/api', 'native', true],
    ['openai', 'https://api.openai.com/v1', 'native', true],
    ['anthropic', 'https://api.anthropic.com/v1', 'prompt', true],
    ['google', 'https://generativelanguage.googleapis.com/v1beta', 'native', true],
    ['codex-cli', null, 'prompt', false],
    ['claude-code', null, 'prompt', false],
    ['openai-compatible', 'https://gateway.example/v1', 'prompt', true],
  ] as const)('constructs the exact %s general target', async (provider, baseUrl, jsonOutput, temperatureSupported) => {
    const selected = { ...connection, provider, baseUrl }
    const target = await resolveCapabilityRoute('extraction', {}, {
      config: routed({ connections: [selected] }),
      credentialStore: presentCredentialStore,
    })
    expect(target).toMatchObject({ profile: 'general', jsonOutput, temperatureSupported })
    if (target.profile === 'general') {
      expect(target.model).toMatchObject({ modelId: 'manual/model' })
    }
  })

  it('keeps native OpenAI Responses distinct from compatible Chat Completions', async () => {
    const construct = async (provider: 'openai' | 'openai-compatible') => {
      const selected = { ...connection, provider }
      return resolveCapabilityRoute('extraction', {}, {
        config: routed({ connections: [selected] }),
        credentialStore: presentCredentialStore,
      })
    }
    const [native, compatible] = await Promise.all([construct('openai'), construct('openai-compatible')])
    expect(native.profile === 'general' ? native.model : {}).toMatchObject({ provider: 'openai.responses' })
    expect(compatible.profile === 'general' ? compatible.model : {}).toMatchObject({
      provider: 'free-openai-compatible.chat',
    })
  })

  it('resolves managed, optional, and external credential modes without fallback', async () => {
    const unavailableGet = vi.fn(async () => { throw new Error('keyring locked') })
    const unavailableStore = { ...presentCredentialStore, get: unavailableGet }
    const optionalFactory = vi.fn(() => ({}) as never)
    await resolveCapabilityRoute('extraction', {}, {
      config: routed(),
      credentialStore: unavailableStore,
      modelFactories: { 'openai-compatible': optionalFactory },
    })
    expect(optionalFactory).toHaveBeenCalledWith(connection, 'manual/model', null)

    const cli = { ...connection, provider: 'codex-cli' as const, baseUrl: null }
    const externalFactory = vi.fn(() => ({}) as never)
    await resolveCapabilityRoute('extraction', {}, {
      config: routed({ connections: [cli] }),
      credentialStore: unavailableStore,
      modelFactories: { 'codex-cli': externalFactory },
    })
    expect(externalFactory).toHaveBeenCalledWith(cli, 'manual/model', null)
    expect(unavailableGet).toHaveBeenCalledOnce()

    const managed = { ...connection, provider: 'openai' as const }
    await expect(resolveCapabilityRoute('extraction', {}, {
      config: routed({ connections: [managed] }),
      credentialStore: { ...presentCredentialStore, get: async () => undefined },
      modelFactories: { openai: vi.fn(() => ({}) as never) },
    })).rejects.toMatchObject({ status: 409, code: 'invalid_model_config' })
    await expect(resolveCapabilityRoute('extraction', {}, {
      config: routed({ connections: [managed] }),
      credentialStore: unavailableStore,
      modelFactories: { openai: vi.fn(() => ({}) as never) },
    })).rejects.toMatchObject({ status: 503, code: 'keyring_unavailable' })
  })

  it('derives raw NuExtract only from an explicitly flagged Ollama Extraction Route', async () => {
    const ollama = { ...connection, provider: 'ollama' as const, baseUrl: 'http://ollama.example/api' }
    const target = await resolveCapabilityRoute('extraction', {}, {
      config: routed({
        connections: [ollama],
        routes: {
          extraction: { connectionId: ID, modelId: 'manual-nuextract', nuextractRaw: true },
          interaction: { connectionId: ID, modelId: 'chat-model' },
        },
      }),
      credentialStore: presentCredentialStore,
    })
    expect(target).toEqual({
      profile: 'nuextract-raw',
      modelId: 'manual-nuextract',
      baseUrl: 'http://ollama.example/api',
      authorization: 'Bearer secret',
      temperatureSupported: true,
    })
  })

  it.each([
    ['extraction', 'extract-model', 'extraction'],
    ['schema-suggestion', 'extract-model', 'extraction'],
    ['chat', 'interaction-model', 'interaction'],
    ['schema-edit', 'interaction-model', 'interaction'],
  ] as const)('maps %s exactly once to the %s route', async (operation, modelId, selectedRoute) => {
    const interactionId = '00000000-0000-4000-8000-000000000002'
    const extractionFactory = vi.fn(() => ({}) as never)
    const interactionFactory = vi.fn(() => ({}) as never)
    await resolveCapabilityRoute(operation, {}, {
      config: {
        connections: [
          { ...connection, provider: 'ollama', baseUrl: 'http://ollama.example/api' },
          { ...connection, id: interactionId, provider: 'openai', baseUrl: 'https://api.openai.com/v1' },
        ],
        routes: {
          extraction: { connectionId: ID, modelId: 'extract-model' },
          interaction: { connectionId: interactionId, modelId: 'interaction-model' },
        },
      },
      credentialStore: presentCredentialStore,
      modelFactories: { ollama: extractionFactory, openai: interactionFactory },
    })
    const selected = selectedRoute === 'extraction' ? extractionFactory : interactionFactory
    const unselected = selectedRoute === 'extraction' ? interactionFactory : extractionFactory
    expect(selected).toHaveBeenCalledOnce()
    expect(selected).toHaveBeenCalledWith(expect.anything(), modelId, expect.anything())
    expect(unselected).not.toHaveBeenCalled()
  })

  it('rejects unsupported temperature before constructing a CLI model', async () => {
    const createModel = vi.fn(() => ({}) as never)
    const cli = { ...connection, provider: 'codex-cli' as const, baseUrl: null }
    await expect(
      resolveCapabilityRoute('extraction', { temperature: 0.3 }, {
        config: routed({ connections: [cli] }),
        modelFactories: { 'codex-cli': createModel },
      }),
    ).rejects.toMatchObject({ status: 400, code: 'unsupported_temperature' })
    expect(createModel).not.toHaveBeenCalled()
  })

  it('fails closed instead of consulting another route', async () => {
    await expect(
      resolveCapabilityRoute('chat', {}, {
        config: routed({ routes: { extraction: { connectionId: ID, modelId: 'model' }, interaction: null } }),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'invalid_model_config' })
  })
})
