// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEPLOYMENT_CONNECTION_IDS,
  type CredentialState,
  type DeploymentModels,
  type ModelConfig,
  type ProviderDescriptor,
} from '../../shared/modelConfig.contract'
import ProviderConfigPage from './ProviderConfigPage'

const OLLAMA_ID = '11111111-1111-4111-8111-111111111111'
const OPENAI_ID = '22222222-2222-4222-8222-222222222222'

const providers: ProviderDescriptor[] = [
  {
    kind: 'ollama',
    label: 'Ollama',
    transport: 'http',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    authentication: 'optional',
    supportsNuextract: false,
  },
  {
    kind: 'openai',
    label: 'OpenAI',
    transport: 'http',
    defaultBaseUrl: 'https://api.openai.com/v1',
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
    { id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment instruction model', provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1' },
    { id: DEPLOYMENT_CONNECTION_IDS.nuextract, name: 'Deployment NuExtract', provider: 'vllm', baseUrl: 'http://nuextract_model:8000/v1' },
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

function ollamaConfig(modelId = 'saved-model'): ModelConfig {
  const route = { connectionId: OLLAMA_ID, modelId }
  return {
    connections: [
      {
        id: OLLAMA_ID,
        name: 'Local Ollama',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
      },
    ],
    routes: { schemaSuggestion: route, interaction: route },
    extractionModels: {},
    ingestionModels: {},
  }
}

function mixedConfig(): ModelConfig {
  return {
    connections: [
      {
        id: OLLAMA_ID,
        name: 'Local Ollama',
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
      },
      {
        id: OPENAI_ID,
        name: 'Research OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
      },
    ],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {},
    ingestionModels: {},
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function configResponse(
  config: ModelConfig,
  credentialStates: Record<string, CredentialState> = {},
  deploymentModels: DeploymentModels = NO_DEPLOYMENT,
): Response {
  return jsonResponse({ config, credentialStates, providers, deployment: deploymentModels })
}

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

function requestBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

async function renderPage(): Promise<void> {
  render(<ProviderConfigPage onClose={() => {}} />)
  await waitFor(() => expect(screen.queryByText('Loading model configuration…')).not.toBeInTheDocument())
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ProviderConfigPage', () => {
  it('loads backend-owned state without probing and renders partial credential states', async () => {
    const config = mixedConfig()
    const request = mockFetch((url, init) => {
      expect(url).toBe('/api/model_config')
      expect(init.method).toBeUndefined()
      return configResponse(config, { [OPENAI_ID]: 'unavailable' })
    })

    await renderPage()

    expect(screen.getByDisplayValue('Local Ollama')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Research OpenAI')).toBeInTheDocument()
    expect(screen.getByText('Credential store unavailable.')).toBeInTheDocument()
    const cards = screen.getAllByRole('article')
    expect(within(cards[0]).getByPlaceholderText('Enter a credential')).toHaveValue('')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls.some(([url]) => String(url) === '/api/model_probe')).toBe(false)
  })

  it('submits one unchanged draft, disables pending Apply, replaces it from the response, and reloads it', async () => {
    let stored = ollamaConfig()
    let finishPut: ((response: Response) => void) | undefined
    const putResponse = new Promise<Response>((resolve) => { finishPut = resolve })
    const request = mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        const submitted = requestBody(init).config as ModelConfig
        expect(submitted.routes.schemaSuggestion?.modelId).toBe('manual-model')
        expect(submitted.routes.interaction?.modelId).toBe('manual-model')
        for (const route of Object.values(submitted.routes)) expect(route).not.toHaveProperty('jsonOutput')
        stored = {
          ...submitted,
          routes: {
            schemaSuggestion: { ...submitted.routes.schemaSuggestion!, modelId: 'normalized-model' },
            interaction: { ...submitted.routes.interaction!, modelId: 'normalized-model' },
          },
        }
        return putResponse
      }
      return configResponse(stored)
    })

    const first = render(<ProviderConfigPage onClose={() => {}} />)
    await screen.findByDisplayValue('saved-model')
    expect(screen.queryByLabelText(/output support/)).not.toBeInTheDocument()
    expect(screen.queryByText('Advanced output settings')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Single model ID'), { target: { value: 'manual-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled())
    expect(screen.getByLabelText('Single model ID')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Capability Routes' })).toBeDisabled()
    expect(request.mock.calls.filter(([url]) => String(url) === '/api/model_config')).toHaveLength(2)
    expect(request.mock.calls.some(([url]) => String(url) === '/api/model_probe')).toBe(false)

    await act(async () => {
      finishPut?.(jsonResponse({ config: stored, credentialStates: { [OLLAMA_ID]: 'absent' } }))
      await putResponse
    })
    expect(screen.getByLabelText('Single model ID')).toHaveValue('normalized-model')

    first.unmount()
    render(<ProviderConfigPage onClose={() => {}} />)
    expect(await screen.findByLabelText('Single model ID')).toHaveValue('normalized-model')
  })

  it('retains a failed draft, renders the stable error, and permits an offline save retry', async () => {
    let attempts = 0
    const request = mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        attempts += 1
        if (attempts === 1) {
          return jsonResponse(
            { error: { code: 'keyring_unavailable', message: 'The credential store is locked.' } },
            503,
          )
        }
        return jsonResponse({
          config: requestBody(init).config,
          credentialStates: { [OLLAMA_ID]: 'absent' },
        })
      }
      return configResponse(ollamaConfig())
    })

    await renderPage()
    fireEvent.change(screen.getByLabelText('Single model ID'), { target: { value: 'offline-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'keyring_unavailable: The credential store is locked.',
    )
    expect(screen.getByLabelText('Single model ID')).toHaveValue('offline-model')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Single model ID')).toHaveValue('offline-model')
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

  it('debounces draft checks, cancels and suppresses stale results, retries immediately, and saves offline', async () => {
    const probeResolvers: Array<(response: Response) => void> = []
    const putBodies: Record<string, unknown>[] = []
    const request = mockFetch((url, init) => {
      if (url === '/api/model_probe') {
        return new Promise<Response>((resolve) => probeResolvers.push(resolve))
      }
      if (url === '/api/model_config' && init.method === 'PUT') {
        putBodies.push(requestBody(init))
        return jsonResponse({
          config: requestBody(init).config,
          credentialStates: { [OLLAMA_ID]: 'absent' },
        })
      }
      return configResponse(emptyConfig)
    })

    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(OLLAMA_ID)
    await renderPage()
    expect(request).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()

    fireEvent.click(screen.getByRole('button', { name: '+ New connection' }))
    const baseInput = screen.getByDisplayValue('http://127.0.0.1:11434')
    fireEvent.change(baseInput, { target: { value: 'http://localhost:11434/first' } })
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(probeResolvers).toHaveLength(0)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(probeResolvers).toHaveLength(1)
    expect(screen.getByText('Checking…')).toBeInTheDocument()
    const firstSignal = request.mock.calls.find(([url]) => String(url) === '/api/model_probe')?.[1]?.signal

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

    fireEvent.change(screen.getByLabelText('Single model connection'), { target: { value: OLLAMA_ID } })
    fireEvent.focus(screen.getByLabelText('Single model ID'))
    expect(probeResolvers).toHaveLength(2) // already probed this session; opening the list must not re-probe
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(1)
    fireEvent.mouseDown(within(listbox).getByRole('option', { name: 'Latest model' }))
    expect(screen.getByLabelText('Single model ID')).toHaveValue('latest-model')

    // reopening after a pick still shows the full catalog, not a filtered single entry
    fireEvent.focus(screen.getByLabelText('Single model ID'))
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Single model ID'), { target: { value: 'manual-offline-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await act(async () => { await Promise.resolve() })
    expect(putBodies).toHaveLength(1)
    expect((putBodies[0].config as ModelConfig).routes.schemaSuggestion?.modelId).toBe('manual-offline-model')
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

    fireEvent.focus(screen.getByLabelText('Single model ID'))
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
    expect(screen.getByLabelText('Single model ID')).toHaveValue('model-a')
    fireEvent.focus(screen.getByLabelText('Single model ID'))
    expect(probeResolvers).toHaveLength(1)
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2)
  })

  it('guides first-time setup when no connections exist', async () => {
    mockFetch(() => configResponse(emptyConfig))

    await renderPage()

    expect(screen.getByText('No Model Connections yet.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Configuration mode' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Single model connection')).not.toBeInTheDocument()
    expect(screen.queryByText(/Capability Routes currently differ/)).not.toBeInTheDocument()
  })

  it('implements credential preserve, replace, and delete without retaining transient values', async () => {
    const config = mixedConfig()
    const putBodies: Record<string, unknown>[] = []
    let states: Record<string, CredentialState> = { [OPENAI_ID]: 'present' }
    const request = mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        const body = requestBody(init)
        putBodies.push(body)
        const action = (body.credentials as Record<string, string | null> | undefined)?.[OPENAI_ID]
        if (action === null) states = { [OPENAI_ID]: 'absent' }
        else if (typeof action === 'string') states = { [OPENAI_ID]: 'present' }
        return jsonResponse({ config: body.config, credentialStates: states })
      }
      return configResponse(config, states)
    })

    await renderPage()
    const openaiCard = screen.getAllByRole('article')[1]
    const credential = within(openaiCard).getByLabelText('API credential')
    expect(credential).toHaveValue('')
    expect(credential).toHaveAttribute('placeholder', 'Stored credential will be preserved')

    fireEvent.click(within(openaiCard).getByRole('button', { name: 'Remove credential' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(putBodies).toHaveLength(1))
    expect(putBodies[0].credentials).toEqual({ [OPENAI_ID]: null })
    expect(credential).toHaveAttribute('placeholder', 'Enter a credential')

    fireEvent.change(credential, { target: { value: 'replacement-secret' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(putBodies).toHaveLength(2))
    expect(putBodies[1].credentials).toEqual({ [OPENAI_ID]: 'replacement-secret' })
    expect(credential).toHaveValue('')
    expect(credential).toHaveAttribute('placeholder', 'Stored credential will be preserved')
    expect(document.body).not.toHaveTextContent('replacement-secret')

    fireEvent.change(credential, { target: { value: 'discarded-secret' } })
    fireEvent.click(within(openaiCard).getByRole('button', { name: 'Preserve stored value' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    await waitFor(() => expect(putBodies).toHaveLength(3))
    expect(putBodies[2]).not.toHaveProperty('credentials')
    expect(document.body).not.toHaveTextContent('discarded-secret')
    expect(request.mock.calls.filter(([url]) => String(url) === '/api/model_config')).toHaveLength(4)
  })

  it('the NuExtract protocol is shown as automatic for a NuExtract model on vLLM and never offered as a choice', async () => {
    const VLLM_ID = '33333333-3333-4333-8333-333333333333'
    const NOTE = 'Uses the NuExtract protocol for this model.'
    const putBodies: Record<string, unknown>[] = []
    const config = mixedConfig()
    config.connections.push({ id: VLLM_ID, name: 'Lab vLLM', provider: 'vllm', baseUrl: 'http://lab.example:8000/v1' })
    mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        const body = requestBody(init)
        putBodies.push(body)
        return jsonResponse({ config: body.config, credentialStates: {} })
      }
      return configResponse(config)
    })

    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Capability Routes' }))
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
    fireEvent.change(screen.getByLabelText('Chat & Extraction Schema editing connection'), {
      target: { value: VLLM_ID },
    })
    fireEvent.change(screen.getByLabelText('Chat & Extraction Schema editing model ID'), {
      target: { value: 'numind/NuExtract3-FP8' },
    })
    expect(screen.getAllByText(NOTE)).toHaveLength(1)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Chat & Extraction Schema editing connection'), {
      target: { value: OPENAI_ID },
    })
    fireEvent.change(screen.getByLabelText('Chat & Extraction Schema editing model ID'), {
      target: { value: 'gpt-manual' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(putBodies).toHaveLength(1))
    const saved = putBodies[0].config as ModelConfig
    expect(saved.routes.schemaSuggestion).toEqual({ connectionId: VLLM_ID, modelId: 'numind/NuExtract3-FP8' })
    expect(saved.routes.interaction).toEqual({ connectionId: OPENAI_ID, modelId: 'gpt-manual' })
  })

  it('sets the deployment-wide Extraction Model Choice from kei-exp\'s listing', async () => {
    const putBodies: Record<string, unknown>[] = []
    mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        const body = requestBody(init)
        putBodies.push(body)
        return jsonResponse({ config: body.config, credentialStates: {} })
      }
      return configResponse({ ...emptyConfig, extractionModels: { reasoning: 'instruct' } })
    })
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

    await waitFor(() => expect(putBodies).toHaveLength(1))
    expect((putBodies[0].config as ModelConfig).extractionModels).toEqual({ fields: 'instruct' })
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
    const putBodies: Record<string, unknown>[] = []
    mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        const body = requestBody(init)
        putBodies.push(body)
        return jsonResponse({ config: body.config, credentialStates: {} })
      }
      return configResponse(emptyConfig, {}, deployment)
    })

    await renderPage()
    const listed = within(screen.getByText('Deployment connections').parentElement!)
    expect(listed.getByText('Deployment NuExtract')).toBeInTheDocument()
    expect(listed.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('article')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Capability Routes' }))
    const suggestionConnection = screen.getByLabelText('Schema Suggestion connection')
    expect(suggestionConnection).toHaveValue('')
    expect(within(suggestionConnection).getByRole('option', { name: 'Deployment default (Qwen/Qwen3.8-27B-FP8)' })).toBeInTheDocument()
    fireEvent.change(suggestionConnection, { target: { value: DEPLOYMENT_CONNECTION_IDS.nuextract } })
    fireEvent.change(screen.getByLabelText('Schema Suggestion model ID'), { target: { value: 'numind/NuExtract3-FP8' } })
    expect(screen.getByText('Uses the NuExtract protocol for this model.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(putBodies).toHaveLength(1))
    const saved = putBodies[0].config as ModelConfig
    expect(saved.connections).toEqual([])
    expect(saved.routes.schemaSuggestion).toEqual({
      connectionId: DEPLOYMENT_CONNECTION_IDS.nuextract, modelId: 'numind/NuExtract3-FP8',
    })
  })

  it('renders corrupt saved configuration through the stable load error', async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { code: 'invalid_model_config', message: 'Saved model configuration is invalid.' } },
        500,
      ),
    )

    render(<ProviderConfigPage onClose={() => {}} />)

    expect(await screen.findByText('Model configuration could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'invalid_model_config: Saved model configuration is invalid.',
    )
  })
})
