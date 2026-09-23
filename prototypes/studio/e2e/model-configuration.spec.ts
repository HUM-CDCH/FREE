import { expect, test, type Page } from '@playwright/test'
import { gotoAuthenticated } from './auth.js'

const providers = [
  ['ollama', 'Ollama', 'http', 'http://127.0.0.1:11434', 'optional', false],
  ['openai', 'OpenAI', 'http', 'https://api.openai.com/v1', 'managed', false],
  [
    'anthropic',
    'Anthropic',
    'http',
    'https://api.anthropic.com/v1',
    'managed',
    false,
  ],
  [
    'google',
    'Google',
    'http',
    'https://generativelanguage.googleapis.com/v1beta',
    'managed',
    false,
  ],
  ['codex-cli', 'Codex CLI', 'cli', null, 'external', false],
  ['claude-code', 'Claude Code', 'cli', null, 'external', false],
  ['openai-compatible', 'OpenAI-compatible', 'http', null, 'optional', false],
  ['vllm', 'vLLM', 'http', null, 'optional', true],
].map(
  ([
    kind,
    label,
    transport,
    defaultBaseUrl,
    authentication,
    supportsNuextract,
  ]) => ({
    kind,
    label,
    transport,
    defaultBaseUrl,
    authentication,
    supportsNuextract,
  }),
)

type Config = {
  connections: {
    id: string
    name: string
    provider: string
    baseUrl: string | null
  }[]
  routes: {
    schemaSuggestion: {
      connectionId: string
      modelId: string
      protocol?: 'nuextract'
    } | null
    interaction: { connectionId: string; modelId: string } | null
  }
  extractionModels: { fields?: string; reasoning?: string }
}

const deployment = { connections: [], defaultRoute: null }

async function mockConfiguration(page: Page) {
  let config: Config = {
    connections: [],
    routes: { schemaSuggestion: null, interaction: null },
    extractionModels: {},
  }
  let probes = 0
  let putFailure = false
  let putDelay = 0
  let probeStatus: 'connected' | 'unreachable' = 'connected'
  let probeDelay = 0
  await page.route('http://127.0.0.1:8055/**', (route) => route.abort())
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (path === '/api/model_config' && request.method() === 'GET') {
      await route.fulfill({ json: { config, credentialStates: {}, providers, deployment } })
      return
    }
    if (path === '/api/model_config' && request.method() === 'PUT') {
      if (putDelay > 0) {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, putDelay)
        await promise
      }
      if (putFailure) {
        await route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'keyring_unavailable',
              message: 'The credential store is locked.',
            },
          },
        })
        return
      }
      const body = request.postDataJSON() as {
        config: Config
        credentials?: Record<string, string | null>
      }
      config = body.config
      const credentialStates = Object.fromEntries(
        config.connections
          .filter(
            ({ provider }) =>
              !provider.endsWith('-cli') && provider !== 'claude-code',
          )
          .map(({ id }) => [id, body.credentials?.[id] ? 'present' : 'absent']),
      )
      await route.fulfill({ json: { config, credentialStates } })
      return
    }
    if (path === '/api/model_probe' && request.method() === 'POST') {
      probes += 1
      if (probeDelay > 0) {
        const { promise, resolve } = Promise.withResolvers<void>()
        setTimeout(resolve, probeDelay)
        await promise
      }
      const connected = probeStatus === 'connected'
      await route.fulfill({
        json: {
          checkedAt: '2026-07-25T00:00:00.000Z',
          status: probeStatus,
          message: connected
            ? 'Connected. 1 model available.'
            : 'Provider is offline.',
          catalog: connected
            ? [{ id: 'suggested-model', label: 'Suggested model' }]
            : [],
        },
      })
      return
    }
    await route.abort()
  })
  return {
    config: () => config,
    probes: () => probes,
    setPutFailure: (value: boolean) => {
      putFailure = value
    },
    setPutDelay: (value: number) => {
      putDelay = value
    },
    setProbeStatus: (value: 'connected' | 'unreachable') => {
      probeStatus = value
    },
    setProbeDelay: (value: number) => {
      probeDelay = value
    },
  }
}

