import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ResearcherAccountRecord,
  ResearcherAccountStore,
  ResearcherProjectStore,
} from 'db'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ModelConfig } from '../shared/modelConfig.contract.js'
import {
  createApiDispatcher,
  createApiHandlerRegistry,
  type ApiDispatcher,
} from '../server/api-dispatcher.js'
import { createStudioApp, type StudioApp } from '../server/app.js'
import { createSessionManager } from '../server/session.js'
import type { CredentialStore } from './_keyring.js'
import {
  nodeFileSystem,
  type ConfigFileSystem,
} from './_model_config.js'
import { createGetModelConfig, createPutModelConfig } from './model_config.js'
import { createPostModelProbe } from './model_probe.js'

const ORIGIN = 'https://studio.example'
const SECRET = Buffer.alloc(32, 7)
const NOW = Date.UTC(2026, 7, 20, 12)
const ACCOUNT_ID = '30000000-0000-4000-8000-000000000001'
const CONNECTION_ID = '30000000-0000-4000-8000-000000000002'
const MANAGED_SECRET = 'saved-write-only-secret'
const roots: string[] = []

const config: ModelConfig = {
  connections: [
    {
      id: CONNECTION_ID,
      name: 'Research OpenAI',
      provider: 'openai',
      baseUrl: 'https://gateway.example/openai/v1',
    },
  ],
  routes: {
    extraction: { connectionId: CONNECTION_ID, modelId: 'gpt-research' },
    interaction: { connectionId: CONNECTION_ID, modelId: 'gpt-research' },
  },
}

type ProviderFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>

type ModelAuthFixture = {
  app: StudioApp
  cookie: string
  dispatcher: Mock<ApiDispatcher>
  readConfig: Mock<ConfigFileSystem['readFile']>
  credentialCalls: {
    state: Mock<CredentialStore['state']>
    get: Mock<NonNullable<CredentialStore['get']>>
    set: Mock<CredentialStore['set']>
    delete: Mock<CredentialStore['delete']>
  }
  providerFetch: Mock<ProviderFetch>
}

async function modelAuthFixture(
  mustChangePassword = false,
): Promise<ModelAuthFixture> {
  const root = await mkdtemp(join(tmpdir(), 'free-model-auth-test-'))
  roots.push(root)
  const account: ResearcherAccountRecord = {
    id: ACCOUNT_ID,
    email: 'researcher@example.org',
    passwordHash: 'unused',
    mustChangePassword,
    disabledAt: null,
    sessionVersion: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
  }
  const accountStore: ResearcherAccountStore = {
    create: vi.fn(async () => account),
    findByEmail: vi.fn(async () => account),
    findById: vi.fn(async (id) => (id === account.id ? account : null)),
    replacePassword: vi.fn(async () => account),
    disable: vi.fn(async () => account),
  }

  const credentials = new Map<string, string>()
  const state = vi.fn<CredentialStore['state']>(async (id) =>
    credentials.has(id) ? 'present' : 'absent',
  )
  const get = vi.fn<NonNullable<CredentialStore['get']>>(async (id) =>
    credentials.get(id),
  )
  const set = vi.fn<CredentialStore['set']>(async (id, value) => {
    credentials.set(id, value)
  })
  const deleteCredential = vi.fn<CredentialStore['delete']>(async (id) => {
    credentials.delete(id)
  })
  const credentialStore: CredentialStore = {
    state,
    get,
    set,
    delete: deleteCredential,
  }
  const readConfig = vi.fn(nodeFileSystem.readFile)
  const fileSystem = { ...nodeFileSystem, readFile: readConfig }
  const providerFetch = vi.fn<ProviderFetch>(
    async () => Response.json({ data: [{ id: 'gpt-research' }] }),
  )
  const dependencies = { configRoot: root, fileSystem, credentialStore }
  const registry = createApiHandlerRegistry({
    '../api/model_config.ts': {
      GET: createGetModelConfig(dependencies),
      PUT: createPutModelConfig(dependencies),
    },
    '../api/model_probe.ts': {
      POST: createPostModelProbe({ ...dependencies, fetch: providerFetch }),
    },
  })
  const dispatcher = vi.fn(createApiDispatcher(registry))
  const app = await createStudioApp({
    studioOrigin: ORIGIN,
    basePath: '/',
    sessionSecret: SECRET,
    now: () => NOW,
    accountStore,
    dummyPasswordHash: 'unused',
    apiDispatcher: dispatcher,
    researcherProjectStore: (researcherAccountId) =>
      ({ researcherAccountId }) as ResearcherProjectStore,
  })
  const sessions = createSessionManager(SECRET, () => NOW)
  const cookie = sessions
    .serialize(sessions.issue(account.id, account.sessionVersion))
    .split(';', 1)[0]

  return {
    app,
    cookie,
    dispatcher,
    readConfig,
    credentialCalls: { state, get, set, delete: deleteCredential },
    providerFetch,
  }
}

