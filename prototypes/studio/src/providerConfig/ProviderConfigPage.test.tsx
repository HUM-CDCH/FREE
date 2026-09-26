// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEPLOYMENT_CONNECTION_IDS,
  type DeploymentModels,
  type ModelConfig,
  type ProviderDescriptor,
} from '../../shared/modelConfig.contract'
import { ResearcherSessionContext } from '../auth/sessionContext'
import ProviderConfigPage from './ProviderConfigPage'

const OLLAMA_ID = '11111111-1111-4111-8111-111111111111'
const OPENAI_ID = '22222222-2222-4222-8222-222222222222'
const ACCOUNT = 'acct-a'
const STORAGE = `free.modelKeys.v1:${ACCOUNT}`
const SESSION = {
  session: {
    authenticated: true as const,
    account: { id: ACCOUNT, displayName: 'Researcher A' },
    expiresAt: '2026-09-26T18:00:00.000Z',
  },
}
const OPENAI_BASE = 'https://api.openai.com/v1'
const OLLAMA_BASE = 'http://127.0.0.1:11434'
const INTERACTION_CONNECTION = 'Chat & Extraction Schema editing connection'
const INTERACTION_MODEL = 'Chat & Extraction Schema editing model ID'

const providers: ProviderDescriptor[] = [
  {
    kind: 'ollama',
    label: 'Ollama',
    transport: 'http',
    defaultBaseUrl: OLLAMA_BASE,
    authentication: 'optional',
    supportsNuextract: false,
  },
  {
    kind: 'openai',
    label: 'OpenAI',
    transport: 'http',
    defaultBaseUrl: OPENAI_BASE,
    authentication: 'managed',
    supportsNuextract: false,
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    transport: 'http',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    authentication: 'managed',
    supportsNuextract: false,
  },
  {
    kind: 'google',
    label: 'Google',
    transport: 'http',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authentication: 'managed',
    supportsNuextract: false,
  },
  {
    kind: 'codex-cli',
    label: 'Codex CLI',
    transport: 'cli',
    defaultBaseUrl: null,
    authentication: 'external',
    supportsNuextract: false,
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    transport: 'cli',
    defaultBaseUrl: null,
    authentication: 'external',
    supportsNuextract: false,
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    transport: 'http',
    defaultBaseUrl: null,
    authentication: 'optional',
    supportsNuextract: false,
  },
  {
    kind: 'vllm',
    label: 'vLLM',
    transport: 'http',
    defaultBaseUrl: null,
    authentication: 'optional',
    supportsNuextract: true,
  },
]

const NO_DEPLOYMENT: DeploymentModels = { connections: [], defaultRoute: null }
const deployment: DeploymentModels = {
  connections: [
    { id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment instruction model', provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1', hasKey: false },
    { id: DEPLOYMENT_CONNECTION_IDS.nuextract, name: 'Deployment NuExtract', provider: 'vllm', baseUrl: 'http://nuextract_model:8000/v1', hasKey: false },
  ],
  defaultRoute: { connectionId: DEPLOYMENT_CONNECTION_IDS.instruct, modelId: 'Qwen/Qwen3.8-27B-FP8' },
}
const extractionListing = {
  defaults: { fields: 'nuextract', reasoning: 'instruct' },
  models: [
    { key: 'instruct', repo: 'Qwen/Qwen3.8-27B-FP8', roles: ['fields', 'reasoning'], reachable: true, serving: true },
    { key: 'nuextract', repo: 'numind/NuExtract3-FP8', roles: ['fields'], reachable: true, serving: false },
  ],
}

const emptyConfig: ModelConfig = {
  connections: [],
  routes: { schemaSuggestion: null, interaction: null },
  extractionModels: {},
  ingestionModels: {},
}

function ollamaConfig(modelId = 'saved-model', hasKey = false): ModelConfig {
  const route = { connectionId: OLLAMA_ID, modelId }
  return {
    connections: [{ id: OLLAMA_ID, name: 'Local Ollama', provider: 'ollama', baseUrl: OLLAMA_BASE, hasKey }],
    routes: { schemaSuggestion: route, interaction: route },
    extractionModels: {},
    ingestionModels: {},
  }
}