test('Single model saves, reloads, and checks without probing on open or Apply', async ({
  page,
}) => {
  const state = await mockConfiguration(page)
  await gotoAuthenticated(page, '/')
  await page.getByRole('button', { name: 'Configure models' }).click()
  await expect(page.getByText('No Model Connections yet.')).toBeVisible()
  await expect(page.getByLabel(/output support/)).toHaveCount(0)
  await expect(page.getByText('Advanced output settings')).toHaveCount(0)
  expect(state.probes()).toBe(0)

  await page.getByRole('button', { name: '+ New connection' }).click()
  await page
    .getByLabel('Provider base URL')
    .fill('http://127.0.0.1:11434/custom')
  await expect.poll(state.probes).toBe(1)
  await expect(page.getByText('Connected. 1 model available.')).toBeVisible()
  await page
    .getByLabel('Single model connection')
    .selectOption({ label: 'Ollama' })
  await page.getByLabel('Single model ID').fill('manual-model-id')
  await page.getByRole('button', { name: 'Apply' }).click()

  expect(state.config().routes.schemaSuggestion).toEqual(
    state.config().routes.interaction,
  )
  expect(state.config().routes.schemaSuggestion).toMatchObject({
    modelId: 'manual-model-id',
  })
  expect(state.config().routes.schemaSuggestion).not.toHaveProperty('protocol')
  for (const route of Object.values(state.config().routes))
    expect(route).not.toHaveProperty('jsonOutput')
  expect(state.probes()).toBe(1)

  await page.getByRole('button', { name: 'Close Model Configuration' }).click()
  await page.getByRole('button', { name: 'Configure models' }).click()
  await expect(page.getByLabel('Single model ID')).toHaveValue(
    'manual-model-id',
  )
  expect(state.probes()).toBe(1)
})

test('model-list Escape preserves the provider draft before dialog dismissal', async ({
  page,
}) => {
  await mockConfiguration(page)
  await gotoAuthenticated(page, '/')

  const opener = page.getByRole('button', { name: 'Configure models' })
  await opener.click()
  const dialog = page.getByRole('dialog', {
    name: 'Model configuration',
  })
  await expect(
    dialog.getByRole('button', { name: 'Close Model Configuration' }),
  ).toBeFocused()

  await dialog.getByRole('button', { name: '+ New connection' }).click()
  await dialog
    .getByLabel('Single model connection')
    .selectOption({ label: 'Ollama' })
  const model = dialog.getByRole('combobox', { name: 'Single model ID' })
  await model.focus()
  await expect(model).toHaveAttribute('aria-expanded', 'true')

  await model.press('Escape')
  await expect(model).toHaveAttribute('aria-expanded', 'false')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Provider base URL')).toBeVisible()

  await model.press('Escape')
  await expect(dialog).not.toBeVisible()
  await expect(opener).toBeFocused()
})

test('probe scheduling supersedes stale connection edits', async ({
  page,
}) => {
  const state = await mockConfiguration(page)
  await gotoAuthenticated(page, '/')
  await page.getByRole('button', { name: 'Configure models' }).click()
  await page.getByRole('button', { name: '+ New connection' }).click()
  await page
    .getByLabel('Provider base URL')
    .fill('http://localhost:11434/first')
  await page
    .getByLabel('Provider base URL')
    .fill('http://localhost:11434/latest')

  await expect.poll(state.probes).toBe(1)
  await page.waitForTimeout(600)
  expect(state.probes()).toBe(1)
})

