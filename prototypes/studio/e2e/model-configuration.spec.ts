import { randomUUID } from 'node:crypto'
import { expect, test, type Locator, type Page, type Route } from '@playwright/test'
import {
  DEPLOYMENT_CONNECTION_IDS,
  type DeploymentModels,
  type IngestionModelListing,
  type ModelConfig,
  type ModelConnection,
} from '../shared/modelConfig.contract.js'
import type { ExtractionModelListing } from '../shared/extraction.contract.js'
import { E2E_ORIGIN, loginResearcher } from './auth.js'
import { REQUIRED_VIEWPORTS, activateWithKeyboard, emulateBrowserZoom200, expectOperableInViewport } from './accessibility.js'

const QWEN = 'Qwen/Qwen3.8-27B-FP8'
const NUEXTRACT = 'numind/NuExtract3-FP8'
const OPENAI_BASE = 'https://api.openai.com/v1'
const OLLAMA_BASE = 'http://127.0.0.1:11434'
const FOLLOWS = 'Schema Suggestion uses the assistant model.'
const NUEXTRACT_NOTE = 'Schema Suggestion uses the NuExtract protocol for this model.'

/** What a probe of each provider lists. Probes never leave the browser: every model server is answered here. */
const CATALOGS: Readonly<Record<string, readonly string[]>> = {
  ollama: ['llama3.3', 'qwen3:8b'],
  vllm: [QWEN, NUEXTRACT],
}