function mixedConfig(): ModelConfig {
  return {
    connections: [
      { id: OLLAMA_ID, name: 'Local Ollama', provider: 'ollama', baseUrl: OLLAMA_BASE, hasKey: false },
      { id: OPENAI_ID, name: 'Research OpenAI', provider: 'openai', baseUrl: OPENAI_BASE, hasKey: true },
    ],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {},
    ingestionModels: {},
  }
}

function storeKey(id: string, provider: string, baseUrl: string, key: string): void {
  const stored = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Record<string, unknown>
  localStorage.setItem(STORAGE, JSON.stringify({ ...stored, [id]: { provider, baseUrl, key } }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function configResponse(config: ModelConfig, deploymentModels: DeploymentModels = NO_DEPLOYMENT): Response {
  return jsonResponse({ config, providers, deployment: deploymentModels })
}

const connectedProbe = () => jsonResponse({
  checkedAt: '2026-07-25T00:00:00.000Z',
  status: 'connected',
  message: 'Connected.',
  catalog: [],
})

type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response

/** Records every Model Configuration request; kei-exp's model listing is answered apart, so counts stay exact. */
function mockFetch(handler: FetchHandler, listing: () => Response = () => jsonResponse(extractionListing)) {
  const request = vi.fn(
    (input: string | URL | Request, init: RequestInit = {}) => {
      expect(init.credentials).toBe('same-origin')
      return Promise.resolve(handler(String(input), init))
    },
  )
  vi.stubGlobal('fetch', (input: string | URL | Request, init: RequestInit = {}) =>
    String(input).endsWith('/api/extraction-models') ? Promise.resolve(listing()) : request(input, init))
  return request
}

/** Saves what it is sent, answers every probe as connected and every key handoff as accepted. */
function savingServer(initial: ModelConfig, deploymentModels: DeploymentModels = NO_DEPLOYMENT) {
  let stored = initial
  const request = mockFetch((url, init) => {
    if (url === '/api/model_config' && init.method === 'PUT') {
      stored = requestBody(init).config as ModelConfig
      return jsonResponse({ config: stored })
    }
    if (url === '/api/model_probe') return connectedProbe()
    if (url === '/api/model-keys') return jsonResponse({ accepted: [] })
    return configResponse(stored, deploymentModels)
  })
  const bodies = (url: string, method: string) =>
    request.mock.calls.filter(([input, init]) => String(input) === url && init?.method === method).map(([, init]) => requestBody(init!))
  return { request, bodies, stored: () => stored }
}

function requestBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

function renderConfigurationPage() {
  return render(
    <ResearcherSessionContext value={SESSION}>
      <ProviderConfigPage onClose={() => {}} />
    </ResearcherSessionContext>,
  )
}

async function renderPage(): Promise<void> {
  renderConfigurationPage()
  await waitFor(() => expect(screen.queryByText('Loading model configuration…')).not.toBeInTheDocument())
}

const card = (name: string) => screen.getAllByRole('article').find((article) => within(article).queryByDisplayValue(name))!

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('ProviderConfigPage', () => {
  it('loads backend-owned state without probing', async () => {
    const config = mixedConfig()
    const request = mockFetch((url, init) => {
      expect(url).toBe('/api/model_config')
      expect(init.method).toBeUndefined()
      return configResponse(config)
    })

    await renderPage()

    expect(screen.getByDisplayValue('Local Ollama')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Research OpenAI')).toBeInTheDocument()
    expect(within(card('Local Ollama')).getByLabelText('API key (optional)')).toHaveValue('')
    expect(within(card('Research OpenAI')).getByLabelText('API key')).toHaveValue('')
    expect(screen.queryByRole('group', { name: 'Configuration mode' })).not.toBeInTheDocument()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('submits one unchanged draft, disables pending Apply, replaces it from the response, and reloads it', async () => {
    let stored = ollamaConfig()
    let finishPut: ((response: Response) => void) | undefined
    const putResponse = new Promise<Response>((resolve) => { finishPut = resolve })
    const request = mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        const submitted = requestBody(init).config as ModelConfig
        expect(submitted.routes.interaction?.modelId).toBe('manual-model')
        expect(submitted.routes.schemaSuggestion?.modelId).toBe('saved-model')
        for (const route of Object.values(submitted.routes)) expect(route).not.toHaveProperty('jsonOutput')
        stored = {
          ...submitted,
          routes: { ...submitted.routes, interaction: { ...submitted.routes.interaction!, modelId: 'normalized-model' } },
        }
        return putResponse
      }
      return configResponse(stored)
    })

    const first = renderConfigurationPage()
    expect(await screen.findByLabelText(INTERACTION_MODEL)).toHaveValue('saved-model')
    expect(screen.queryByLabelText(/output support/)).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced output settings')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText(INTERACTION_MODEL), { target: { value: 'manual-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled())
    expect(screen.getByLabelText(INTERACTION_MODEL)).toBeDisabled()
    expect(request.mock.calls.filter(([url]) => String(url) === '/api/model_config')).toHaveLength(2)
    expect(request.mock.calls.some(([url]) => String(url) === '/api/model_probe')).toBe(false)

    await act(async () => {
      finishPut?.(jsonResponse({ config: stored }))
      await putResponse
    })
    expect(screen.getByLabelText(INTERACTION_MODEL)).toHaveValue('normalized-model')

    first.unmount()
    renderConfigurationPage()
    expect(await screen.findByLabelText(INTERACTION_MODEL)).toHaveValue('normalized-model')
  })

  it('retains a failed draft, renders the stable error, and permits a retry', async () => {
    let attempts = 0
    const request = mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        attempts += 1
        if (attempts === 1) {
          return jsonResponse(
            { error: { code: 'persistence_unavailable', message: 'Model Configuration storage is unavailable.' } },
            503,
          )
        }
        return jsonResponse({ config: requestBody(init).config })
      }
      return configResponse(ollamaConfig())
    })

    await renderPage()
    fireEvent.change(screen.getByLabelText(INTERACTION_MODEL), { target: { value: 'offline-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'persistence_unavailable: Model Configuration storage is unavailable.',
    )
    expect(screen.getByLabelText(INTERACTION_MODEL)).toHaveValue('offline-model')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText(INTERACTION_MODEL)).toHaveValue('offline-model')
  })

  // An empty model ID is the likeliest rejected Apply and `invalid_request: The
  // request is invalid.` alone does not say which field to fix.
  it('names the offending field when a rejected Apply carries validation issues', async () => {
    mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        return jsonResponse(
          {
            error: {
              code: 'invalid_request',
              message: 'The request is invalid.',
              details: {
                path: 'request',
                issues: [{ path: 'config.routes.schemaSuggestion.modelId', message: 'Must not be empty.' }],
                truncated: false,
              },
            },
          },
          400,
        )
      }
      return configResponse(ollamaConfig())
    })

    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('invalid_request: The request is invalid.')
    expect(alert).toHaveTextContent('config.routes.schemaSuggestion.modelId: Must not be empty.')
  })

  it('debounces draft checks, cancels and suppresses stale results, and saves offline', async () => {
    const probeResolvers: Array<(response: Response) => void> = []
    const putBodies: Record<string, unknown>[] = []
    const request = mockFetch((url, init) => {
      if (url === '/api/model_probe') {
        return new Promise<Response>((resolve) => probeResolvers.push(resolve))
      }
      if (url === '/api/model_config' && init.method === 'PUT') {
        putBodies.push(requestBody(init))
        return jsonResponse({ config: requestBody(init).config })
      }
      return configResponse(emptyConfig)
    })

    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(OLLAMA_ID)
    await renderPage()
    expect(request).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()

    fireEvent.click(screen.getByRole('button', { name: '+ New connection' }))
    const baseInput = screen.getByDisplayValue(OLLAMA_BASE)
    fireEvent.change(baseInput, { target: { value: 'http://localhost:11434/first' } })
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(probeResolvers).toHaveLength(0)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(probeResolvers).toHaveLength(1)
    expect(screen.getByText('Checking…')).toBeInTheDocument()
    const firstProbe = request.mock.calls.find(([url]) => String(url) === '/api/model_probe')
    const firstSignal = firstProbe?.[1]?.signal
    // A keyless connection is probed without a key.
    expect(requestBody(firstProbe![1]!)).not.toHaveProperty('credential')

    fireEvent.change(baseInput, { target: { value: 'http://localhost:11434/latest' } })
    expect(firstSignal?.aborted).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(probeResolvers).toHaveLength(2)

    await act(async () => {
      probeResolvers[1](jsonResponse({
        checkedAt: '2026-07-25T00:00:01.000Z',
        status: 'connected',
        message: 'Latest connection is ready.',
        catalog: [{ id: 'latest-model', label: 'Latest model' }],
      }))
      await Promise.resolve()
    })
    expect(screen.getByText('Latest connection is ready.')).toBeInTheDocument()

    await act(async () => {
      probeResolvers[0](jsonResponse({
        checkedAt: '2026-07-25T00:00:00.000Z',
        status: 'unreachable',
        message: 'Stale provider failure.',
        catalog: [],
      }))
      await Promise.resolve()
    })
    expect(screen.queryByText('Stale provider failure.')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(INTERACTION_CONNECTION), { target: { value: OLLAMA_ID } })
    fireEvent.focus(screen.getByLabelText(INTERACTION_MODEL))
    expect(probeResolvers).toHaveLength(2) // already probed this session; opening the list must not re-probe
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: 'Latest model' }))
    expect(screen.getByLabelText(INTERACTION_MODEL)).toHaveValue('latest-model')

    // reopening after a pick still shows the full catalog, not a filtered single entry
    fireEvent.focus(screen.getByLabelText(INTERACTION_MODEL))
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1)

    fireEvent.change(screen.getByLabelText(INTERACTION_MODEL), { target: { value: 'manual-offline-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await act(async () => { await Promise.resolve() })
    expect(putBodies).toHaveLength(1)
    expect((putBodies[0].config as ModelConfig).routes.interaction?.modelId).toBe('manual-offline-model')
  })

  it('probes when the model list is opened for an unchecked connection, once per session', async () => {
    const probeResolvers: Array<(response: Response) => void> = []
    const request = mockFetch((url) => {
      if (url === '/api/model_probe') {
        return new Promise<Response>((resolve) => probeResolvers.push(resolve))
      }
      return configResponse(ollamaConfig())
    })

    await renderPage()
    expect(request.mock.calls.some(([url]) => String(url) === '/api/model_probe')).toBe(false)

    fireEvent.focus(screen.getByLabelText(INTERACTION_MODEL))
    expect(probeResolvers).toHaveLength(1)
    expect(within(screen.getByRole('listbox')).getByText('Loading models…')).toBeInTheDocument()
    await act(async () => {
      probeResolvers[0](jsonResponse({
        checkedAt: '2026-07-25T00:00:00.000Z',
        status: 'connected',
        message: 'Connection is ready.',
        catalog: [
          { id: 'model-a', label: 'Model A' },
          { id: 'model-b', label: 'Model B' },
        ],
      }))
      await Promise.resolve()
    })
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2)

    fireEvent.mouseDown(within(screen.getByRole('listbox')).getByRole('option', { name: 'Model A' }))
    expect(screen.getByLabelText(INTERACTION_MODEL)).toHaveValue('model-a')
    fireEvent.focus(screen.getByLabelText(INTERACTION_MODEL))
    expect(probeResolvers).toHaveLength(1)
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2)
  })

  it('guides first-time setup when no connections exist', async () => {
    mockFetch(() => configResponse(emptyConfig))

    await renderPage()

    expect(screen.getByText('No Model Connections yet.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Configuration mode' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(INTERACTION_CONNECTION)).not.toBeInTheDocument()
  })

  it('Apply stores typed keys in this browser bound to the committed base and sends them to Studio', async () => {
    const server = savingServer(mixedConfig())

    await renderPage()
    fireEvent.change(within(card('Research OpenAI')).getByLabelText('API key'), { target: { value: 'sk-test-typed' } })
    // The typed key is what the connection is probed with.
    await waitFor(() => expect(server.bodies('/api/model_probe', 'POST')).toHaveLength(1))
    expect(server.bodies('/api/model_probe', 'POST')[0]).toMatchObject({
      connection: { id: OPENAI_ID, hasKey: true }, credential: 'sk-test-typed',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model-keys', 'PUT')).toHaveLength(1))
    const entry = { provider: 'openai', baseUrl: OPENAI_BASE, key: 'sk-test-typed' }
    expect(JSON.parse(localStorage.getItem(STORAGE)!)).toEqual({ [OPENAI_ID]: entry })
    expect(server.bodies('/api/model-keys', 'PUT')[0]).toEqual({ account: ACCOUNT, keys: { [OPENAI_ID]: entry } })
    const order = server.request.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)
    expect(order.indexOf('PUT /api/model_config')).toBeLessThan(order.indexOf('PUT /api/model-keys'))
    expect(within(card('Research OpenAI')).getByText('Key saved in this browser')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('sk-test-typed')
  })

  it('a draft base change clears the typed key and never probes the new base with the old key', async () => {
    storeKey(OPENAI_ID, 'openai', OPENAI_BASE, 'sk-test-stored-old-base')
    const server = savingServer(mixedConfig())

    await renderPage()
    vi.useFakeTimers()
    const openai = card('Research OpenAI')
    expect(within(openai).getByText('Key saved in this browser')).toBeInTheDocument()
    fireEvent.click(within(openai).getByRole('button', { name: 'Replace' }))
    fireEvent.change(within(openai).getByLabelText('API key'), { target: { value: 'sk-test-typed-old-base' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    fireEvent.change(within(openai).getByDisplayValue(OPENAI_BASE), { target: { value: 'https://gateway.example/v1' } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(within(openai).getByLabelText('API key')).toHaveValue('')
    const probes = server.request.mock.calls.filter(([url]) => String(url) === '/api/model_probe')
    expect(probes).toHaveLength(0)
    expect(JSON.stringify(server.request.mock.calls)).not.toMatch(/sk-test-(typed|stored)-old-base/)
    expect(within(openai).getByText('Not checked this session.')).toBeInTheDocument()
  })

  it('Remove drops this browser\'s key on Apply and tells Studio; an optional connection then uses no key', async () => {
    storeKey(OLLAMA_ID, 'ollama', OLLAMA_BASE, 'sk-test-removed')
    const server = savingServer(ollamaConfig('saved-model', true))

    await renderPage()
    const ollama = card('Local Ollama')
    fireEvent.click(within(ollama).getByRole('button', { name: 'Remove' }))
    expect(within(ollama).getByLabelText('API key (optional)')).toHaveAttribute('placeholder', 'Used without a key')
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model-keys', 'PUT')).toHaveLength(1))
    expect((server.bodies('/api/model_config', 'PUT')[0].config as ModelConfig).connections[0].hasKey).toBe(false)
    expect(localStorage.getItem(STORAGE)).toBeNull()
    expect(server.bodies('/api/model-keys', 'PUT')[0]).toEqual({ account: ACCOUNT, keys: { [OLLAMA_ID]: null } })
    expect(within(ollama).queryByText('Key saved in this browser')).not.toBeInTheDocument()
    expect(within(ollama).queryByRole('button', { name: 'Use without a key' })).not.toBeInTheDocument()
  })

  it('a managed connection keeps hasKey when its key is removed', async () => {
    storeKey(OPENAI_ID, 'openai', OPENAI_BASE, 'sk-test-managed')
    const server = savingServer(mixedConfig())

    await renderPage()
    const openai = card('Research OpenAI')
    fireEvent.click(within(openai).getByRole('button', { name: 'Remove' }))
    expect(within(openai).getByLabelText('API key')).toHaveValue('')
    expect(within(openai).queryByRole('button', { name: 'Use without a key' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model-keys', 'PUT')).toHaveLength(1))
    const saved = server.bodies('/api/model_config', 'PUT')[0].config as ModelConfig
    expect(saved.connections.find(({ id }) => id === OPENAI_ID)?.hasKey).toBe(true)
    expect(localStorage.getItem(STORAGE)).toBeNull()
    expect(server.bodies('/api/model-keys', 'PUT')[0]).toEqual({ account: ACCOUNT, keys: { [OPENAI_ID]: null } })
  })

  it('an optional-key connection without its key in this browser can be used without one', async () => {
    const server = savingServer(ollamaConfig('saved-model', true))

    await renderPage()
    const ollama = card('Local Ollama')
    fireEvent.click(within(ollama).getByRole('button', { name: 'Use without a key' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model_config', 'PUT')).toHaveLength(1))
    expect((server.bodies('/api/model_config', 'PUT')[0].config as ModelConfig).connections[0].hasKey).toBe(false)
  })

  it('a hasKey connection without a key in this browser is not probed', async () => {
    const server = savingServer({ ...mixedConfig(), routes: { schemaSuggestion: null, interaction: { connectionId: OPENAI_ID, modelId: 'gpt' } } })

    await renderPage()
    vi.useFakeTimers()
    fireEvent.focus(screen.getByLabelText(INTERACTION_MODEL))
    fireEvent.change(within(card('Research OpenAI')).getByDisplayValue(OPENAI_BASE), { target: { value: 'https://gateway.example/v1' } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(server.bodies('/api/model_probe', 'POST')).toEqual([])
    expect(within(card('Research OpenAI')).getByText('Not checked this session.')).toBeInTheDocument()
  })

  it('the model_config PUT body carries no key and no credentials', async () => {
    storeKey(OLLAMA_ID, 'ollama', OLLAMA_BASE, 'sk-test-stored-ollama')
    const server = savingServer({ ...mixedConfig(), connections: [{ ...mixedConfig().connections[0], hasKey: true }, mixedConfig().connections[1]] })

    await renderPage()
    fireEvent.change(within(card('Research OpenAI')).getByLabelText('API key'), { target: { value: 'sk-test-typed-openai' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model-keys', 'PUT')).toHaveLength(1))
    const [put] = server.request.mock.calls.filter(([url, init]) => String(url) === '/api/model_config' && init?.method === 'PUT')
    const text = String(put[1]!.body)
    expect(Object.keys(JSON.parse(text))).toEqual(['config'])
    expect(text).not.toMatch(/sk-test|credential/)
    expect(server.bodies('/api/model-keys', 'PUT')[0].keys).toEqual({
      [OLLAMA_ID]: { provider: 'ollama', baseUrl: OLLAMA_BASE, key: 'sk-test-stored-ollama' },
      [OPENAI_ID]: { provider: 'openai', baseUrl: OPENAI_BASE, key: 'sk-test-typed-openai' },
    })
  })

  it('the NuExtract protocol is shown as automatic for a NuExtract model on vLLM and never offered as a choice', async () => {
    const VLLM_ID = '33333333-3333-4333-8333-333333333333'
    const NOTE = 'Uses the NuExtract protocol for this model.'
    const config = mixedConfig()
    config.connections.push({ id: VLLM_ID, name: 'Lab vLLM', provider: 'vllm', baseUrl: 'http://lab.example:8000/v1', hasKey: false })
    const server = savingServer(config)

    await renderPage()
    const suggestionConnection = screen.getByLabelText('Schema Suggestion connection')
    const suggestionModel = screen.getByLabelText('Schema Suggestion model ID')
    fireEvent.change(suggestionConnection, { target: { value: VLLM_ID } })
    fireEvent.change(suggestionModel, { target: { value: 'Qwen/Qwen3.8-27B-FP8' } })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
    fireEvent.change(suggestionModel, { target: { value: 'numind/NuExtract3-FP8' } })
    expect(screen.getByText(NOTE)).toBeInTheDocument()

    // Not on a connection that cannot pass NuExtract's chat-template controls.
    fireEvent.change(suggestionConnection, { target: { value: OLLAMA_ID } })
    expect(screen.queryByText(NOTE)).not.toBeInTheDocument()
    fireEvent.change(suggestionConnection, { target: { value: VLLM_ID } })
    expect(screen.getByText(NOTE)).toBeInTheDocument()

    // Never on the Interaction Route, even for the same NuExtract target.
    fireEvent.change(screen.getByLabelText(INTERACTION_CONNECTION), { target: { value: VLLM_ID } })
    fireEvent.change(screen.getByLabelText(INTERACTION_MODEL), { target: { value: 'numind/NuExtract3-FP8' } })
    expect(screen.getAllByText(NOTE)).toHaveLength(1)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(INTERACTION_CONNECTION), { target: { value: OPENAI_ID } })
    fireEvent.change(screen.getByLabelText(INTERACTION_MODEL), { target: { value: 'gpt-manual' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model_config', 'PUT')).toHaveLength(1))
    const saved = server.bodies('/api/model_config', 'PUT')[0].config as ModelConfig
    expect(saved.routes.schemaSuggestion).toEqual({ connectionId: VLLM_ID, modelId: 'numind/NuExtract3-FP8' })
    expect(saved.routes.interaction).toEqual({ connectionId: OPENAI_ID, modelId: 'gpt-manual' })
  })

  it('sets the deployment-wide Extraction Model Choice from kei-exp\'s listing', async () => {
    const server = savingServer({ ...emptyConfig, extractionModels: { reasoning: 'instruct' } })
    const optionLabels = (label: string) =>
      Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => option.textContent)

    await renderPage()
    await waitFor(() => expect(optionLabels('Field model')).toEqual([
      'Default (numind/NuExtract3-FP8)', 'Qwen/Qwen3.8-27B-FP8', 'numind/NuExtract3-FP8 (unavailable)',
    ]))
    // NuExtract cannot take the reasoning role, so it is not offered there.
    expect(optionLabels('Reasoning model')).toEqual(['Default (Qwen/Qwen3.8-27B-FP8)', 'Qwen/Qwen3.8-27B-FP8'])
    expect(screen.getByLabelText('Reasoning model')).toHaveValue('instruct')

    fireEvent.change(screen.getByLabelText('Field model'), { target: { value: 'instruct' } })
    fireEvent.change(screen.getByLabelText('Reasoning model'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model_config', 'PUT')).toHaveLength(1))
    expect((server.bodies('/api/model_config', 'PUT')[0].config as ModelConfig).extractionModels).toEqual({ fields: 'instruct' })
  })

  it('keeps only the Default extraction models when kei-exp cannot list them', async () => {
    mockFetch(() => configResponse(emptyConfig), () => jsonResponse({ error: { code: 'extraction_models_unavailable', message: 'Unavailable.' } }, 503))
    await renderPage()
    const labels = (label: string) =>
      Array.from((screen.getByLabelText(label) as HTMLSelectElement).options).map((option) => option.textContent)
    expect(labels('Field model')).toEqual(['Default'])
    expect(labels('Reasoning model')).toEqual(['Default'])
  })

  it('offers the deployment connections read-only and names the default an unset route runs on', async () => {
    const server = savingServer(emptyConfig, deployment)

    await renderPage()
    const listed = within(screen.getByText('Deployment connections').parentElement!)
    expect(listed.getByText('Deployment NuExtract')).toBeInTheDocument()
    expect(listed.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()

    const suggestionConnection = screen.getByLabelText('Schema Suggestion connection')
    expect(suggestionConnection).toHaveValue('')
    expect(within(suggestionConnection).getByRole('option', { name: 'Deployment default (Qwen/Qwen3.8-27B-FP8)' })).toBeInTheDocument()
    fireEvent.change(suggestionConnection, { target: { value: DEPLOYMENT_CONNECTION_IDS.nuextract } })
    fireEvent.change(screen.getByLabelText('Schema Suggestion model ID'), { target: { value: 'numind/NuExtract3-FP8' } })
    expect(screen.getByText('Uses the NuExtract protocol for this model.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(server.bodies('/api/model_config', 'PUT')).toHaveLength(1))
    const saved = server.bodies('/api/model_config', 'PUT')[0].config as ModelConfig
    expect(saved.connections).toEqual([])
    expect(saved.routes.schemaSuggestion).toEqual({
      connectionId: DEPLOYMENT_CONNECTION_IDS.nuextract, modelId: 'numind/NuExtract3-FP8',
    })
  })

  it('CLI kinds are not offered for a new connection; enabled CLI deployment connections are listed read-only', async () => {
    const withCli: DeploymentModels = {
      connections: [
        { id: DEPLOYMENT_CONNECTION_IDS.codexCli, name: 'Codex CLI on this server', provider: 'codex-cli', baseUrl: null, hasKey: false },
        { id: DEPLOYMENT_CONNECTION_IDS.claudeCode, name: 'Claude Code on this server', provider: 'claude-code', baseUrl: null, hasKey: false },
      ],
      defaultRoute: null,
    }
    savingServer(emptyConfig, withCli)

    await renderPage()

    const offered = Array.from((screen.getByLabelText('New connection provider') as HTMLSelectElement).options).map(({ value }) => value)
    expect(offered).toEqual(['ollama', 'openai', 'anthropic', 'google', 'openai-compatible', 'vllm'])
    expect(screen.getByLabelText('New connection provider')).toHaveValue('ollama')

    const listed = within(screen.getByText('Deployment connections').parentElement!)
    for (const name of ['Codex CLI on this server', 'Claude Code on this server']) {
      const item = listed.getByText(name).closest('li')!
      expect(within(item).getByText("Runs on this server's CLI login")).toBeInTheDocument()
    }
    expect(listed.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()
    // A route may still name one.
    expect(within(screen.getByLabelText(INTERACTION_CONNECTION)).getByRole('option', { name: 'Claude Code on this server' })).toBeInTheDocument()
  })

  it('renders corrupt saved configuration through the stable load error', async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { code: 'invalid_model_config', message: 'Saved model configuration is invalid.' } },
        500,
      ),
    )

    renderConfigurationPage()

    expect(await screen.findByText('Model configuration could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'invalid_model_config: Saved model configuration is invalid.',
    )
  })
})