async function modelRequest(
  test: ModelAuthFixture,
  path: '/api/model_config' | '/api/model_probe',
  method: 'GET' | 'PUT' | 'POST',
  body?: unknown,
  cookie?: string,
): Promise<Response> {
  const headers = new Headers()
  if (cookie) headers.set('cookie', cookie)
  if (method !== 'GET') {
    headers.set('content-type', 'application/json')
    headers.set('origin', ORIGIN)
  }
  return test.app.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    { clientAddress: '192.0.2.30' },
  )
}

function expectNoModelSideEffects(test: ModelAuthFixture): void {
  expect(test.dispatcher).not.toHaveBeenCalled()
  expect(test.readConfig).not.toHaveBeenCalled()
  expect(test.credentialCalls.state).not.toHaveBeenCalled()
  expect(test.credentialCalls.get).not.toHaveBeenCalled()
  expect(test.credentialCalls.set).not.toHaveBeenCalled()
  expect(test.credentialCalls.delete).not.toHaveBeenCalled()
  expect(test.providerFetch).not.toHaveBeenCalled()
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('model API authentication boundary', () => {
  it('denies unauthenticated GET, PUT, and probe before configuration, keyring, or provider access', async () => {
    const test = await modelAuthFixture()
    const responses = await Promise.all([
      modelRequest(test, '/api/model_config', 'GET'),
      modelRequest(test, '/api/model_config', 'PUT', {
        config,
        credentials: { [CONNECTION_ID]: MANAGED_SECRET },
      }),
      modelRequest(test, '/api/model_probe', 'POST', {
        connection: config.connections[0],
        credential: MANAGED_SECRET,
      }),
    ])

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401])
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'authentication_required' },
      })
    }
    expectNoModelSideEffects(test)
  })

  it('denies mandatory-change GET, PUT, and probe before configuration, keyring, or provider access', async () => {
    const test = await modelAuthFixture(true)
    const responses = await Promise.all([
      modelRequest(test, '/api/model_config', 'GET', undefined, test.cookie),
      modelRequest(
        test,
        '/api/model_config',
        'PUT',
        { config, credentials: { [CONNECTION_ID]: MANAGED_SECRET } },
        test.cookie,
      ),
      modelRequest(
        test,
        '/api/model_probe',
        'POST',
        { connection: config.connections[0], credential: MANAGED_SECRET },
        test.cookie,
      ),
    ])

    expect(responses.map(({ status }) => status)).toEqual([403, 403, 403])
    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'password_change_required' },
      })
    }
    expectNoModelSideEffects(test)
  })

  it('allows a fully authenticated researcher to replace, read, and probe shared state without exposing credentials', async () => {
    const test = await modelAuthFixture()
    const put = await modelRequest(
      test,
      '/api/model_config',
      'PUT',
      { config, credentials: { [CONNECTION_ID]: MANAGED_SECRET } },
      test.cookie,
    )
    const putText = await put.text()

    expect(put.status).toBe(200)
    expect(JSON.parse(putText)).toEqual({
      config,
      credentialStates: { [CONNECTION_ID]: 'present' },
    })
    expect(putText).not.toContain(MANAGED_SECRET)
    expect(test.providerFetch).not.toHaveBeenCalled()

    const get = await modelRequest(
      test,
      '/api/model_config',
      'GET',
      undefined,
      test.cookie,
    )
    const getText = await get.text()
    expect(get.status).toBe(200)
    expect(JSON.parse(getText)).toMatchObject({
      config,
      credentialStates: { [CONNECTION_ID]: 'present' },
    })
    expect(JSON.parse(getText).providers.length).toBeGreaterThan(0)
    expect(getText).not.toContain(MANAGED_SECRET)
    expect(test.providerFetch).not.toHaveBeenCalled()

    const probe = await modelRequest(
      test,
      '/api/model_probe',
      'POST',
      { connection: config.connections[0] },
      test.cookie,
    )
    const probeText = await probe.text()
    expect(probe.status).toBe(200)
    expect(JSON.parse(probeText)).toMatchObject({
      status: 'connected',
      catalog: [{ id: 'gpt-research' }],
    })
    expect(probeText).not.toContain(MANAGED_SECRET)
    expect(test.providerFetch).toHaveBeenCalledWith(
      'https://gateway.example/openai/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${MANAGED_SECRET}`,
        }),
      }),
    )
    expect(test.credentialCalls.set).toHaveBeenCalledTimes(1)
    expect(test.credentialCalls.get).toHaveBeenCalledTimes(1)
    expect(test.credentialCalls.delete).not.toHaveBeenCalled()
  })
})