const extractionListing: ExtractionModelListing = {
  defaults: { fields: 'nuextract', reasoning: 'instruct' },
  models: [
    { key: 'instruct', repo: QWEN, roles: ['fields', 'reasoning'], reachable: true, serving: true },
    { key: 'nuextract', repo: NUEXTRACT, roles: ['fields'], reachable: true, serving: true },
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

type ProbeBody = { connection: ModelConnection; credential?: string }
type KeyHandoff = { account: string; keys: Record<string, { provider: string; baseUrl: string; key: string } | null> }

const pathOf = (url: string) => new URL(url).pathname
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Answers the model servers the page reaches through Studio: each probe (its body recorded) and the two deployment
 * listings. A listing set to fail answers 503, as Studio does when kei or kei-exp cannot list.
 */
async function routeModelServers(page: Page) {
  const probes: ProbeBody[] = []
  const failing = { listings: false }
  await page.route('**/api/model_probe', async (route) => {
    const body = route.request().postDataJSON() as ProbeBody
    probes.push(body)
    const catalog = CATALOGS[body.connection.provider] ?? []
    await route.fulfill({
      json: {
        checkedAt: '2026-09-26T00:00:00.000Z',
        status: 'connected',
        message: `Connected. ${catalog.length} models available.`,
        catalog: catalog.map((id) => ({ id, label: id })),
      },
    })
  })
  const listing = (code: string, body: unknown) => async (route: Route) =>
    failing.listings
      ? route.fulfill({ status: 503, json: { error: { code, message: 'The deployment could not list its models.' } } })
      : route.fulfill({ json: body })
  await page.route('**/api/extraction-models', listing('extraction_models_unavailable', extractionListing))
  await page.route('**/api/ingestion-models', listing('ingestion_models_unavailable', ingestionListing))
  return { probes, failing }
}

/** Signs a fresh Researcher Account in and returns its ID, as the page knows it. */
async function signIn(page: Page, objectId: string = randomUUID()): Promise<string> {
  await loginResearcher(page, objectId)
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible()
  const session = (await (await page.request.get('/api/auth/session')).json()) as { account: { id: string } }
  return session.account.id
}

async function reload(page: Page): Promise<void> {
  await page.reload()
  await expect(page.getByRole('navigation', { name: 'Projects' })).toBeVisible()
}

async function openModelConfiguration(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Configure models' }).click()
  const dialog = page.getByRole('dialog', { name: 'Model configuration' })
  // The configuration is read from PostgreSQL, through a dev server that may still be compiling the handler.
  await expect(dialog.getByRole('tab', { name: 'Models' })).toBeVisible({ timeout: 15_000 })
  return dialog
}

function seedKeys(page: Page, accountId: string, keys: KeyHandoff['keys']): Promise<void> {
  return page.evaluate(([key, value]) => localStorage.setItem(key, value), [`free.modelKeys.v1:${accountId}`, JSON.stringify(keys)])
}

async function step(dialog: Locator, title: string): Promise<Locator> {
  return dialog.getByRole('region', { name: title })
}
const details = (dialog: Locator) => dialog.getByRole('region', { name: 'Connection details' })

async function showConnections(dialog: Locator): Promise<void> {
  await dialog.getByRole('tab', { name: /^Connections/ }).click()
}

async function showModels(dialog: Locator): Promise<void> {
  await dialog.getByRole('tab', { name: 'Models' }).click()
}

/** Adds a researcher connection on the Connections tab and fills its address and key; its detail pane stays open. */
async function addConnection(dialog: Locator, label: string, fields: { baseUrl?: string; key?: string } = {}): Promise<void> {
  await showConnections(dialog)
  await dialog.getByRole('button', { name: 'Add connection' }).click()
  await dialog.getByRole('menuitem').filter({ has: dialog.page().getByText(label, { exact: true }) }).click()
  await expect(details(dialog).getByRole('heading', { name: `${label} connection` })).toBeFocused()
  if (fields.baseUrl !== undefined) await details(dialog).getByRole('textbox', { name: 'Base URL' }).fill(fields.baseUrl)
  if (fields.key !== undefined) await details(dialog).getByLabel(/^API key/).fill(fields.key)
}

async function selectConnection(dialog: Locator, name: string): Promise<Locator> {
  await showConnections(dialog)
  await dialog.getByRole('list', { name: 'Connections' }).getByRole('button', { name, exact: true }).click()
  return details(dialog)
}

/**
 * Lets each key handoff reach Studio and records what the page sent and what Studio accepted, on the way back. (The
 * page never reads this response's body, so a response listener could not read it either.)
 */
async function recordKeyHandoffs(page: Page): Promise<{ sent: KeyHandoff; accepted: string[] }[]> {
  const handoffs: { sent: KeyHandoff; accepted: string[] }[] = []
  await page.route('**/api/model-keys', async (route) => {
    const response = await route.fetch()
    const { accepted } = (await response.json()) as { accepted: string[] }
    handoffs.push({ sent: route.request().postDataJSON() as KeyHandoff, accepted })
    await route.fulfill({ response })
  })
  return handoffs
}

const storedKeys = (page: Page, accountId: string) =>
  page.evaluate((key) => localStorage.getItem(key), `free.modelKeys.v1:${accountId}`)

/** Picks `model` for a route picker from one connection's group: listed by its probe, or typed as an exact ID. */
async function chooseRoute(dialog: Locator, picker: string, group: string, model: string, typed = false): Promise<void> {
  await step(dialog, 'Schema & chat')
  await dialog.getByRole('button', { name: picker, exact: true }).click()
  if (typed) await dialog.getByRole('combobox', { name: `Search ${picker}` }).fill(model)
  await dialog
    .getByRole('listbox', { name: picker })
    .getByRole('group', { name: new RegExp(`^${escapeRegExp(group)}$`, 'i') })
    .getByRole('option', { name: typed ? `Use ${model}` : model, exact: true })
    .click()
  await expect(dialog.getByRole('listbox', { name: picker })).toBeHidden()
}

/** Applies the draft and waits until Studio answered it; returns the configuration Studio committed. */
async function apply(page: Page, dialog: Locator): Promise<ModelConfig> {
  const saved = page.waitForResponse((response) => pathOf(response.url()) === '/api/model_config' && response.request().method() === 'PUT')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  const response = await saved
  expect(response.ok()).toBe(true)
  await expect(dialog.getByText('Everything saved')).toBeVisible()
  return ((await response.json()) as { config: ModelConfig }).config
}

async function storedConfiguration(page: Page): Promise<ModelConfig> {
  const response = await page.request.get('/api/model_config')
  expect(response.ok()).toBe(true)
  return ((await response.json()) as { config: ModelConfig }).config
}

test.describe('against Studio and PostgreSQL', () => {
  test.describe.configure({ mode: 'serial' })

  test('two accounts: each sees and changes only its own configuration', async ({ page, browser }) => {
    await routeModelServers(page)
    await signIn(page)
    const dialog = await openModelConfiguration(page)
    await addConnection(dialog, 'vLLM', { baseUrl: 'http://lab-a.example:8000/v1', key: 'sk-test-e2e-account-a' })
    await showModels(dialog)
    await (await step(dialog, 'Schema & chat')).getByRole('button', { name: 'Change' }).click()
    await chooseRoute(dialog, 'Assistant model', 'vLLM', QWEN)
    const committed = await apply(page, dialog)
    const [labVllm] = committed.connections
    expect(committed.routes.interaction).toEqual({ connectionId: labVllm.id, modelId: QWEN })

    const other = await browser.newContext()
    try {
      const pageB = await other.newPage()
      await routeModelServers(pageB)
      const accountB = await signIn(pageB)
      const dialogB = await openModelConfiguration(pageB)

      // B starts from nothing: none of A's connections and the Schema & chat step at its default.
      const researcherConnectionsB = dialogB.getByRole('list', { name: 'Connections' }).getByRole('button').filter({ hasNotText: 'Deployment' })
      await showConnections(dialogB)
      await expect(researcherConnectionsB).toHaveCount(0)
      await showModels(dialogB)
      await expect((await step(dialogB, 'Schema & chat')).getByRole('button', { name: 'Change' })).toBeVisible()
      await expect(dialogB.getByRole('button', { name: 'Assistant model', exact: true })).toHaveCount(0)

      await addConnection(dialogB, 'Ollama')
      await expect(researcherConnectionsB).toHaveCount(1)
      await showModels(dialogB)
      await (await step(dialogB, 'Schema & chat')).getByRole('button', { name: 'Change' }).click()
      await chooseRoute(dialogB, 'Assistant model', 'Ollama', 'llama3.3')
      const committedB = await apply(pageB, dialogB)
      expect(committedB.connections.map(({ provider }) => provider)).toEqual(['ollama'])
      expect(await storedConfiguration(pageB)).toEqual(committedB)

      // Neither account's stored configuration holds a key, and Studio files no key under A's connection for B.
      expect(JSON.stringify(await storedConfiguration(pageB))).not.toContain('sk-test-e2e-')
      expect(JSON.stringify(await storedConfiguration(page))).not.toContain('sk-test-e2e-')
      const foreign = await pageB.request.put('/api/model-keys', {
        headers: { origin: E2E_ORIGIN },
        data: { account: accountB, keys: { [labVllm.id]: { provider: 'vllm', baseUrl: labVllm.baseUrl, key: 'sk-test-e2e-account-b' } } },
      })
      expect(foreign.status()).toBe(200)
      expect(await foreign.json()).toEqual({ accepted: [] })
    } finally {
      await other.close()
    }

    await reload(page)
    const reopened = await openModelConfiguration(page)
    await step(reopened, 'Schema & chat')
    await expect(reopened.getByRole('button', { name: 'Assistant model', exact: true })).toContainText(`${QWEN} · vLLM`)
    expect(await storedConfiguration(page)).toEqual(committed)
  })

  test('an explicit Schema Suggestion model stays explicit across a reload even when it equals the Assistant model', async ({ page }) => {
    await routeModelServers(page)
    await signIn(page)
    const dialog = await openModelConfiguration(page)
    await addConnection(dialog, 'Ollama')
    await showModels(dialog)
    const schemaAndChat = await step(dialog, 'Schema & chat')
    await schemaAndChat.getByRole('button', { name: 'Change' }).click()
    await chooseRoute(dialog, 'Assistant model', 'Ollama', 'llama3.3')
    await expect(schemaAndChat.getByText(FOLLOWS)).toBeVisible()
    await schemaAndChat.getByRole('button', { name: 'Use a different model' }).click()
    await chooseRoute(dialog, 'Schema Suggestion model', 'Ollama', 'llama3.3')
    const committed = await apply(page, dialog)
    expect(committed.routes.schemaSuggestion).toEqual(committed.routes.interaction)

    await reload(page)
    let reopened = await openModelConfiguration(page)
    await step(reopened, 'Schema & chat')
    await expect(reopened.getByRole('button', { name: 'Schema Suggestion model' })).toContainText('llama3.3 · Ollama')
    await expect((await step(reopened, 'Schema & chat')).getByText(FOLLOWS)).toHaveCount(0)
    expect((await storedConfiguration(page)).routes.schemaSuggestion).toEqual(committed.routes.interaction)

    // "Use defaults" removes both of the step's stored routes; reopened, the step is one sentence again.
    await (await step(reopened, 'Schema & chat')).getByRole('button', { name: 'Use defaults' }).click()
    await apply(page, reopened)
    await reload(page)
    reopened = await openModelConfiguration(page)
    await expect((await step(reopened, 'Schema & chat')).getByRole('button', { name: 'Change' })).toBeVisible()
    await expect((await step(reopened, 'Schema & chat'))).toContainText(/Chat, schema editing and Schema Suggestion use|No model is configured yet\./)
    await step(reopened, 'Schema & chat')
    await expect(reopened.getByRole('button', { name: 'Assistant model', exact: true })).toHaveCount(0)
    expect((await storedConfiguration(page)).routes).toEqual({ schemaSuggestion: null, interaction: null })
  })

  test('mixed exact route targets are saved and reopen as saved', async ({ page }) => {
    // An unlisted ID keeps this a manual-entry test after the asynchronous model probe finishes.
    const manualNuExtract = 'numind/NuExtract3-manual'
    await routeModelServers(page)
    await signIn(page)
    const dialog = await openModelConfiguration(page)
    await addConnection(dialog, 'vLLM', { baseUrl: 'http://nuextract.example:8000/v1' })
    await addConnection(dialog, 'OpenAI', { key: 'sk-test-e2e-typed' })
    await showModels(dialog)
    const schemaAndChat = await step(dialog, 'Schema & chat')
    await schemaAndChat.getByRole('button', { name: 'Change' }).click()
    await chooseRoute(dialog, 'Assistant model', 'OpenAI', 'gpt-manual', true)
    await schemaAndChat.getByRole('button', { name: 'Use a different model' }).click()
    await chooseRoute(dialog, 'Schema Suggestion model', 'vLLM', manualNuExtract, true)
    await expect(schemaAndChat.getByText(NUEXTRACT_NOTE)).toBeVisible()

    const configurationPut = page.waitForRequest((request) => pathOf(request.url()) === '/api/model_config' && request.method() === 'PUT')
    const committed = await apply(page, dialog)
    // The key stays out of the configuration; it reaches Studio only through the key handoff.
    expect((await configurationPut).postData()).not.toContain('sk-test-e2e-typed')
    const [vllm, openai] = committed.connections
    expect(committed.routes).toEqual({
      schemaSuggestion: { connectionId: vllm.id, modelId: manualNuExtract },
      interaction: { connectionId: openai.id, modelId: 'gpt-manual' },
    })

    await dialog.getByRole('button', { name: 'Close Model Configuration' }).click()
    const reopened = await openModelConfiguration(page)
    await step(reopened, 'Schema & chat')
    await expect(reopened.getByRole('button', { name: 'Assistant model', exact: true })).toContainText('gpt-manual · OpenAI')
    await step(reopened, 'Schema & chat')
    await expect(reopened.getByRole('button', { name: 'Schema Suggestion model' })).toContainText(`${manualNuExtract} · vLLM`)
    await expect((await step(reopened, 'Schema & chat')).getByText(NUEXTRACT_NOTE)).toBeVisible()
  })

  test("Apply hands this browser's key to Studio for the connection's current base only", async ({ page }) => {
    const { probes } = await routeModelServers(page)
    const accountId = await signIn(page)
    const handoffs = await recordKeyHandoffs(page)

    const dialog = await openModelConfiguration(page)
    await addConnection(dialog, 'OpenAI-compatible', { baseUrl: 'https://gateway-a.example/v1', key: 'sk-test-e2e-gateway-a' })
    const [gateway] = (await apply(page, dialog)).connections
    expect(gateway).toMatchObject({ provider: 'openai-compatible', baseUrl: 'https://gateway-a.example/v1', hasKey: true })
    await expect.poll(() => handoffs.length).toBe(1)
    expect(handoffs[0]).toEqual({
      sent: {
        account: accountId,
        keys: { [gateway.id]: { provider: 'openai-compatible', baseUrl: 'https://gateway-a.example/v1', key: 'sk-test-e2e-gateway-a' } },
      },
      accepted: [gateway.id],
    })
    await expect(details(dialog).getByText('Key saved in this browser')).toBeVisible()

    // Re-addressed, the connection has no key in this browser: Studio is told to drop its copy and gets nothing
    // for the new base, which is never probed with the old key either.
    await details(dialog).getByRole('textbox', { name: 'Base URL' }).fill('https://gateway-b.example/v1')
    await apply(page, dialog)
    await expect.poll(() => handoffs.length).toBe(2)
    expect(handoffs[1]).toEqual({ sent: { account: accountId, keys: { [gateway.id]: null } }, accepted: [gateway.id] })
    expect(await storedKeys(page, accountId)).toBeNull()
    // Past the edit's 500 ms probe debounce.
    await page.waitForTimeout(1_000)
    expect(probes.filter(({ connection }) => connection.baseUrl === 'https://gateway-b.example/v1')).toEqual([])
    await expect(details(dialog).getByLabel('API key (optional)')).toHaveAttribute('placeholder', 'Paste a key')
    expect(JSON.stringify(await storedConfiguration(page))).not.toContain('sk-test-e2e-')
  })

  test('removing a key or a keyed connection clears it in this browser and tells Studio to drop its copy', async ({ page }) => {
    await routeModelServers(page)
    const accountId = await signIn(page)
    const handoffs = await recordKeyHandoffs(page)
    const dialog = await openModelConfiguration(page)
    await addConnection(dialog, 'OpenAI-compatible', { baseUrl: 'https://gateway.example/v1', key: 'sk-test-e2e-removed-key' })
    await addConnection(dialog, 'OpenAI', { key: 'sk-test-e2e-removed-connection' })
    const [gateway, openai] = (await apply(page, dialog)).connections
    await expect.poll(() => handoffs.length).toBe(1)
    expect(handoffs[0].accepted.toSorted()).toEqual([gateway.id, openai.id].toSorted())

    await (await selectConnection(dialog, 'OpenAI-compatible')).getByRole('button', { name: 'Remove' }).click()
    await (await selectConnection(dialog, 'OpenAI')).getByRole('button', { name: 'Delete connection' }).click()
    const committed = await apply(page, dialog)
    expect(committed.connections).toEqual([{ ...gateway, hasKey: false }])
    await expect.poll(() => handoffs.length).toBe(2)
    expect(handoffs[1].sent).toEqual({ account: accountId, keys: { [gateway.id]: null, [openai.id]: null } })
    expect(handoffs[1].accepted.toSorted()).toEqual([gateway.id, openai.id].toSorted())
    expect(await storedKeys(page, accountId)).toBeNull()
  })

  test("a stale tab's key handoff under another signed-in account is rejected", async ({ page }) => {
    const accountA = await signIn(page)
    await seedKeys(page, accountA, {
      [randomUUID()]: { provider: 'openai', baseUrl: OPENAI_BASE, key: 'sk-test-e2e-signed-out' },
    })
    const signOut = page.getByRole('button', { name: 'Sign out' })
    const accountMenu = page.getByRole('button', { name: 'Researcher Account' })
    await expect(signOut.or(accountMenu)).toBeVisible()
    if (!(await signOut.isVisible())) await accountMenu.click()
    await Promise.all([page.waitForURL(/\/auth\/signed-out$/), signOut.click()])
    // Signing out clears this account's keys in this browser.
    expect(await storedKeys(page, accountA)).toBeNull()
    const accountB = await signIn(page)
    expect(accountB).not.toBe(accountA)

    const response = await page.request.put('/api/model-keys', {
      headers: { origin: E2E_ORIGIN },
      data: { account: accountA, keys: {} },
    })
    expect(response.status()).toBe(409)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('account_mismatch')
  })

  test('a malformed key handoff echoes nothing', async ({ page }) => {
    const accountId = await signIn(page)
    const response = await page.request.put('/api/model-keys', {
      headers: { origin: E2E_ORIGIN },
      data: { account: accountId, keys: { [randomUUID()]: { key: 'sk-test-e2e-planted', provider: 'openai', baseUrl: 7 } } },
    })
    expect(response.status()).toBe(400)
    const text = await response.text()
    expect(text).not.toContain('sk-test-e2e-planted')
    expect(JSON.parse(text)).toEqual({ error: { code: 'invalid_request', message: 'The request is invalid.' } })
  })
})

test.describe('with a mocked configuration', () => {
  const ollama: ModelConnection = { id: '11111111-1111-4111-8111-111111111111', name: 'Local Ollama', provider: 'ollama', baseUrl: OLLAMA_BASE, hasKey: false }
  const openai: ModelConnection = { id: '22222222-2222-4222-8222-222222222222', name: 'Research OpenAI', provider: 'openai', baseUrl: OPENAI_BASE, hasKey: true }
  const instruct: ModelConnection = {
    id: DEPLOYMENT_CONNECTION_IDS.instruct,
    name: 'Deployment instruction model',
    provider: 'vllm',
    baseUrl: 'http://extraction_model:8000/v1',
    hasKey: false,
  }

  function config(overrides: Partial<ModelConfig> = {}): ModelConfig {
    return { connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {}, ingestionModels: {}, extractionSettings: {}, ...overrides }
  }

  /**
   * Serves `initial` as the signed-in account's configuration with Studio's own provider list, keeps what Apply
   * sends, and records the key handoffs; everything else reaches Studio.
   */
  async function mockConfiguration(page: Page, initial: ModelConfig, deployment?: DeploymentModels) {
    let stored = initial
    const puts: ModelConfig[] = []
    const handoffs: KeyHandoff[] = []
    await page.route('**/api/model_config', async (route) => {
      if (route.request().method() === 'PUT') {
        stored = (route.request().postDataJSON() as { config: ModelConfig }).config
        puts.push(stored)
        await route.fulfill({ json: { config: stored } })
        return
      }
      const real = (await (await route.fetch()).json()) as { deployment: DeploymentModels }
      await route.fulfill({ json: { ...real, config: stored, deployment: deployment ?? real.deployment } })
    })
    await page.route('**/api/model-keys', async (route) => {
      handoffs.push(route.request().postDataJSON() as KeyHandoff)
      await route.fulfill({ json: { accepted: [] } })
    })
    return { puts, handoffs, servers: await routeModelServers(page) }
  }

  test('opening the page probes each connection with exactly the credential the rules allow', async ({ page }) => {
    const otherOpenai = { ...openai, id: '44444444-4444-4444-8444-444444444444', name: 'Gateway OpenAI' }
    const keyedVllm: ModelConnection = { id: '33333333-3333-4333-8333-333333333333', name: 'Lab vLLM', provider: 'vllm', baseUrl: 'http://lab.example:8000/v1', hasKey: true }
    const { servers } = await mockConfiguration(page, config({ connections: [ollama, openai, otherOpenai, keyedVllm] }), {
      connections: [instruct],
      defaultRoute: { connectionId: instruct.id, modelId: QWEN },
    })
    const accountId = await signIn(page)
    await seedKeys(page, accountId, {
      [openai.id]: { provider: 'openai', baseUrl: OPENAI_BASE, key: 'sk-test-e2e-this-base' },
      [otherOpenai.id]: { provider: 'openai', baseUrl: 'https://old-gateway.example/v1', key: 'sk-test-e2e-other-base' },
    })

    const dialog = await openModelConfiguration(page)
    await expect.poll(() => servers.probes.length).toBe(3)
    // Past any debounce: nothing else is probed.
    await page.waitForTimeout(1_500)
    expect(servers.probes).toHaveLength(3)
    const byId = new Map(servers.probes.map((body) => [body.connection.id, body]))
    expect(byId.get(instruct.id)).toEqual({ connection: instruct })
    expect(byId.get(ollama.id)).toEqual({ connection: ollama })
    expect(byId.get(openai.id)).toEqual({ connection: openai, credential: 'sk-test-e2e-this-base' })
    expect(JSON.stringify(servers.probes)).not.toContain('sk-test-e2e-other-base')
    await expect((await selectConnection(dialog, 'Lab vLLM')).getByText('Not checked yet.')).toBeVisible()
  })

  test('a draft base change never probes the new base with the old key', async ({ page }) => {
    const newBase = 'https://gateway.example/v1'
    const { servers } = await mockConfiguration(page, config({ connections: [ollama, openai] }))
    const accountId = await signIn(page)
    const stored = { provider: 'openai', baseUrl: OPENAI_BASE, key: 'sk-test-e2e-stored-old-base' }
    await seedKeys(page, accountId, { [openai.id]: stored })

    const dialog = await openModelConfiguration(page)
    await expect.poll(() => servers.probes.length).toBe(2)
    const pane = await selectConnection(dialog, 'Research OpenAI')
    await pane.getByRole('button', { name: 'Replace' }).click()
    await pane.getByLabel('API key').fill('sk-test-e2e-typed-old-base')
    await pane.getByRole('textbox', { name: 'Base URL' }).fill(newBase)
    await page.waitForTimeout(1_500)

    // The typed key belonged to the old base: it is cleared, and the new base, with no key here, is not probed.
    expect(servers.probes.filter(({ connection }) => connection.baseUrl === newBase)).toEqual([])
    await expect(pane.getByLabel('API key')).toHaveValue('')
    await expect(pane.getByText('Not checked yet.')).toBeVisible()

    // Discard restores the saved base, probed again with the key saved for it.
    const probed = servers.probes.length
    await dialog.getByRole('button', { name: 'Discard' }).click()
    await expect.poll(() => servers.probes.length).toBe(probed + 1)
    expect(servers.probes.at(-1)).toEqual({ connection: openai, credential: stored.key })
  })

  test('the ingestion step marks OCR models the OCR server does not serve and cannot choose them; a listing failure blocks no other edit', async ({ page }) => {
    const { puts, servers } = await mockConfiguration(page, config({ connections: [ollama] }))
    await signIn(page)
    let dialog = await openModelConfiguration(page)
    const reading = await step(dialog, 'Reading documents')
    await expect(reading).toContainText('Scanned pages are read by datalab-to/surya-ocr-2, page regions found by Heron-101.')
    await reading.getByRole('button', { name: 'Change' }).click()
    const trigger = reading.getByRole('button', { name: 'Text recognition' })
    await trigger.click()
    const unserved = dialog.getByRole('listbox', { name: 'Text recognition' }).getByRole('option', { name: /granite-vision/ })
    await expect(unserved).toHaveAttribute('aria-disabled', 'true')
    await expect(unserved).toContainText('Not loaded on the OCR server')
    await unserved.click({ force: true })
    await expect(dialog.getByRole('listbox', { name: 'Text recognition' })).toBeVisible()
    await expect(trigger).toContainText('Deployment default · datalab-to/surya-ocr-2')
    // Neither can the keyboard land on it: from the default, the next choosable row is the served model, then wraps.
    const search = dialog.getByRole('combobox', { name: 'Search Text recognition' })
    await search.press('ArrowDown')
    await search.press('ArrowDown')
    await search.press('Enter')
    await expect(trigger).toContainText('Deployment default · datalab-to/surya-ocr-2')
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled()

    servers.failing.listings = true
    await reload(page)
    dialog = await openModelConfiguration(page)
    await expect((await step(dialog, 'Reading documents'))).toContainText(
      "Scanned pages are read and their page regions found by the deployment's default models.",
    )
    await (await step(dialog, 'Schema & chat')).getByRole('button', { name: 'Change' }).click()
    await chooseRoute(dialog, 'Assistant model', 'Local Ollama', 'llama3.3')
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(dialog.getByText('Everything saved')).toBeVisible()
    expect(puts).toEqual([config({ connections: [ollama], routes: { schemaSuggestion: null, interaction: { connectionId: ollama.id, modelId: 'llama3.3' } } })])
    await expect(dialog.getByRole('alert')).toHaveCount(0)
  })

  test('the extraction and ingestion steps keep a saved choice the listing no longer offers', async ({ page }) => {
    const { puts } = await mockConfiguration(
      page,
      config({ extractionModels: { fields: 'retired_extractor' }, ingestionModels: { layout: 'layout_retired' } }),
    )
    await signIn(page)
    const dialog = await openModelConfiguration(page)
    const reading = await step(dialog, 'Reading documents')
    await expect(reading.getByRole('button', { name: 'Page regions' })).toContainText('layout_retired (not offered by this deployment)')
    const extracting = await step(dialog, 'Extracting data')
    await extracting.getByRole('button', { name: 'Change' }).click()
    await expect(extracting.getByRole('button', { name: 'Field values' })).toContainText('retired_extractor (not offered by this deployment)')

    await step(dialog, 'Reading documents')
    await reading.getByRole('button', { name: 'Change' }).click()
    await reading.getByRole('button', { name: 'Text recognition' }).click()
    await dialog.getByRole('listbox', { name: 'Text recognition' }).getByRole('option', { name: 'datalab-to/surya-ocr-2', exact: true }).click()
    await dialog.getByRole('button', { name: 'Apply' }).click()
    await expect(dialog.getByText('Everything saved')).toBeVisible()
    expect(puts).toHaveLength(1)
    expect(puts[0].ingestionModels).toEqual({ ocr: 'surya', layout: 'layout_retired' })
    expect(puts[0].extractionModels).toEqual({ fields: 'retired_extractor' })
  })

  test('model menus stay in the viewport without scrolling or moving the dialog', async ({ page }) => {
    await page.setViewportSize({ width: 971, height: 570 })
    await mockConfiguration(page, config())
    await signIn(page)
    const dialog = await openModelConfiguration(page)
    const extracting = await step(dialog, 'Extracting data')
    await extracting.getByRole('button', { name: 'Change' }).click()
    const before = await dialog.boundingBox()
    const trigger = extracting.getByRole('button', { name: 'Field values', exact: true })
    await trigger.click()
    const search = dialog.getByRole('combobox', { name: 'Search Field values' })
    await expect(search).toBeFocused()
    const popup = dialog.getByRole('listbox', { name: 'Field values' }).locator('..')
    const bounds = await popup.boundingBox()
    const anchor = await trigger.boundingBox()
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(anchor!.y)
    expect(bounds!.y).toBeGreaterThanOrEqual(0)
    expect(await dialog.boundingBox()).toEqual(before)
    expect(await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1 && element.scrollTop === 0)).toBe(true)
    await search.fill('numind')
    await search.press('ArrowDown')
    await search.press('Enter')
    await expect(trigger).toContainText(NUEXTRACT)
    await expect(trigger).toBeFocused()
    await expect(dialog.getByRole('button', { name: 'Apply' })).toBeEnabled()
    await expectOperableInViewport(page, dialog.getByRole('button', { name: 'Close Model Configuration' }))
    await expectOperableInViewport(page, dialog.getByRole('button', { name: 'Apply' }))
  })

  test('Escape closes the open model list or menu, not the Model Configuration dialog', async ({ page }) => {
    await mockConfiguration(page, config({ connections: [ollama] }))
    await signIn(page)
    const opener = page.getByRole('button', { name: 'Configure models' })
    const dialog = await openModelConfiguration(page)
    await expect(dialog.getByRole('button', { name: 'Close Model Configuration' })).toBeFocused()

    await (await step(dialog, 'Schema & chat')).getByRole('button', { name: 'Change' }).click()
    const trigger = dialog.getByRole('button', { name: 'Assistant model', exact: true })
    await trigger.click()
    const search = dialog.getByRole('combobox', { name: 'Search Assistant model' })
    await expect(search).toBeFocused()
    await search.press('Escape')
    await expect(dialog.getByRole('listbox', { name: 'Assistant model' })).toBeHidden()
    await expect(dialog).toBeVisible()
    await expect(trigger).toBeFocused()

    await showConnections(dialog)
    await dialog.getByRole('button', { name: 'Add connection' }).click()
    const menu = dialog.getByRole('menu', { name: 'Add connection' })
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Add connection' })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener).toBeFocused()
  })
})

test.describe('the Advanced tab', () => {
  test.describe.configure({ mode: 'serial' })
  const openAdvanced = async (dialog: Locator) => {
    const models = dialog.getByRole('tab', { name: 'Models' })
    await models.focus()
    await dialog.page().keyboard.press('ArrowLeft')
    await expect(dialog.getByRole('tab', { name: 'Advanced' })).toBeFocused()
    await expect(dialog.getByRole('heading', { name: 'Advanced extraction' })).toBeVisible()
  }
  const section = (dialog: Locator, title: string) => dialog.getByRole('region', { name: title })
  const setting = async (dialog: Locator, title: string) => {
    const selector = dialog.getByRole('combobox', { name: 'Article setting', exact: true })
    const option = selector.getByRole('option', { name: new RegExp(`: ${escapeRegExp(title)}$`) })
    await selector.selectOption(await option.getAttribute('value') ?? '')
  }

  test('opening, explaining and switching strategies saves nothing; an Apply survives a reload; a second account sees none of it', async ({ page, browser }) => {
    await routeModelServers(page)
    await signIn(page)
    let puts = 0
    page.on('request', (request) => { if (pathOf(request.url()) === '/api/model_config' && request.method() === 'PUT') puts += 1 })
    const dialog = await openModelConfiguration(page)
    await openAdvanced(dialog)
    await dialog.getByRole('radio', { name: 'Catalog' }).check()
    await dialog.getByRole('radio', { name: 'Article' }).check()
    await setting(dialog, 'Verification')
    await dialog.getByRole('button', { name: 'Explain Evidence' }).click()
    await expect(page.getByRole('dialog', { name: 'Verification' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog', { name: 'Verification' })).toBeHidden()
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('Everything saved')).toBeVisible()
    expect(puts).toBe(0)

    await dialog.getByRole('button', { name: 'Customize' }).click()
    await section(dialog, 'Evidence').getByRole('radio', { name: 'Source spans' }).check()
    const committed = await apply(page, dialog)
    expect(committed.extractionSettings.article?.grounding).toBe('spans')
    await reload(page)
    const reopened = await openModelConfiguration(page)
    await openAdvanced(reopened)
    await setting(reopened, 'Verification')
    await expect(section(reopened, 'Evidence').getByRole('radio', { name: 'Source spans' })).toBeChecked()
    expect(await storedConfiguration(page)).toEqual(committed)

    const other = await browser.newContext()
    try {
      const pageB = await other.newPage()
      await routeModelServers(pageB)
      await signIn(pageB)
      const dialogB = await openModelConfiguration(pageB)
      await openAdvanced(dialogB)
      await expect(dialogB.getByRole('button', { name: 'Use service defaults', pressed: true })).toBeVisible()
      expect((await storedConfiguration(pageB)).extractionSettings).toEqual({})
    } finally {
      await other.close()
    }
  })

  test('a failed Apply keeps the draft and the saved document', async ({ page }) => {
    await routeModelServers(page)
    await signIn(page)
    const dialog = await openModelConfiguration(page)
    await openAdvanced(dialog)
    await dialog.getByRole('button', { name: 'Customize' }).click()
    await page.route('**/api/model_config', (route) => route.request().method() === 'PUT'
      ? route.fulfill({ status: 503, json: { error: { code: 'persistence_unavailable', message: 'Unavailable.' } } })
      : route.fallback())
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('persistence_unavailable')
    await expect(dialog.getByText('Unsaved changes')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Customize', pressed: true })).toBeVisible()
    await page.unroute('**/api/model_config')
    expect((await storedConfiguration(page)).extractionSettings).toEqual({})
  })

  test('by keyboard: an invalid child is kept, announced, summarized and focusable; the parent back resolves it', async ({ page }) => {
    await routeModelServers(page)
    await signIn(page)
    const dialog = await openModelConfiguration(page)
    await openAdvanced(dialog)
    await activateWithKeyboard(page, dialog.getByRole('button', { name: 'Customize' }))
    const context = section(dialog, 'Source context')
    await dialog.getByRole('combobox', { name: 'Article setting', exact: true }).focus()
    await context.getByRole('radio', { name: 'Bounded source units' }).check()
    await setting(dialog, 'Previous passages')
    await context.getByRole('group', { name: 'Previous passages' }).getByRole('radio', { name: '1' }).check()
    await setting(dialog, 'Scope')
    await context.getByRole('radio', { name: 'Full source' }).check()
    await setting(dialog, 'Previous passages')
    const overlap = context.getByRole('group', { name: 'Previous passages' }).getByRole('radio', { name: '1' })
    await expect(overlap).toBeChecked()
    await expect(overlap).toHaveAttribute('aria-invalid', 'true')
    await expect(context.getByText('This choice requires bounded source units.', { exact: true }).last()).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeDisabled()
    await activateWithKeyboard(page, dialog.getByRole('button', { name: '1 issue blocks Apply' }))
    await expect(overlap).toBeFocused()
    await setting(dialog, 'Scope')
    await context.getByRole('radio', { name: 'Bounded source units' }).check()
    await setting(dialog, 'Previous passages')
    await expect(overlap).toBeChecked()
    await expect(dialog.getByRole('button', { name: 'Apply', exact: true })).toBeEnabled()
  })

  test('reflows without horizontal scrolling at 360 px, the required viewports and 200% zoom; Explain returns focus', async ({ page }, testInfo) => {
    await routeModelServers(page)
    await signIn(page)
    // Narrow widths collapse the project rail into an overlay: wait for that state, then open it (as the provider
    // dialog's viewport test does) so "Configure models" is reachable.
    const showRail = async (width: number) => {
      if (width >= 860) return
      await expect(page.getByRole('button', { name: 'Configure models' })).toHaveCount(0)
      await activateWithKeyboard(page, page.getByRole('button', { name: 'Expand projects' }))
    }
    for (const viewport of [{ width: 360, height: 800 }, ...REQUIRED_VIEWPORTS]) {
      await page.setViewportSize(viewport)
      await showRail(viewport.width)
      const dialog = await openModelConfiguration(page)
      await openAdvanced(dialog)
      await dialog.getByRole('button', { name: 'How this works' }).click()
      const guide = page.getByRole('dialog', { name: 'How this works' })
      await expect(guide.getByRole('figure')).toHaveAccessibleName(/Canonical Source Context feeds Context and grouping/)
      await page.keyboard.press('Escape')
      await expect(dialog.getByRole('button', { name: 'How this works' })).toBeFocused()
      for (const control of ['Customize', 'Apply', 'Discard'])
        await expectOperableInViewport(page, dialog.getByRole('button', { name: control, exact: true }))
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      // Every settings view fits without an internal scroll area.
      expect(await dialog.evaluate((element) => element.scrollHeight <= element.clientHeight + 1), `dialog height at ${viewport.width}px`).toBe(true)
      expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth), `dialog at ${viewport.width}px`).toBe(true)
      await page.screenshot({ path: testInfo.outputPath(`advanced-${viewport.width}x${viewport.height}.png`), fullPage: true })
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
    }
    await emulateBrowserZoom200(page)
    await showRail(640)
    const zoomed = await openModelConfiguration(page)
    await openAdvanced(zoomed)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
    expect(await zoomed.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('advanced-zoom-200.png'), fullPage: true })
  })
})