test('removing a connection disposes its pending and late probe state', async ({
  page,
}) => {
  // Every new connection reuses one ID, so disposal must survive same-ID recreation.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', {
      configurable: true,
      value: () => '11111111-1111-4111-8111-111111111111',
    })
  })
  const state = await mockConfiguration(page)
  state.setProbeDelay(150)
  await gotoAuthenticated(page, '/')
  await page.getByRole('button', { name: 'Configure models' }).click()
  await page.getByRole('button', { name: '+ New connection' }).click()
  await page.getByRole('button', { name: 'Delete Ollama' }).click()

  await page.waitForTimeout(600)
  expect(state.probes()).toBe(0)
  await expect(page.getByText('No Model Connections yet.')).toBeVisible()
  await page.getByRole('button', { name: '+ New connection' }).click()
  await expect.poll(state.probes).toBe(1)
  await page.getByRole('button', { name: 'Delete Ollama' }).click()
  await expect(page.getByText('No Model Connections yet.')).toBeVisible()
  await page.getByRole('button', { name: '+ New connection' }).click()
  await page.waitForTimeout(400)
  await expect(page.getByText('Not checked this session.')).toBeVisible()
  await expect(page.getByText('Connected. 1 model available.')).toBeHidden()
})

test('Capability Routes save mixed exact targets and the vLLM-only NuExtract protocol', async ({
  page,
}) => {
  const state = await mockConfiguration(page)
  await gotoAuthenticated(page, '/')
  await page.getByRole('button', { name: 'Configure models' }).click()
  await page.getByLabel('New connection provider').selectOption('vllm')
  await page.getByRole('button', { name: '+ New connection' }).click()
  await page.getByLabel('Provider base URL').fill('http://nuextract.example:8000/v1')
  await page.getByLabel('New connection provider').selectOption('openai')
  await page.getByRole('button', { name: '+ New connection' }).click()
  await page
    .locator('article')
    .nth(1)
    .getByLabel('API credential')
    .fill('transient-secret')
  await page.getByRole('button', { name: 'Capability Routes' }).click()

  await page
    .getByLabel('Schema Suggestion connection')
    .selectOption({ label: 'vLLM' })
  await page
    .getByLabel('Schema Suggestion model ID')
    .fill('numind/NuExtract3-FP8')
  await page.getByRole('combobox', { name: 'Schema Suggestion model ID' }).press('Tab')
  await page.getByLabel('Use NuExtract protocol').check()
  await page
    .getByLabel('Chat & Extraction Schema editing connection')
    .selectOption({ label: 'OpenAI' })
  await page
    .getByLabel('Chat & Extraction Schema editing model ID')
    .fill('gpt-manual')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(
    page.locator('article').nth(1).getByLabel('API credential'),
  ).toHaveValue('')
  await expect(
    page.locator('article').nth(1).getByLabel('API credential'),
  ).toHaveAttribute('placeholder', 'Stored credential will be preserved')

  const saved = state.config()
  expect(saved.routes.schemaSuggestion).toMatchObject({
    modelId: 'numind/NuExtract3-FP8',
    protocol: 'nuextract',
  })
  expect(saved.routes.interaction).toMatchObject({ modelId: 'gpt-manual' })
  expect(saved.routes.schemaSuggestion?.connectionId).not.toBe(
    saved.routes.interaction?.connectionId,
  )

  const probesBeforeReload = state.probes()
  await page.getByRole('button', { name: 'Close Model Configuration' }).click()
  await page.getByRole('button', { name: 'Configure models' }).click()
  await expect(
    page.getByLabel('Schema Suggestion model ID'),
  ).toHaveValue('numind/NuExtract3-FP8')
  await expect(
    page.getByLabel('Chat & Extraction Schema editing model ID'),
  ).toHaveValue('gpt-manual')
  expect(state.probes()).toBe(probesBeforeReload)
})

