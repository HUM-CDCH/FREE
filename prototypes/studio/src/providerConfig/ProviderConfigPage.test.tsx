// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef, type RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { METHOD_MESSAGES, REFERENCE_ARTICLE } from 'extraction/extraction-method'
import {
  DEPLOYMENT_CONNECTION_IDS,
  type DeploymentModels,
  type IngestionModelListing,
  type ModelConfig,
  type ModelConnection,
  type ProviderDescriptor,
} from '../../shared/modelConfig.contract'
import type { ExtractionModelListing } from '../../shared/extraction.contract'
import { ResearcherSessionContext } from '../auth/sessionContext'
import ProviderConfigPage from './ProviderConfigPage'

const OLLAMA_ID = '11111111-1111-4111-8111-111111111111'
const OPENAI_ID = '22222222-2222-4222-8222-222222222222'
const VLLM_ID = '33333333-3333-4333-8333-333333333333'
const OTHER_OPENAI_ID = '44444444-4444-4444-8444-444444444444'
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
const LAB_VLLM_BASE = 'http://lab.example:8000/v1'
const QWEN = 'Qwen/Qwen3.8-27B-FP8'
const NUEXTRACT = 'numind/NuExtract3-FP8'
const NUEXTRACT_NOTE = 'Schema Suggestion uses the NuExtract protocol for this model.'
const FOLLOWS = 'Schema Suggestion uses the assistant model.'

const providers: ProviderDescriptor[] = [
  { kind: 'ollama', label: 'Ollama', transport: 'http', defaultBaseUrl: OLLAMA_BASE, authentication: 'optional', supportsNuextract: false },
  { kind: 'openai', label: 'OpenAI', transport: 'http', defaultBaseUrl: OPENAI_BASE, authentication: 'managed', supportsNuextract: false },
  { kind: 'anthropic', label: 'Anthropic', transport: 'http', defaultBaseUrl: 'https://api.anthropic.com/v1', authentication: 'managed', supportsNuextract: false },
  { kind: 'google', label: 'Google', transport: 'http', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta', authentication: 'managed', supportsNuextract: false },
  { kind: 'codex-cli', label: 'Codex CLI', transport: 'cli', defaultBaseUrl: null, authentication: 'external', supportsNuextract: false },
  { kind: 'claude-code', label: 'Claude Code', transport: 'cli', defaultBaseUrl: null, authentication: 'external', supportsNuextract: false },
  { kind: 'openai-compatible', label: 'OpenAI-compatible', transport: 'http', defaultBaseUrl: null, authentication: 'optional', supportsNuextract: false },
  { kind: 'vllm', label: 'vLLM', transport: 'http', defaultBaseUrl: null, authentication: 'optional', supportsNuextract: true },
]

const instruct: ModelConnection = {
  id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment instruction model', provider: 'vllm', baseUrl: 'http://extraction_model:8000/v1', hasKey: false,
}
const nuextract: ModelConnection = {
  id: DEPLOYMENT_CONNECTION_IDS.nuextract, name: 'Deployment NuExtract', provider: 'vllm', baseUrl: 'http://nuextract_model:8000/v1', hasKey: false,
}
const codex: ModelConnection = {
  id: DEPLOYMENT_CONNECTION_IDS.codexCli, name: 'Codex CLI on this server', provider: 'codex-cli', baseUrl: null, hasKey: false,
}
const NO_DEPLOYMENT: DeploymentModels = { connections: [], defaultRoute: null }
const deployment: DeploymentModels = { connections: [instruct, nuextract], defaultRoute: { connectionId: instruct.id, modelId: QWEN } }

const ollama: ModelConnection = { id: OLLAMA_ID, name: 'Local Ollama', provider: 'ollama', baseUrl: OLLAMA_BASE, hasKey: false }
const openai: ModelConnection = { id: OPENAI_ID, name: 'Research OpenAI', provider: 'openai', baseUrl: OPENAI_BASE, hasKey: true }
const labVllm: ModelConnection = { id: VLLM_ID, name: 'Lab vLLM', provider: 'vllm', baseUrl: LAB_VLLM_BASE, hasKey: false }

const extractionListing: ExtractionModelListing = {
  defaults: { fields: 'nuextract', reasoning: 'instruct' },
  models: [
    { key: 'instruct', repo: QWEN, roles: ['fields', 'reasoning'], reachable: true, serving: true },
    { key: 'nuextract', repo: NUEXTRACT, roles: ['fields'], reachable: true, serving: true },
    { key: 'gemma', repo: 'google/gemma-3-27b-it', roles: ['reasoning'], reachable: false, serving: false },
  ],
}
const ingestionListing: IngestionModelListing = {
  defaults: { ocr: 'surya', layout: 'layout_heron_101' },
  models: {
    ocr: [
      { key: 'surya', label: 'datalab-to/surya-ocr-2', serving: true },
      { key: 'granite_vision', label: 'ibm-granite/granite-vision-4.1-4b', serving: false },
    ],
    layout: [
      { key: 'layout_heron_101', label: 'Heron-101', serving: true },
      { key: 'layout_egret_xlarge', label: 'Egret XLarge', serving: true },
    ],
  },
}

/** What each connection's probe lists. */
const CATALOGS: Readonly<Record<string, readonly string[]>> = {
  [instruct.id]: [QWEN],
  [nuextract.id]: [NUEXTRACT],
  [OLLAMA_ID]: ['llama3.3', 'qwen3:8b'],
}

function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return {
    connections: [],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {},
    ingestionModels: {},
    extractionSettings: {},
    ...overrides,
  }
}

function storeKey(id: string, provider: string, baseUrl: string, key: string): void {
  const stored = JSON.parse(localStorage.getItem(STORAGE) ?? '{}') as Record<string, unknown>
  localStorage.setItem(STORAGE, JSON.stringify({ ...stored, [id]: { provider, baseUrl, key } }))
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const unavailable = (code: string) => () => jsonResponse({ error: { code, message: 'Unavailable.' } }, 503)

function requestBody(init: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init.body)) as Record<string, unknown>
}

type ProbeBody = { connection: ModelConnection; credential?: string }
type StudioOptions = {
  deployment?: DeploymentModels
  probe?: (body: ProbeBody) => Response | Promise<Response>
  extraction?: () => Response
  ingestion?: () => Response
  put?: (config: ModelConfig) => Response | Promise<Response> | undefined
}

function probeResponse(status: 'connected' | 'unreachable', message: string): Response {
  return jsonResponse({ checkedAt: '2026-09-26T00:00:00.000Z', status, message, catalog: [] })
}

function connected({ connection }: ProbeBody): Response {
  return jsonResponse({
    checkedAt: '2026-09-26T00:00:00.000Z',
    status: 'connected',
    message: 'Connected.',
    catalog: (CATALOGS[connection.id] ?? []).map((id) => ({ id, label: id })),
  })
}

