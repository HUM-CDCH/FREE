// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createRef, type RefObject } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  put?: (config: ModelConfig) => Response | undefined
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

    // A step with a stored choice opens on its pickers.
    expect(within(step('Reading documents')).getByRole('button', { name: 'Text recognition' })).toHaveTextContent('datalab-to/surya-ocr-2')
    expect(within(step('Reading documents')).getByRole('button', { name: 'Page regions' })).toHaveTextContent('Egret XLarge')
    expect(within(step('Schema & chat')).getByRole('button', { name: 'Assistant model' })).toHaveTextContent('llama3.3 · Local Ollama')
    expect(within(step('Extracting data')).getByRole('button', { name: 'Field values' })).toHaveTextContent(QWEN)

    for (const title of ['Reading documents', 'Schema & chat', 'Extracting data']) {
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
    expect(added.getByRole('heading', { name: 'vLLM connection' })).toBeInTheDocument()

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
    // Masked, but not a password field: a password manager would keep another copy of the key.
    expect(input).toHaveAttribute('type', 'text')
    expect(input).toHaveAttribute('autocomplete', 'off')
    expect(input).toHaveAttribute('spellcheck', 'false')
    expect(input.className).toContain('[-webkit-text-security:disc]')
    fireEvent.click(saved.getByRole('button', { name: 'Keep saved key' }))
    expect(saved.getByText('Key saved in this browser')).toBeInTheDocument()
    expect(saved.getByRole('button', { name: 'Remove' })).toBeInTheDocument()

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
    const ollamaProbes = () => server.probes().filter(({ connection }) => connection.id === OLLAMA_ID).map(({ connection }) => connection.name)
    fireEvent.change(renamed.getByRole('textbox', { name: 'Name' }), { target: { value: 'Renamed Ollama' } })
    await waitFor(() => expect(ollamaProbes().at(-1)).toBe('Renamed Ollama'), DEBOUNCED)
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(renamed.getByRole('textbox', { name: 'Name' })).toHaveValue('Local Ollama')
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled()
    // The restored connection is checked again as saved.
    await waitFor(() => expect(ollamaProbes()).toEqual(['Local Ollama', 'Renamed Ollama', 'Local Ollama']))
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
})