test('a draft provider change probes again, drops the NuExtract protocol, and locks once saved', async ({
  page,
}) => {
  const state = await mockConfiguration(page)
  await gotoAuthenticated(page, '/')
  await page.getByRole('button', { name: 'Configure models' }).click()
  await page.getByLabel('New connection provider').selectOption('vllm')
  await page.getByRole('button', { name: '+ New connection' }).click()
  await page.getByLabel('Provider base URL').fill('http://nuextract.example:8000/v1')
  await expect.poll(state.probes).toBe(1)

  await page.getByRole('button', { name: 'Capability Routes' }).click()
  await page
    .getByLabel('Schema Suggestion connection')
    .selectOption({ label: 'vLLM' })
  await page.getByLabel('Use NuExtract protocol').check()

  await page.getByLabel('vLLM provider').selectOption('claude-code')
  await expect.poll(state.probes).toBe(2)
  await expect(page.getByLabel('Use NuExtract protocol')).toBeHidden()

  await page
    .getByLabel('Schema Suggestion model ID')
    .fill('claude-manual')
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByLabel('Claude Code provider')).toBeHidden()
  expect(state.config().connections[0]).toMatchObject({
    provider: 'claude-code',
    baseUrl: null,
  })
  expect(state.config().routes.schemaSuggestion).not.toHaveProperty('protocol')
})

test('probe failures do not gate retryable offline Apply and pending state', async ({
  page,
}) => {
  const state = await mockConfiguration(page)
  state.setProbeStatus('unreachable')
  await gotoAuthenticated(page, '/')
  await page.getByRole('button', { name: 'Configure models' }).click()
  await page.getByRole('button', { name: '+ New connection' }).click()
  // A connection FREE manages no credential for yet is not a broken keyring.
  await expect(page.getByText('Credential store unavailable.')).toBeHidden()
  await expect(page.getByText('Provider is offline.')).toBeVisible()
  await page
    .getByLabel('Provider base URL')
    .fill('http://127.0.0.1:11434/retry')
  await expect.poll(state.probes).toBe(2)
  await page
    .getByLabel('Single model connection')
    .selectOption({ label: 'Ollama' })
  await page.getByLabel('Single model ID').fill('offline-model')

  state.setPutFailure(true)
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'keyring_unavailable: The credential store is locked.',
  )
  await expect(page.getByLabel('Single model ID')).toHaveValue('offline-model')

  state.setPutFailure(false)
  state.setPutDelay(250)
  await page.getByRole('button', { name: 'Apply' }).click()
  await expect(page.getByRole('button', { name: 'Apply' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Apply' })).toBeEnabled()
  expect(state.config().routes.schemaSuggestion).toMatchObject({
    modelId: 'offline-model',
  })
})

test('corrupt saved configuration renders the stable backend error', async ({
  page,
}) => {
  await page.route('http://127.0.0.1:8055/**', (route) => route.abort())
  let reset = false
  await page.route('**/api/model_config', (route) => {
    if (route.request().method() === 'DELETE') reset = true
    return reset
      ? route.fulfill({
          json: {
            config: { connections: [], routes: { schemaSuggestion: null, interaction: null }, extractionModels: {} },
            credentialStates: {},
            providers,
            deployment,
          },
        })
      : route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'invalid_model_config',
              message: 'Saved model configuration is invalid.',
            },
          },
        })
  })
  await page.route('**/api/project-contexts**', (route) =>
    route.fulfill({ json: { projectContexts: [] } }),
  )
  await gotoAuthenticated(page, '/')
  await page.getByRole('button', { name: 'Configure models' }).click()
  await expect(page.getByRole('alert')).toContainText(
    'invalid_model_config: Saved model configuration is invalid.',
  )
  await page.getByRole('button', { name: 'Reset model configuration' }).click()
  expect(reset).toBe(false)
  await page.getByRole('button', { name: 'Confirm reset' }).click()
  await expect(page.getByText('No Model Connections yet.')).toBeVisible()
  expect(reset).toBe(true)
})