/** Studio's five endpoints the page calls: it saves what it is sent, and records every request. */
function studio(initial: ModelConfig, options: StudioOptions = {}) {
  let stored = initial
  const request = vi.fn((input: string | URL | Request, init: RequestInit = {}) => {
    expect(init.credentials).toBe('same-origin')
    const url = String(input)
    const method = init.method ?? 'GET'
    if (url === '/api/model_config' && method === 'PUT') {
      const submitted = requestBody(init).config as ModelConfig
      const refused = options.put?.(submitted)
      if (refused) return Promise.resolve(refused)
      stored = submitted
      return Promise.resolve(jsonResponse({ config: stored }))
    }
    if (url === '/api/model_config') return Promise.resolve(jsonResponse({ config: stored, providers, deployment: options.deployment ?? NO_DEPLOYMENT }))
    if (url === '/api/model_probe') return Promise.resolve((options.probe ?? connected)(requestBody(init) as ProbeBody))
    if (url === '/api/model-keys') return Promise.resolve(jsonResponse({ accepted: [] }))
    if (url === '/api/extraction-models') return Promise.resolve((options.extraction ?? (() => jsonResponse(extractionListing)))())
    if (url === '/api/ingestion-models') return Promise.resolve((options.ingestion ?? (() => jsonResponse(ingestionListing)))())
    throw new Error(`Unexpected request: ${method} ${url}`)
  })
  vi.stubGlobal('fetch', request)
  const bodies = (url: string, method: string) =>
    request.mock.calls
      .filter(([input, init]) => String(input) === url && (init?.method ?? 'GET') === method)
      .map(([, init]) => requestBody(init!))
  return {
    request,
    bodies,
    probes: () => bodies('/api/model_probe', 'POST') as ProbeBody[],
    puts: () => bodies('/api/model_config', 'PUT').map(({ config }) => config as ModelConfig),
    stored: () => stored,
  }
}

async function renderPage(initialFocusRef?: RefObject<HTMLButtonElement | null>) {
  const view = render(
    <ResearcherSessionContext value={SESSION}>
      <ProviderConfigPage onClose={() => {}} initialFocusRef={initialFocusRef} />
    </ResearcherSessionContext>,
  )
  await waitFor(() => expect(screen.queryByText('Loading model configuration…')).not.toBeInTheDocument())
  return view
}

/** Waits past an edit's 500 ms probe debounce with room for a loaded test run. */
const DEBOUNCED = { timeout: 3_000 }
function selectView(label: string, title: string) {
  const selector = screen.getByRole('combobox', { name: label })
  const option = within(selector).getByRole('option', { name: title }) as HTMLOptionElement
  fireEvent.change(selector, { target: { value: option.value } })
}
const step = (title: string) => screen.getByRole('region', { name: title })
const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply' }))

/** Opens a picker and returns one of its connection groups once the probe has listed its models. */
async function pickerGroup(picker: string, group: string) {
  fireEvent.click(screen.getByRole('button', { name: picker }))
  return within(within(screen.getByRole('listbox', { name: picker })).getByRole('group', { name: group }))
}

async function choose(picker: string, group: string, model: string) {
  const options = await pickerGroup(picker, group)
  fireEvent.click(await options.findByRole('option', { name: model }))
}

async function typeModel(picker: string, group: string, model: string) {
  fireEvent.click(screen.getByRole('button', { name: picker }))
  fireEvent.change(screen.getByRole('combobox', { name: `Search ${picker}` }), { target: { value: model } })
  const list = within(screen.getByRole('listbox', { name: picker }))
  fireEvent.click(within(list.getByRole('group', { name: group })).getByRole('option', { name: `Use ${model}` }))
}

function openConnections(): void {
  fireEvent.click(screen.getByRole('tab', { name: /^Connections/ }))
}

