// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CredentialState,
  ModelConfig,
  ProviderDescriptor,
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
    supportsNuextractRaw: true,
  },
  {
    kind: 'openai',
    label: 'OpenAI',
    transport: 'http',
    defaultBaseUrl: 'https://api.openai.com/v1',
    authentication: 'managed',
    supportsNuextractRaw: false,
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    transport: 'http',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    authentication: 'managed',
    supportsNuextractRaw: false,
  },
  {
    kind: 'google',
    label: 'Google',
    transport: 'http',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authentication: 'managed',
    supportsNuextractRaw: false,
  },
  {
    kind: 'codex-cli',
    label: 'Codex CLI',
    transport: 'cli',
    defaultBaseUrl: null,
    authentication: 'external',
    supportsNuextractRaw: false,
  },
  {
    kind: 'claude-code',
    label: 'Claude Code',
    transport: 'cli',
    defaultBaseUrl: null,
    authentication: 'external',
    supportsNuextractRaw: false,
  },
  {
    kind: 'openai-compatible',
    label: 'OpenAI-compatible',
    transport: 'http',
    defaultBaseUrl: null,
    authentication: 'optional',
    supportsNuextractRaw: false,
  },
]

const emptyConfig: ModelConfig = {
  connections: [],
  routes: { extraction: null, interaction: null },
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
    routes: { extraction: route, interaction: route },
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
    routes: { extraction: null, interaction: null },
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
): Response {
  return jsonResponse({ config, credentialStates, providers })
}

type FetchHandler = (url: string, init: RequestInit) => Promise<Response> | Response

function mockFetch(handler: FetchHandler) {
  const request = vi.fn((input: string | URL | Request, init: RequestInit = {}) =>
    Promise.resolve(handler(String(input), init)),
  )
  vi.stubGlobal('fetch', request)
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
        expect(submitted.routes.extraction?.modelId).toBe('manual-model')
        expect(submitted.routes.interaction?.modelId).toBe('manual-model')
        stored = {
          ...submitted,
          routes: {
            extraction: { connectionId: OLLAMA_ID, modelId: 'normalized-model' },
            interaction: { connectionId: OLLAMA_ID, modelId: 'normalized-model' },
          },
        }
        return putResponse
      }
      return configResponse(stored)
    })

    const first = render(<ProviderConfigPage onClose={() => {}} />)
    await screen.findByDisplayValue('saved-model')
    fireEvent.change(screen.getByLabelText('Single model ID'), { target: { value: 'manual-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled())
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
                issues: [{ path: 'config.routes.extraction.modelId', message: 'Must not be empty.' }],
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
    expect(alert).toHaveTextContent('config.routes.extraction.modelId: Must not be empty.')
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
    expect((putBodies[0].config as ModelConfig).routes.extraction?.modelId).toBe('manual-offline-model')
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

  it('saves mixed routes and exposes raw NuExtract only for Ollama extraction', async () => {
    const putBodies: Record<string, unknown>[] = []
    mockFetch((url, init) => {
      if (url === '/api/model_config' && init.method === 'PUT') {
        const body = requestBody(init)
        putBodies.push(body)
        return jsonResponse({ config: body.config, credentialStates: {} })
      }
      return configResponse(mixedConfig())
    })

    await renderPage()
    fireEvent.click(screen.getByRole('button', { name: 'Capability Routes' }))
    const extractionConnection = screen.getByLabelText('Extraction & Schema Suggestion connection')
    fireEvent.change(extractionConnection, { target: { value: OLLAMA_ID } })
    fireEvent.change(screen.getByLabelText('Extraction & Schema Suggestion model ID'), {
      target: { value: 'nuextract-manual' },
    })
    fireEvent.click(screen.getByLabelText('Use raw NuExtract protocol'))

    fireEvent.change(extractionConnection, { target: { value: OPENAI_ID } })
    expect(screen.queryByLabelText('Use raw NuExtract protocol')).not.toBeInTheDocument()
    fireEvent.change(extractionConnection, { target: { value: OLLAMA_ID } })
    fireEvent.click(screen.getByLabelText('Use raw NuExtract protocol'))

    fireEvent.change(screen.getByLabelText('Chat & Extraction Schema editing connection'), {
      target: { value: OPENAI_ID },
    })
    fireEvent.change(screen.getByLabelText('Chat & Extraction Schema editing model ID'), {
      target: { value: 'gpt-manual' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

    await waitFor(() => expect(putBodies).toHaveLength(1))
    const saved = putBodies[0].config as ModelConfig
    expect(saved.routes.extraction).toEqual({
      connectionId: OLLAMA_ID,
      modelId: 'nuextract-manual',
      nuextractRaw: true,
    })
    expect(saved.routes.interaction).toEqual({
      connectionId: OPENAI_ID,
      modelId: 'gpt-manual',
    })
  })

  it('renders corrupt saved configuration through the stable load error', async () => {
    mockFetch(() =>
      jsonResponse(
        { error: { code: 'invalid_model_config', message: 'Saved model configuration is invalid.' } },
        409,
      ),
    )

    render(<ProviderConfigPage onClose={() => {}} />)

    expect(await screen.findByText('Model configuration could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      'invalid_model_config: Saved model configuration is invalid.',
    )
  })
})