/** Selects a connection on the Connections tab and returns its detail pane. */
function openConnection(name: string | RegExp) {
  openConnections()
  fireEvent.click(within(screen.getByRole('list', { name: 'Connections' })).getByRole('button', { name }))
  return within(screen.getByRole('region', { name: 'Connection details' }))
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('ProviderConfigPage', () => {
  it('opens on Models with each step as one sentence at its defaults', async () => {
    studio(config(), { deployment })
    await renderPage()

    expect(screen.getByText('Model Configuration')).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Models' })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tab', { name: 'Connections · 2' })).toHaveAttribute('aria-selected', 'false')

    await waitFor(() => expect(step('Reading documents')).toHaveTextContent(
      'Scanned pages are read by datalab-to/surya-ocr-2, page regions found by Heron-101.',
    ))
    expect(step('Reading documents')).toHaveTextContent(
      'Choose among the models this deployment runs. Applies to new uploads and reprocessing.',
    )
    expect(step('Schema & chat')).toHaveTextContent(
      `Chat, schema editing and Schema Suggestion use ${QWEN}, the deployment's model.`,
    )
    expect(step('Schema & chat')).toHaveTextContent('Choose any model from your connections.')
    await waitFor(() => expect(step('Extracting data')).toHaveTextContent(
      `${NUEXTRACT} reads field values, ${QWEN} reasons over the source.`,
    ))
    expect(step('Extracting data')).toHaveTextContent('Choose among the models this deployment runs.')
    for (const title of ['Reading documents', 'Schema & chat', 'Extracting data']) {
      expect(step(title)).toBeVisible()
      expect(within(step(title)).getByRole('button', { name: 'Change' })).toBeInTheDocument()
      expect(within(step(title)).queryByRole('button', { name: 'Use defaults' })).not.toBeInTheDocument()
    }
    for (const picker of ['Text recognition', 'Page regions', 'Assistant model', 'Field values', 'Reasoning'])
      expect(screen.queryByRole('button', { name: picker })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Configuration mode' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
  })

  it('probes every eligible connection once on open with exactly the credential the rules allow', async () => {
    const otherOpenai = { ...openai, id: OTHER_OPENAI_ID, name: 'Gateway OpenAI' }
    const keyedVllm = { ...labVllm, hasKey: true }
    storeKey(OPENAI_ID, 'openai', OPENAI_BASE, 'sk-test-this-base')
    storeKey(OTHER_OPENAI_ID, 'openai', 'https://old-gateway.example/v1', 'sk-test-other-base')
    const server = studio(config({ connections: [ollama, openai, otherOpenai, keyedVllm] }), {
      deployment: { connections: [instruct], defaultRoute: { connectionId: instruct.id, modelId: QWEN } },
    })

    await renderPage()
    await waitFor(() => expect(server.probes()).toHaveLength(3))
    vi.useFakeTimers()
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    const probes = server.probes()
    expect(probes).toHaveLength(3)
    const byId = new Map(probes.map((body) => [body.connection.id, body]))
    expect([...byId.keys()].sort()).toEqual([instruct.id, OLLAMA_ID, OPENAI_ID].sort())
    expect(byId.get(instruct.id)).toEqual({ connection: instruct })
    expect(byId.get(OLLAMA_ID)).toEqual({ connection: ollama })
    expect(byId.get(OPENAI_ID)).toEqual({ connection: openai, credential: 'sk-test-this-base' })
    expect(JSON.stringify(server.request.mock.calls)).not.toContain('sk-test-other-base')
  })

  it('Change opens a step and Use defaults removes its stored choice', async () => {
    const server = studio(
      config({
        connections: [ollama],
        routes: { schemaSuggestion: { connectionId: nuextract.id, modelId: NUEXTRACT }, interaction: { connectionId: OLLAMA_ID, modelId: 'llama3.3' } },
        extractionModels: { fields: 'instruct', reasoning: 'instruct' },
        ingestionModels: { ocr: 'surya', layout: 'layout_egret_xlarge' },
      }),
      { deployment },
    )
    await renderPage()

    // All steps stay visible; editing another step preserves each stored choice.
    expect(within(step('Reading documents')).getByRole('button', { name: 'Text recognition' })).toHaveTextContent('datalab-to/surya-ocr-2')
    expect(within(step('Reading documents')).getByRole('button', { name: 'Page regions' })).toHaveTextContent('Egret XLarge')
    fireEvent.click(within(step('Schema & chat')).getByRole('button', { name: 'Change' }))
    expect(within(step('Schema & chat')).getByRole('button', { name: 'Assistant model' })).toHaveTextContent('llama3.3 · Local Ollama')
    expect(step('Reading documents')).toHaveTextContent('Egret XLarge')
    expect(within(step('Reading documents')).queryByRole('button', { name: 'Text recognition' })).not.toBeInTheDocument()
    fireEvent.click(within(step('Extracting data')).getByRole('button', { name: 'Change' }))
    expect(within(step('Extracting data')).getByRole('button', { name: 'Field values' })).toHaveTextContent(QWEN)

    for (const title of ['Reading documents', 'Schema & chat', 'Extracting data']) {
      const change = within(step(title)).queryByRole('button', { name: 'Change' })
      if (change) fireEvent.click(change)
      fireEvent.click(within(step(title)).getByRole('button', { name: 'Use defaults' }))
      expect(within(step(title)).getByRole('button', { name: 'Change' })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: 'Assistant model' })).not.toBeInTheDocument()

    // Change opens a step at its defaults on its pickers, which show the deployment's defaults.
    fireEvent.click(within(step('Extracting data')).getByRole('button', { name: 'Change' }))
    expect(within(step('Extracting data')).getByRole('button', { name: 'Field values' })).toHaveTextContent(`Deployment default · ${NUEXTRACT}`)
    expect(within(step('Extracting data')).getByRole('button', { name: 'Reasoning' })).toHaveTextContent(`Deployment default · ${QWEN}`)
    expect(within(step('Extracting data')).getByRole('button', { name: 'Use defaults' })).toBeInTheDocument()

    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    const [saved] = server.puts()
    expect(saved.routes).toEqual({ schemaSuggestion: null, interaction: null })
    expect(saved.extractionModels).toEqual({})
    expect(saved.ingestionModels).toEqual({})
  })

  it('an unset Schema Suggestion route follows the Assistant model, and Use a different model stores an explicit route even when it equals it', async () => {
    const assistant = { connectionId: OLLAMA_ID, modelId: 'llama3.3' }
    const server = studio(config({ connections: [ollama], routes: { schemaSuggestion: null, interaction: assistant } }))
    const first = await renderPage()

    const schemaAndChat = within(step('Schema & chat'))
    expect(schemaAndChat.getByText(FOLLOWS)).toBeInTheDocument()
    expect(schemaAndChat.queryByRole('button', { name: 'Schema Suggestion model' })).not.toBeInTheDocument()
    expect(schemaAndChat.queryByText(/Deployment default/)).not.toBeInTheDocument()

    fireEvent.click(schemaAndChat.getByRole('button', { name: 'Use a different model' }))
    // Focus moves to the picker it revealed, not to the page.
    expect(schemaAndChat.getByRole('button', { name: 'Schema Suggestion model' })).toHaveFocus()
    fireEvent.click(schemaAndChat.getByRole('button', { name: 'Schema Suggestion model' }))
    expect(screen.getByRole('option', { name: 'Use the assistant model' })).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Schema Suggestion model' }))
    await choose('Schema Suggestion model', 'Local Ollama', 'llama3.3')
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0].routes).toEqual({ schemaSuggestion: assistant, interaction: assistant })

    // Reopened, the saved route is still its own, though it equals the Assistant model.
    first.unmount()
    await renderPage()
    const reopened = within(step('Schema & chat'))
    expect(reopened.getByRole('button', { name: 'Schema Suggestion model' })).toHaveTextContent('llama3.3 · Local Ollama')
    expect(reopened.queryByText(FOLLOWS)).not.toBeInTheDocument()

    fireEvent.click(reopened.getByRole('button', { name: 'Use the assistant model' }))
    expect(reopened.getByText(FOLLOWS)).toBeInTheDocument()
    expect(reopened.getByRole('button', { name: 'Use a different model' })).toHaveFocus()
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(2))
    expect(server.puts()[1].routes).toEqual({ schemaSuggestion: null, interaction: assistant })
  })

  it('the NuExtract protocol is shown as automatic for a NuExtract model on vLLM and never offered as a control', async () => {
    const server = studio(config({
      connections: [labVllm, ollama],
      routes: { schemaSuggestion: null, interaction: { connectionId: VLLM_ID, modelId: NUEXTRACT } },
    }))
    await renderPage()
    const schemaAndChat = within(step('Schema & chat'))

    // Inherited from the Assistant model.
    expect(schemaAndChat.getByText(NUEXTRACT_NOTE)).toBeInTheDocument()

    fireEvent.click(schemaAndChat.getByRole('button', { name: 'Use a different model' }))
    await typeModel('Schema Suggestion model', 'Lab vLLM', QWEN)
    expect(schemaAndChat.queryByText(NUEXTRACT_NOTE)).not.toBeInTheDocument()

    // Not on a connection that cannot pass NuExtract's chat-template controls.
    await typeModel('Schema Suggestion model', 'Local Ollama', NUEXTRACT)
    expect(schemaAndChat.queryByText(NUEXTRACT_NOTE)).not.toBeInTheDocument()

    await typeModel('Schema Suggestion model', 'Lab vLLM', NUEXTRACT)
    expect(schemaAndChat.getByText(NUEXTRACT_NOTE)).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('switch')).not.toBeInTheDocument()

    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0].routes).toEqual({
      schemaSuggestion: { connectionId: VLLM_ID, modelId: NUEXTRACT },
      interaction: { connectionId: VLLM_ID, modelId: NUEXTRACT },
    })
  })

  it('the ingestion step cannot choose an OCR model the OCR server does not serve, and keeps a saved choice the listing no longer offers', async () => {
    const server = studio(config({ ingestionModels: { layout: 'layout_retired' } }))
    await renderPage()
    const reading = within(step('Reading documents'))

    await waitFor(() => expect(reading.getByRole('button', { name: 'Page regions' })).toHaveTextContent(
      'layout_retired (not offered by this deployment)',
    ))
    fireEvent.click(reading.getByRole('button', { name: 'Text recognition' }))
    const unloaded = screen.getByRole('option', { name: /granite-vision/ })
    expect(unloaded).toHaveAttribute('aria-disabled', 'true')
    expect(unloaded).toHaveTextContent('Not loaded on the OCR server')
    fireEvent.click(unloaded)
    expect(screen.getByRole('listbox', { name: 'Text recognition' })).toBeInTheDocument()
    expect(reading.getByRole('button', { name: 'Text recognition' })).toHaveTextContent('Deployment default · datalab-to/surya-ocr-2')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()

    fireEvent.click(screen.getByRole('option', { name: 'datalab-to/surya-ocr-2' }))
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0].ingestionModels).toEqual({ ocr: 'surya', layout: 'layout_retired' })
  })

  it('a failed ingestion or extraction listing blocks no other edit', async () => {
    const server = studio(config({ connections: [ollama], extractionModels: { fields: 'instruct' } }), {
      extraction: unavailable('extraction_models_unavailable'),
      ingestion: unavailable('ingestion_models_unavailable'),
    })
    await renderPage()

    expect(step('Reading documents')).toHaveTextContent(
      "Scanned pages are read and their page regions found by the deployment's default models.",
    )
    expect(step('Schema & chat')).toHaveTextContent('No model is configured yet.')
    // A saved choice stays saved and shown, though nothing lists it.
    expect(within(step('Extracting data')).getByRole('button', { name: 'Field values' })).toHaveTextContent('instruct')
    expect(within(step('Extracting data')).getByRole('button', { name: 'Reasoning' })).toHaveTextContent('Deployment default')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    fireEvent.click(within(step('Schema & chat')).getByRole('button', { name: 'Change' }))
    await choose('Assistant model', 'Local Ollama', 'llama3.3')
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0]).toMatchObject({
      routes: { schemaSuggestion: null, interaction: { connectionId: OLLAMA_ID, modelId: 'llama3.3' } },
      extractionModels: { fields: 'instruct' },
      ingestionModels: {},
      extractionSettings: {},
    })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled())
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("deployment connections are read-only, CLI kinds are not offered, and a saved connection's provider cannot change", async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(VLLM_ID)
    const server = studio(config({ connections: [openai] }), {
      deployment: { connections: [instruct, codex], defaultRoute: { connectionId: instruct.id, modelId: QWEN } },
    })
    await renderPage()
    openConnections()
    expect(screen.getByRole('tab', { name: 'Connections · 3' })).toHaveAttribute('aria-selected', 'true')
    const list = within(screen.getByRole('list', { name: 'Connections' }))
    expect(list.getAllByRole('button').map((item) => item.textContent)).toEqual([
      'Deployment instruction modelDeployment',
      'Codex CLI on this serverDeployment',
      'Research OpenAI',
    ])

    const deployed = openConnection(/Deployment instruction model/)
    expect(deployed.getByRole('heading', { name: 'Deployment instruction model' })).toBeInTheDocument()
    expect(deployed.getByText(instruct.baseUrl!)).toBeInTheDocument()
    expect(await deployed.findByText('Connected.')).toBeInTheDocument()
    // The list's status dot has words too, not only a colour.
    expect(list.getByRole('button', { name: /Deployment instruction model/ })).toHaveAccessibleDescription('Connected.')
    expect(within(deployed.getByRole('list', { name: 'Models' })).getByText(QWEN)).toBeInTheDocument()
    expect(deployed.queryByRole('textbox')).not.toBeInTheDocument()
    expect(deployed.queryByRole('button')).not.toBeInTheDocument()

    const cli = openConnection(/Codex CLI on this server/)
    expect(cli.getByText("Runs on this server's CLI login")).toBeInTheDocument()
    expect(cli.queryByRole('textbox')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    const kinds = screen.getAllByRole('menuitem').map((item) => item.textContent)
    expect(kinds).toEqual([
      'OllamaYour own server',
      'OpenAIHosted API · needs a key',
      'AnthropicHosted API · needs a key',
      'GoogleHosted API · needs a key',
      'OpenAI-compatibleYour own server',
      'vLLMYour own server',
    ])
    // A press keeps focus in the menu, so browsers that do not focus a clicked button do not close it first.
    expect(fireEvent.mouseDown(screen.getByRole('menuitem', { name: /^vLLM/ }))).toBe(false)
    fireEvent.click(screen.getByRole('menuitem', { name: /^vLLM/ }))
    const added = within(screen.getByRole('region', { name: 'Connection details' }))
    expect(added.getByRole('heading', { name: 'vLLM connection' })).toHaveFocus()

    const saved = openConnection('Research OpenAI')
    expect(saved.getByRole('heading', { name: 'OpenAI connection' })).toBeInTheDocument()
    expect(saved.getByRole('textbox', { name: 'Name' })).toHaveValue('Research OpenAI')
    expect(saved.getByRole('textbox', { name: 'Base URL' })).toHaveValue(OPENAI_BASE)
    expect(saved.queryByRole('combobox')).not.toBeInTheDocument()

    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0].connections.map(({ id, provider }) => [id, provider])).toEqual([[OPENAI_ID, 'openai'], [VLLM_ID, 'vllm']])
  })

  it('the key line offers Replace and Remove for a key saved in this browser, or an input', async () => {
    storeKey(OPENAI_ID, 'openai', OPENAI_BASE, 'sk-test-saved')
    studio(config({ connections: [openai, ollama, { ...labVllm, hasKey: true }] }))
    await renderPage()

    const saved = openConnection('Research OpenAI')
    expect(saved.getByText('Key saved in this browser')).toBeInTheDocument()
    expect(saved.queryByLabelText('API key')).not.toBeInTheDocument()
    fireEvent.click(saved.getByRole('button', { name: 'Replace' }))
    const input = saved.getByLabelText('API key')
    expect(input).toHaveFocus()
    // Masked, but not a password field: a password manager would keep another copy of the key.
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('spellcheck', 'false')
    expect(input.className).toContain('[-webkit-text-security:disc]')
    fireEvent.click(saved.getByRole('button', { name: 'Keep saved key' }))
    expect(saved.getByText('Key saved in this browser')).toBeInTheDocument()
    expect(saved.getByRole('button', { name: 'Replace' })).toHaveFocus()
    fireEvent.click(saved.getByRole('button', { name: 'Remove' }))
    expect(saved.getByLabelText('API key')).toHaveFocus()

    const keyless = openConnection('Local Ollama')
    expect(keyless.getByLabelText('API key (optional)')).toHaveAttribute('placeholder', 'Used without a key')
    expect(keyless.queryByRole('button', { name: 'Use without a key' })).not.toBeInTheDocument()

    const missing = openConnection('Lab vLLM')
    expect(missing.getByLabelText('API key (optional)')).toHaveAttribute('placeholder', 'Paste a key')
    expect(missing.getByRole('button', { name: 'Use without a key' })).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('sk-test-saved')
  })

  it('a draft base change clears the typed key and never probes the new base with the old key', async () => {
    storeKey(OPENAI_ID, 'openai', OPENAI_BASE, 'sk-test-stored-old-base')
    const server = studio(config({ connections: [ollama, openai] }))
    await renderPage()
    await waitFor(() => expect(server.probes()).toHaveLength(2))
    const opening = server.request.mock.calls.length

    vi.useFakeTimers()
    const pane = openConnection('Research OpenAI')
    fireEvent.click(pane.getByRole('button', { name: 'Replace' }))
    fireEvent.change(pane.getByLabelText('API key'), { target: { value: 'sk-test-typed-old-base' } })
    await act(() => vi.advanceTimersByTimeAsync(200))
    fireEvent.change(pane.getByRole('textbox', { name: 'Base URL' }), { target: { value: 'https://gateway.example/v1' } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(pane.getByLabelText('API key')).toHaveValue('')
    expect(server.request.mock.calls.slice(opening)).toEqual([])
    expect(JSON.stringify(server.request.mock.calls)).not.toContain('sk-test-typed-old-base')
    expect(pane.getByText('Not checked yet.')).toBeInTheDocument()

    // Discard restores the saved base, which is probed again with the key saved for it.
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(server.probes().slice(2)).toEqual([{ connection: openai, credential: 'sk-test-stored-old-base' }])
    expect(pane.getByText('Connected.')).toBeInTheDocument()
  })

  it("Apply sends the configuration without keys, then this browser's keys; Discard restores the saved draft", async () => {
    const server = studio(config({ connections: [ollama, openai] }))
    await renderPage()

    const pane = openConnection('Research OpenAI')
    fireEvent.change(pane.getByLabelText('API key'), { target: { value: 'sk-test-typed' } })
    // The typed key is what the connection is probed with.
    await waitFor(() => expect(server.probes().filter(({ connection }) => connection.id === OPENAI_ID)).toHaveLength(1), DEBOUNCED)
    expect(server.probes().find(({ connection }) => connection.id === OPENAI_ID)).toMatchObject({ credential: 'sk-test-typed' })
    apply()

    await waitFor(() => expect(server.bodies('/api/model-keys', 'PUT')).toHaveLength(1))
    const [put] = server.request.mock.calls.filter(([url, init]) => String(url) === '/api/model_config' && init?.method === 'PUT')
    const text = String(put[1]!.body)
    expect(Object.keys(JSON.parse(text))).toEqual(['config'])
    expect(text).not.toMatch(/sk-test|credential/)
    const entry = { provider: 'openai', baseUrl: OPENAI_BASE, key: 'sk-test-typed' }
    expect(JSON.parse(localStorage.getItem(STORAGE)!)).toEqual({ [OPENAI_ID]: entry })
    expect(server.bodies('/api/model-keys', 'PUT')[0]).toEqual({ account: ACCOUNT, keys: { [OPENAI_ID]: entry } })
    const order = server.request.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)
    expect(order.indexOf('PUT /api/model_config')).toBeLessThan(order.indexOf('PUT /api/model-keys'))
    expect(pane.getByText('Key saved in this browser')).toBeInTheDocument()
    expect(document.body).not.toHaveTextContent('sk-test-typed')

    const renamed = openConnection('Local Ollama')
    const probed = server.probes().length
    vi.useFakeTimers()
    fireEvent.change(renamed.getByRole('textbox', { name: 'Name' }), { target: { value: 'Renamed Ollama' } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(renamed.getByRole('textbox', { name: 'Name' })).toHaveValue('Local Ollama')
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    // Neither the rename nor its Discard changes what a probe would do, so neither probes.
    expect(server.probes()).toHaveLength(probed)
    expect(renamed.getByText('Connected.')).toBeInTheDocument()
    expect(server.puts()).toHaveLength(1)
  })

  it('the close button keeps its name and initial focus', async () => {
    studio(config())
    const initialFocus = createRef<HTMLButtonElement>()
    await renderPage(initialFocus)

    const close = screen.getByRole('button', { name: 'Close Model Configuration' })
    expect(initialFocus.current).toBe(close)
    expect(close).toHaveFocus()
  })

  it("Remove drops this browser's key on Apply and tells Studio; an optional connection then uses no key", async () => {
    storeKey(OLLAMA_ID, 'ollama', OLLAMA_BASE, 'sk-test-removed')
    const server = studio(config({ connections: [{ ...ollama, hasKey: true }] }))
    await renderPage()

    const pane = openConnection('Local Ollama')
    fireEvent.click(pane.getByRole('button', { name: 'Remove' }))
    expect(pane.getByLabelText('API key (optional)')).toHaveAttribute('placeholder', 'Used without a key')
    apply()

    await waitFor(() => expect(server.bodies('/api/model-keys', 'PUT')).toHaveLength(1))
    expect(server.puts()[0].connections[0].hasKey).toBe(false)
    expect(localStorage.getItem(STORAGE)).toBeNull()
    expect(server.bodies('/api/model-keys', 'PUT')[0]).toEqual({ account: ACCOUNT, keys: { [OLLAMA_ID]: null } })
    expect(pane.queryByText('Key saved in this browser')).not.toBeInTheDocument()
    expect(pane.queryByRole('button', { name: 'Use without a key' })).not.toBeInTheDocument()
  })

  it('a managed connection keeps hasKey when its key is removed', async () => {
    storeKey(OPENAI_ID, 'openai', OPENAI_BASE, 'sk-test-managed')
    const server = studio(config({ connections: [ollama, openai] }))
    await renderPage()

    const pane = openConnection('Research OpenAI')
    fireEvent.click(pane.getByRole('button', { name: 'Remove' }))
    expect(pane.getByLabelText('API key')).toHaveValue('')
    expect(pane.queryByRole('button', { name: 'Use without a key' })).not.toBeInTheDocument()
    apply()

    await waitFor(() => expect(server.bodies('/api/model-keys', 'PUT')).toHaveLength(1))
    expect(server.puts()[0].connections.find(({ id }) => id === OPENAI_ID)?.hasKey).toBe(true)
    expect(localStorage.getItem(STORAGE)).toBeNull()
    expect(server.bodies('/api/model-keys', 'PUT')[0]).toEqual({ account: ACCOUNT, keys: { [OPENAI_ID]: null } })
  })

  it('a key longer than Studio accepts shows an error, is never probed and cannot be applied', async () => {
    const server = studio(config({ connections: [openai] }))
    await renderPage()
    vi.useFakeTimers()

    const pane = openConnection('Research OpenAI')
    const input = pane.getByLabelText('API key')
    fireEvent.change(input, { target: { value: `sk-test-${'x'.repeat(8192)}` } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    expect(pane.getByText('A key can be at most 8192 characters.')).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(server.probes()).toEqual([])
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'sk-test-short' } })
    expect(pane.queryByText('A key can be at most 8192 characters.')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it.each([
    ['a character outside printable ASCII', 'sk-test-cl\u00e9'],
    ['a trailing space', 'sk-test-pasted '],
    ['a tab', 'sk-test-a\tb'],
  ])('a key with %s shows an error, is never probed and cannot be applied', async (_label, key) => {
    const server = studio(config({ connections: [openai] }))
    await renderPage()
    vi.useFakeTimers()

    const pane = openConnection('Research OpenAI')
    const input = pane.getByLabelText('API key')
    fireEvent.change(input, { target: { value: key } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))

    const message = 'A key can contain only printable ASCII characters, with no spaces at either end.'
    expect(pane.getByText(message)).toBeInTheDocument()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(server.probes()).toEqual([])
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()

    fireEvent.change(input, { target: { value: 'sk-test-short' } })
    expect(pane.queryByText(message)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('renders an unloadable configuration through the stable error', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => Promise.resolve(
      String(input) === '/api/model_config'
        ? jsonResponse({ error: { code: 'invalid_model_config', message: 'Saved model configuration is invalid.' } }, 500)
        : jsonResponse({ error: { code: 'unavailable', message: 'Unavailable.' } }, 503),
    )))
    await renderPage()

    expect(screen.getByText('Model configuration could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('invalid_model_config: Saved model configuration is invalid.')
  })

  it('a rejected Apply keeps the draft and shows the stable error', async () => {
    let refuse = true
    const server = studio(config({ connections: [ollama] }), {
      put: () => (refuse ? jsonResponse({ error: { code: 'persistence_unavailable', message: 'Model Configuration storage is unavailable.' } }, 503) : undefined),
    })
    await renderPage()
    fireEvent.click(within(step('Schema & chat')).getByRole('button', { name: 'Change' }))
    await typeModel('Assistant model', 'Local Ollama', 'offline-model')
    apply()

    expect(await screen.findByRole('alert')).toHaveTextContent('persistence_unavailable: Model Configuration storage is unavailable.')
    expect(screen.getByRole('button', { name: 'Assistant model' })).toHaveTextContent('offline-model · Local Ollama')
    refuse = false
    apply()
    await waitFor(() => expect(server.stored().routes.interaction).toEqual({ connectionId: OLLAMA_ID, modelId: 'offline-model' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('a rename alone is not probed again; blanking or restoring the name is', async () => {
    storeKey(OPENAI_ID, 'openai', OPENAI_BASE, 'sk-test-rename')
    const server = studio(config({ connections: [openai] }))
    await renderPage()
    await waitFor(() => expect(server.probes()).toHaveLength(1))
    vi.useFakeTimers()
    const pane = openConnection('Research OpenAI')
    const name = pane.getByRole('textbox', { name: 'Name' })

    fireEvent.change(name, { target: { value: 'Renamed OpenAI' } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    // The key is not sent again, and the connection's status and models stay as they were.
    expect(server.probes()).toHaveLength(1)
    expect(pane.getByText('Connected.')).toBeInTheDocument()

    // A blank name cannot be probed; a name again can.
    fireEvent.change(name, { target: { value: ' ' } })
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(server.probes()).toHaveLength(1)
    expect(pane.getByText('Not checked yet.')).toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'Research OpenAI' } })
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(server.probes()).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(server.probes()).toEqual([
      { connection: openai, credential: 'sk-test-rename' },
      { connection: openai, credential: 'sk-test-rename' },
    ])
  })

  it('an edit supersedes a scheduled or running probe, and a stale result never shows', async () => {
    const answers: ((response: Response) => void)[] = []
    const server = studio(config({ connections: [ollama] }), {
      probe: () => new Promise<Response>((resolve) => answers.push(resolve)),
    })
    const signals = () =>
      server.request.mock.calls.filter(([url]) => String(url) === '/api/model_probe').map(([, init]) => init?.signal)
    await renderPage()
    await waitFor(() => expect(answers).toHaveLength(1))
    vi.useFakeTimers()
    const pane = openConnection('Local Ollama')
    expect(pane.getByText('Checking…')).toBeInTheDocument()
    const base = pane.getByRole('textbox', { name: 'Base URL' })

    // The running opening probe is aborted; the edit's probe waits out the debounce.
    fireEvent.change(base, { target: { value: 'http://127.0.0.1:11435' } })
    expect(signals()[0]?.aborted).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(499))
    // A second edit inside the debounce replaces the scheduled probe.
    fireEvent.change(base, { target: { value: 'http://127.0.0.1:11436' } })
    await act(() => vi.advanceTimersByTimeAsync(499))
    expect(answers).toHaveLength(1)
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(answers).toHaveLength(2)
    expect(server.probes()[1].connection.baseUrl).toBe('http://127.0.0.1:11436')

    fireEvent.change(base, { target: { value: 'http://127.0.0.1:11437' } })
    expect(signals()[1]?.aborted).toBe(true)
    await act(() => vi.advanceTimersByTimeAsync(500))
    expect(answers).toHaveLength(3)

    await act(async () => answers[2](probeResponse('connected', 'Latest connection is ready.')))
    expect(pane.getByText('Latest connection is ready.')).toBeInTheDocument()
    await act(async () => {
      answers[1](probeResponse('unreachable', 'Stale provider failure.'))
      answers[0](probeResponse('unreachable', 'Stale opening failure.'))
    })
    expect(screen.queryByText(/Stale/)).not.toBeInTheDocument()
    expect(pane.getByText('Latest connection is ready.')).toBeInTheDocument()
  })

  it('removing a connection disposes its pending and late probe state', async () => {
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(OLLAMA_ID)
    const answers: ((response: Response) => void)[] = []
    const server = studio(config({ connections: [ollama, openai] }), {
      probe: () => new Promise<Response>((resolve) => answers.push(resolve)),
    })
    await renderPage()
    await waitFor(() => expect(answers).toHaveLength(1))
    vi.useFakeTimers()
    const list = () => within(screen.getByRole('list', { name: 'Connections' }))

    // Running when the connection is deleted: aborted, and its late answer is dropped.
    const pane = openConnection('Local Ollama')
    fireEvent.click(pane.getByRole('button', { name: 'Delete connection' }))
    expect(server.request.mock.calls.find(([url]) => String(url) === '/api/model_probe')?.[1]?.signal?.aborted).toBe(true)
    // Focus goes to the connection now selected, not to the page.
    expect(list().getByRole('button', { name: 'Research OpenAI' })).toHaveFocus()
    await act(async () => answers[0](probeResponse('unreachable', 'Late failure of the deleted connection.')))

    // Added again under the same ID, it starts clean.
    fireEvent.click(screen.getByRole('button', { name: 'Add connection' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Ollama/ }))
    const readded = within(screen.getByRole('region', { name: 'Connection details' }))
    expect(readded.getByRole('heading', { name: 'Ollama connection' })).toHaveFocus()
    expect(readded.getByText('Not checked yet.')).toBeInTheDocument()
    expect(screen.queryByText(/Late failure/)).not.toBeInTheDocument()

    // Scheduled when deleted: it never runs.
    fireEvent.click(readded.getByRole('button', { name: 'Delete connection' }))
    await act(() => vi.advanceTimersByTimeAsync(2_000))
    expect(answers).toHaveLength(1)
    expect(list().queryByRole('button', { name: /Ollama/ })).not.toBeInTheDocument()
  })

  it('a probe failure does not gate Apply', async () => {
    const server = studio(config({ connections: [ollama] }), {
      probe: () => probeResponse('unreachable', 'Ollama is not reachable.'),
    })
    await renderPage()
    openConnections()
    await waitFor(() =>
      expect(within(screen.getByRole('list', { name: 'Connections' })).getByRole('button', { name: 'Local Ollama' }))
        .toHaveAccessibleDescription('Ollama is not reachable.'))
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))

    fireEvent.click(within(step('Schema & chat')).getByRole('button', { name: 'Change' }))
    const group = await pickerGroup('Assistant model', 'Local Ollama')
    expect(group.getByText('Ollama is not reachable.')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search Assistant model' }), { key: 'Escape' })
    await typeModel('Assistant model', 'Local Ollama', 'offline-model')
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0].routes.interaction).toEqual({ connectionId: OLLAMA_ID, modelId: 'offline-model' })
  })

  it('Apply is disabled while it applies', async () => {
    let release: (() => void) | undefined
    const server = studio(config({ connections: [ollama] }), {
      put: (submitted) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(jsonResponse({ config: submitted }))
        }),
    })
    await renderPage()
    fireEvent.click(within(step('Schema & chat')).getByRole('button', { name: 'Change' }))
    await choose('Assistant model', 'Local Ollama', 'llama3.3')
    apply()

    await waitFor(() => expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled())
    expect(screen.getByRole('button', { name: 'Assistant model' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Applying…' }))
    expect(server.puts()).toHaveLength(1)

    await act(async () => release?.())
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Assistant model' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Assistant model' })).toHaveTextContent('llama3.3 · Local Ollama')
    expect(server.puts()).toHaveLength(1)
  })
})

const openAdvanced = () => fireEvent.click(screen.getByRole('tab', { name: 'Advanced' }))
function setting(title: string) {
  const selector = screen.getByRole('combobox', { name: (screen.getByRole('radio', { name: 'Article' }) as HTMLInputElement).checked ? 'Article setting' : 'Catalog setting' })
  const option = within(selector).getAllByRole('option').find((option) => option.textContent === title || option.textContent?.endsWith(`: ${title}`)) as HTMLOptionElement
  if (!option) throw new Error(`No setting named ${title}`)
  fireEvent.change(selector, { target: { value: option.value } })
}
const openSection = (title: string) => {
  const selector = screen.getByRole('combobox', { name: (screen.getByRole('radio', { name: 'Article' }) as HTMLInputElement).checked ? 'Article setting' : 'Catalog setting' })
  const option = within(selector).getAllByRole('option').find((option) => option.textContent === title || option.textContent?.startsWith(`${title}: `)) as HTMLOptionElement
  fireEvent.change(selector, { target: { value: option.value } })
}
const radio = (group: string, name: string) => {
  setting(group)
  return within(screen.getByRole('group', { name: group })).getByRole('radio', { name })
}
function startingPoint(title: string) {
  selectView('Guide section', title)
  return within(screen.getByRole('dialog', { name: 'How this works' })).getByRole('region', { name: title })
}

describe('Advanced', () => {
  it('opens clean on Article with the reference summary: no save, no model call, omission kept', async () => {
    const server = studio(config())
    await renderPage()
    openAdvanced()
    expect(screen.getByRole('heading', { name: 'Advanced extraction' })).toBeInTheDocument()
    expect(radio('Scope', 'Full source')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Use service defaults', pressed: true })).toBeInTheDocument()
    openSection('Source context')
    expect(radio('Scope', 'Full source')).toBeDisabled()
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    expect(screen.getByText('Applies to new Extractions in your Projects.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    openAdvanced()
    expect(screen.getByText('Everything saved')).toBeInTheDocument()
    expect(server.puts()).toEqual([])
    expect(server.request.mock.calls.map(([url]) => String(url))).not.toContainEqual(expect.stringMatching(/extractions|generation|model_probe$/))
  })

  it('a model choice and a span setting survive tab switches; Discard restores both', async () => {
    const server = studio(config({ extractionModels: { fields: 'nuextract' } }))
    await renderPage()
    fireEvent.click(within(step('Extracting data')).getByRole('button', { name: 'Use defaults' }))
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Evidence')
    fireEvent.click(radio('Verification', 'Source spans'))
    expect(screen.getAllByText('Changed').some((label) => !label.closest('[hidden]'))).toBe(true)
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(within(step('Extracting data')).getByRole('button', { name: 'Change' })).toBeInTheDocument()
    openAdvanced()
    openSection('Evidence')
    expect(radio('Verification', 'Source spans')).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('button', { name: 'Use service defaults', pressed: true })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    expect(within(step('Extracting data')).getByRole('button', { name: 'Use defaults' })).toBeInTheDocument()
    expect(screen.getByText('Everything saved')).toBeInTheDocument()
    expect(server.puts()).toEqual([])
  })

  it('Apply saves the whole draft; a failed Apply keeps the draft and the saved state', async () => {
    let fail = true
    const server = studio(config(), { put: () => (fail ? jsonResponse({ error: { code: 'persistence_unavailable', message: 'Unavailable.' } }, 503) : undefined) })
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Evidence')
    fireEvent.click(radio('Verification', 'Source spans'))
    apply()
    expect(await screen.findByRole('alert')).toHaveTextContent('persistence_unavailable')
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(radio('Verification', 'Source spans')).toBeChecked()
    expect(server.stored().extractionSettings).toEqual({})
    fail = false
    apply()
    await waitFor(() => expect(screen.getByText('Everything saved')).toBeInTheDocument())
    expect(server.stored().extractionSettings).toEqual({ article: { ...REFERENCE_ARTICLE, grounding: 'spans' } })
  })

  it('Bounded + overlap 1 → Full keeps overlap 1 visibly invalid and blocks Apply; Bounded again resolves it', async () => {
    studio(config())
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Source context')
    expect(radio('Previous passages', '1')).toBeDisabled()
    expect(screen.getAllByText(`(${METHOD_MESSAGES.bounded})`).length).toBeGreaterThan(0)
    fireEvent.click(radio('Scope', 'Bounded source units'))
    fireEvent.click(radio('Previous passages', '1'))
    fireEvent.click(radio('Scope', 'Full source'))
    expect(radio('Previous passages', '1')).toBeChecked()
    expect(radio('Previous passages', '1')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(METHOD_MESSAGES.bounded, { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '1 issue blocks Apply' }))
    await waitFor(() => expect(radio('Previous passages', '1')).toHaveFocus())
    fireEvent.click(radio('Scope', 'Bounded source units'))
    expect(radio('Previous passages', '1')).toBeChecked()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
  })

  it('an invalid field remains available when moving between settings', async () => {
    studio(config({ extractionSettings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans', evidence_policy: 'schema' } } }))
    await renderPage()
    openAdvanced()
    openSection('Evidence')
    fireEvent.click(radio('Verification', 'Source labels'))
    setting('Fields to verify')
    expect(screen.getByText(METHOD_MESSAGES.schemaPolicy, { selector: 'p' })).toBeVisible()
  })

  it('numbers state their unit and minimum and are never clamped', async () => {
    const server = studio(config())
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Source context')
    setting('Context ceiling')
    const ceiling = screen.getByRole('textbox', { name: /Context ceiling/ })
    expect(ceiling).toHaveAttribute('readonly')
    expect(screen.getByText('Used with bounded source units')).toBeInTheDocument()
    fireEvent.click(radio('Scope', 'Bounded source units'))
    setting('Context ceiling')
    for (const text of ['8191', '12288.5', 'twelve']) {
      fireEvent.change(ceiling, { target: { value: text } })
      expect(ceiling).toHaveValue(text)
      expect(screen.getByText(METHOD_MESSAGES.contextTokens, { selector: 'p' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    }
    fireEvent.change(ceiling, { target: { value: '8192' } })
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0]!.extractionSettings.article?.context_tokens).toBe(8192)
  })

  it('identity fields: names keep exact case, refuse empty and duplicate names, and conservative needs one', async () => {
    studio(config())
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Record identity')
    setting('Identity fields')
    const name = screen.getByRole('textbox', { name: 'Identity field name' })
    fireEvent.change(name, { target: { value: '  Species ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    expect(within(screen.getByRole('combobox', { name: 'Declared identity fields' })).getByRole('option', { name: 'Species' })).toBeInTheDocument()
    fireEvent.change(name, { target: { value: 'Species' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    expect(screen.getByText(METHOD_MESSAGES.identityNames)).toBeInTheDocument()
    fireEvent.click(radio('Reconciliation', 'Declared identity fields'))
    setting('Identity fields')
    fireEvent.click(screen.getByRole('button', { name: 'Remove Species' }))
    expect(screen.getByText(METHOD_MESSAGES.identity, { selector: 'p' })).toBeInTheDocument()
  })

  it('Catalog keeps generic limits and recipe factors apart; Use service defaults removes only Catalog', async () => {
    const server = studio(config({ extractionSettings: { article: REFERENCE_ARTICLE } }))
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Recipe Catalog')
    expect(screen.getByRole('region', { name: 'Recipe Catalog' })).toHaveTextContent('Applies when a Catalog Extraction uses a numbered-catalogue recipe.')
    setting('Verification')
    fireEvent.click(screen.getByRole('switch', { name: 'Verification' }))
    expect(screen.getByText('Off keeps typed values as proposals, not accepted evidence.')).toBeInTheDocument()
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0]!.extractionSettings.catalog?.recipe?.factors?.verification).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Use service defaults' }))
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(2))
    expect(server.puts()[1]!.extractionSettings).toEqual({ article: REFERENCE_ARTICLE })
  })

  it('the issue summary opens Advanced from another tab on the issue\'s strategy and focuses its control', async () => {
    studio(config())
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Generic Catalog')
    fireEvent.change(screen.getByRole('textbox', { name: 'Discovery text limit' }), { target: { value: '999' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Models' }))
    fireEvent.click(screen.getByRole('button', { name: '1 issue blocks Apply' }))
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Discovery text limit' })).toHaveFocus())
    expect(screen.getByRole('radio', { name: 'Catalog' })).toBeChecked()
    expect(screen.getByRole('textbox', { name: 'Discovery text limit' })).toHaveValue('999')
    expect(screen.getByRole('textbox', { name: 'Discovery text limit' })).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(METHOD_MESSAGES.characters, { selector: 'p' })).toBeVisible()
  })

  it('a Catalog shape issue does not hide an Article cross-field issue: both count, the Article section opens, no preview', async () => {
    studio(config())
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Source context')
    fireEvent.click(radio('Scope', 'Bounded source units'))
    fireEvent.click(radio('Previous passages', '1'))
    fireEvent.click(radio('Scope', 'Full source'))
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Generic Catalog')
    fireEvent.change(screen.getByRole('textbox', { name: 'Discovery text limit' }), { target: { value: '999' } })
    fireEvent.click(screen.getByRole('button', { name: '2 issues block Apply' }))
    await waitFor(() => expect(radio('Previous passages', '1')).toHaveFocus())
    expect(screen.getByText(METHOD_MESSAGES.bounded, { selector: 'p' })).toBeVisible()
    openSection('Technical details')
    expect(screen.getByText('Fix the issues above to preview the request.')).toBeInTheDocument()
    expect(screen.queryByText(/"strategy"/)).not.toBeInTheDocument()
  })

  it('Explain opens from a section while service defaults are in use, changes nothing, and Escape returns focus', async () => {
    const server = studio(config())
    await renderPage()
    openAdvanced()
    openSection('Evidence')
    const trigger = screen.getByRole('button', { name: 'Explain Evidence' })
    expect(trigger).toBeEnabled()
    trigger.focus()
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Verification' })
    selectView('Topic section', 'Example')
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Generated quotes' }))
    selectView('Topics', 'Fields to verify')
    fireEvent(dialog, new Event('cancel', { cancelable: true }))
    await waitFor(() => expect(trigger).toHaveFocus())
    expect(screen.getByRole('button', { name: 'Use service defaults', pressed: true })).toBeInTheDocument()
    expect(screen.getByText('Everything saved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    openSection('Recipe Catalog')
    fireEvent.click(screen.getByRole('button', { name: 'Explain Recipe Catalog' }))
    expect(screen.getByRole('dialog', { name: 'Catalog' })).toBeInTheDocument()
    expect(server.puts()).toEqual([])
    expect(server.request.mock.calls.map(([url]) => String(url))).not.toContainEqual(expect.stringMatching(/extractions|generation/))
  })

  it('a starting point changes only the Article draft, Undo restores it, and service defaults restore the request shape', async () => {
    const server = studio(config({ extractionModels: { fields: 'nuextract' }, extractionSettings: { catalog: { generic: { record_chars: 30000 } } } }))
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    const point = startingPoint('Explore spans and schema policies')
    fireEvent.click(within(point).getByRole('button', { name: 'Show changes' }))
    fireEvent.click(within(point).getByRole('button', { name: 'Use these settings' }))
    expect(screen.getByText('Settings from “Explore spans and schema policies” are in your draft. Apply saves them.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(screen.getByText('Everything saved')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    const again = within(startingPoint('Explore spans and schema policies'))
    fireEvent.click(again.getByRole('button', { name: 'Show changes' }))
    fireEvent.click(again.getByRole('button', { name: 'Use these settings' }))
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(1))
    expect(server.puts()[0]).toMatchObject({ extractionModels: { fields: 'nuextract' }, extractionSettings: { catalog: { generic: { record_chars: 30000 } }, article: { grounding: 'spans' } } })
    expect(JSON.stringify(server.puts()[0])).not.toMatch(/preset|Explore spans/)
    // Apply ended the notice: an edit that keeps those Article settings does not bring it, or its Undo, back.
    await waitFor(() => expect(screen.getByText('Everything saved')).toBeInTheDocument())
    expect(screen.queryByText(/are in your draft/)).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    openSection('Recipe Catalog')
    setting('Glossary')
    fireEvent.click(screen.getByRole('switch', { name: 'Glossary' }))
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
    expect(screen.queryByText(/are in your draft/)).toBeNull()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    setting('Glossary')
    fireEvent.click(screen.getByRole('switch', { name: 'Glossary' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Article' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use service defaults' }))
    apply()
    await waitFor(() => expect(server.puts()).toHaveLength(2))
    expect(server.puts()[1]!.extractionSettings).toEqual({ catalog: { generic: { record_chars: 30000 } } })
  })

  it('Undo restores the prior Article draft exactly, number text included, and returns focus to How this works', async () => {
    studio(config())
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    openSection('Source context')
    fireEvent.click(radio('Scope', 'Bounded source units'))
    setting('Context ceiling')
    fireEvent.change(screen.getByRole('textbox', { name: /Context ceiling/ }), { target: { value: '12k' } })
    expect(screen.getByRole('button', { name: '1 issue blocks Apply' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
    const point = within(startingPoint('Reference controls'))
    fireEvent.click(point.getByRole('button', { name: 'Show changes' }))
    expect(point.getByText('Bounded source units → Full source', { exact: false })).toBeInTheDocument()
    fireEvent.click(point.getByRole('button', { name: 'Use these settings' }))
    expect(radio('Scope', 'Full source')).toBeChecked()
    expect(screen.queryByRole('button', { name: /blocks? Apply/ })).toBeNull()
    const undo = screen.getByRole('button', { name: 'Undo' })
    undo.focus()
    fireEvent.click(undo)
    expect(radio('Scope', 'Bounded source units')).toBeChecked()
    setting('Context ceiling')
    expect(screen.getByRole('textbox', { name: /Context ceiling/ })).toHaveValue('12k')
    expect(screen.getByRole('button', { name: '1 issue blocks Apply' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'How this works' })).toHaveFocus()
  })

  it('a starting point used from a Catalog Explain shows the Article draft and keeps focus; editing it away ends the notice', async () => {
    studio(config())
    await renderPage()
    openAdvanced()
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog' }))
    openSection('Recipe Catalog')
    fireEvent.click(screen.getByRole('button', { name: 'Explain Recipe Catalog' }))
    selectView('Topics', 'How this works')
    const point = within(startingPoint('Explore spans and schema policies'))
    fireEvent.click(point.getByRole('button', { name: 'Show changes' }))
    fireEvent.click(point.getByRole('button', { name: 'Use these settings' }))
    expect(screen.getByRole('radio', { name: 'Article' })).toBeChecked()
    await waitFor(() => expect(screen.getByRole('button', { name: 'How this works' })).toHaveFocus())
    expect(screen.getByText('Settings from “Explore spans and schema policies” are in your draft. Apply saves them.')).toBeInTheDocument()
    openSection('Evidence')
    fireEvent.click(radio('Continue verification', 'Across all source units'))
    expect(screen.queryByText(/are in your draft/)).toBeNull()
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument()
  })

  it('an Article edit ends the notice for good: editing back to the starting point, or an identity field, brings no Undo back', async () => {
    studio(config())
    await renderPage()
    openAdvanced()
    const useExplore = () => {
      fireEvent.click(screen.getByRole('button', { name: 'How this works' }))
      const point = within(startingPoint('Explore spans and schema policies'))
      fireEvent.click(point.getByRole('button', { name: 'Show changes' }))
      fireEvent.click(point.getByRole('button', { name: 'Use these settings' }))
      expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    }
    useExplore()
    openSection('Evidence')
    fireEvent.click(radio('Continue verification', 'Across all source units'))
    fireEvent.click(radio('Continue verification', 'Until first support'))
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Use service defaults' }))
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    useExplore()
    openSection('Record identity')
    setting('Identity fields')
    fireEvent.change(screen.getByRole('textbox', { name: 'Identity field name' }), { target: { value: 'species' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add field' }))
    expect(within(screen.getByRole('combobox', { name: 'Declared identity fields' })).getByRole('option', { name: 'species' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('the tablist keeps arrow-key navigation across three tabs', async () => {
    studio(config())
    await renderPage()
    const models = screen.getByRole('tab', { name: 'Models' })
    fireEvent.keyDown(models, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveFocus()
    expect(screen.getByRole('tab', { name: 'Advanced' })).toHaveAttribute('aria-selected', 'true')
  })
})
