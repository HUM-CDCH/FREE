import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelConnection } from '../shared/modelConfig.contract.js'
import type { CredentialStore } from './_keyring.js'
import { writeModelConfig } from './_model_config.js'
import { createPostModelProbe } from './model_probe.js'

const ID = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []
const connection: ModelConnection = {
  id: ID,
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://gateway.example/openai/v1',
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'free-probe-test-'))
  roots.push(root)
  return root
}

function request(body: unknown): Request {
  return new Request('http://local.test/api/model_probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function store(value?: string): CredentialStore {
  return {
    state: async () => (value === undefined ? 'absent' : 'present'),
    get: async () => value,
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('POST /api/model_probe', () => {
  it('uses a transient credential without storing or returning it', async () => {
    const credentialStore = store()
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'gpt-manual' }] }))
    const post = createPostModelProbe({
      configRoot: await temporaryRoot(),
      credentialStore,
      fetch,
      now: () => new Date('2026-07-25T00:00:00Z'),
    })
    const response = await post(request({ connection, credential: 'write-only-secret' }))
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(text).not.toContain('write-only-secret')
    expect(JSON.parse(text)).toMatchObject({ status: 'connected', catalog: [{ id: 'gpt-manual' }] })
    expect(fetch).toHaveBeenCalledWith('https://gateway.example/openai/v1/models', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer write-only-secret' }),
    }))
    expect(credentialStore.set).not.toHaveBeenCalled()
    expect(credentialStore.delete).not.toHaveBeenCalled()
  })

  it('reuses only a matching saved credential and leaves configuration unchanged', async () => {
    const root = await temporaryRoot()
    await writeModelConfig({
      connections: [connection],
      routes: { extraction: null, interaction: null },
    }, { configRoot: root })
    const before = await readFile(join(root, 'model-config.json'))
    const post = createPostModelProbe({
      configRoot: root,
      credentialStore: store('saved-secret'),
      fetch: async () => Response.json({ data: [] }),
    })
    const response = await post(request({ connection }))

    expect(response.status).toBe(200)
    expect(await readFile(join(root, 'model-config.json'))).toEqual(before)
  })

  it('does not send a saved credential to a changed provider endpoint', async () => {
    const root = await temporaryRoot()
    await writeModelConfig(
      {
        connections: [connection],
        routes: { extraction: null, interaction: null },
      },
      { configRoot: root },
    )
    const fetch = vi.fn()
    const post = createPostModelProbe({
      configRoot: root,
      credentialStore: store('saved-secret'),
      fetch,
    })

    const response = await post(
      request({
        connection: {
          ...connection,
          baseUrl: 'https://attacker.example/openai/v1',
        },
      }),
    )

    expect(response.status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['transient', 'transient-secret', undefined],
    ['stored', undefined, 'stored-secret'],
  ])('does not serialize credential-bearing upstream detail for %s credentials', async (_mode, transient, stored) => {
    const root = await temporaryRoot()
    if (stored !== undefined) {
      await writeModelConfig({
        connections: [connection],
        routes: { extraction: null, interaction: null },
      }, { configRoot: root })
    }
    const post = createPostModelProbe({
      configRoot: root,
      credentialStore: store(stored),
      fetch: async () => new Response('{malformed', { status: 403 }),
    })
    const response = await post(request({
      connection,
      ...(transient === undefined ? {} : { credential: transient }),
    }))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result).toMatchObject({ status: 'authentication_failed', catalog: [] })
    expect(result).not.toHaveProperty('credential')
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain(transient ?? stored)
  })

  it.each([
    ['transient', 'transient-secret', undefined],
    ['stored', undefined, 'stored-secret'],
  ])('does not serialize credential-bearing malformed responses for %s credentials', async (_mode, transient, stored) => {
    const root = await temporaryRoot()
    if (stored !== undefined) {
      await writeModelConfig({
        connections: [connection],
        routes: { extraction: null, interaction: null },
      }, { configRoot: root })
    }
    const post = createPostModelProbe({
      configRoot: root,
      credentialStore: store(stored),
      fetch: async () => new Response('{malformed'),
    })
    const response = await post(request({
      connection,
      ...(transient === undefined ? {} : { credential: transient }),
    }))
    const result = await response.json()

    expect(result).toMatchObject({ status: 'invalid_response', catalog: [] })
    expect(result).not.toHaveProperty('credential')
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain(transient ?? stored)
  })

  it('returns provider failures as sanitized completed 200 observations', async () => {
    const post = createPostModelProbe({
      configRoot: await temporaryRoot(),
      credentialStore: store(),
      fetch: async () => new Response('unauthorized', { status: 403 }),
    })
    const response = await post(request({ connection, credential: null }))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({
      status: 'authentication_failed',
    })
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain('unauthorized')
  })


  it('runs overlapping probes independently against each immutable draft snapshot', async () => {
    const root = await temporaryRoot()
    const credentialStore = store()
    const firstReply = Promise.withResolvers<Response>()
    const secondReply = Promise.withResolvers<Response>()
    const bothStarted = Promise.withResolvers<void>()
    let started = 0
    const fetch = vi.fn((input: string | URL | Request) => {
      started += 1
      if (started === 2) bothStarted.resolve()
      return String(input).includes('second.example')
        ? secondReply.promise
        : firstReply.promise
    })
    const post = createPostModelProbe({
      configRoot: root,
      credentialStore,
      fetch,
    })
    const secondConnection: ModelConnection = {
      ...connection,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Second OpenAI-compatible gateway',
      baseUrl: 'https://second.example/v1',
    }
    const completionOrder: string[] = []

    const firstProbe = post(
      request({ connection, credential: 'first-transient-secret' }),
    ).then((response) => {
      completionOrder.push('first')
      return response
    })
    const secondProbe = post(
      request({
        connection: secondConnection,
        credential: 'second-transient-secret',
      }),
    ).then((response) => {
      completionOrder.push('second')
      return response
    })
    await bothStarted.promise

    secondReply.resolve(Response.json({ data: [{ id: 'second-model' }] }))
    const secondResponse = await secondProbe
    const secondText = await secondResponse.text()
    expect(JSON.parse(secondText)).toMatchObject({
      status: 'connected',
      catalog: [{ id: 'second-model' }],
    })
    expect(secondText).not.toContain('second-transient-secret')
    expect(completionOrder).toEqual(['second'])

    firstReply.resolve(Response.json({ data: [{ id: 'first-model' }] }))
    const firstResponse = await firstProbe
    const firstText = await firstResponse.text()
    expect(JSON.parse(firstText)).toMatchObject({
      status: 'connected',
      catalog: [{ id: 'first-model' }],
    })
    expect(firstText).not.toContain('first-transient-secret')
    expect(completionOrder).toEqual(['second', 'first'])
    expect(fetch).toHaveBeenCalledWith(
      'https://gateway.example/openai/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer first-transient-secret',
        }),
      }),
    )
    expect(fetch).toHaveBeenCalledWith(
      'https://second.example/v1/models',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer second-transient-secret',
        }),
      }),
    )
    expect(credentialStore.set).not.toHaveBeenCalled()
    expect(credentialStore.delete).not.toHaveBeenCalled()
    await expect(readFile(join(root, 'model-config.json'))).rejects.toMatchObject(
      { code: 'ENOENT' },
    )
  })
  it('rejects malformed requests before provider traffic', async () => {
    const fetch = vi.fn()
    // configRoot is injected even though validation rejects before any read:
    // the default resolves to the researcher's real application-config
    // directory, and no test may depend on that path being absent.
    const post = createPostModelProbe({ configRoot: await temporaryRoot(), fetch, credentialStore: store() })
    const response = await post(request({ connection, credential: '', unknown: true }))
    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'invalid_request' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  // The issue paths are rewritten from the shared connection-contract check, so
  // they must name the probe payload's `connection`, not a `connections` array.
  it('reports semantic issues against the submitted payload shape', async () => {
    const fetch = vi.fn()
    const post = createPostModelProbe({ configRoot: await temporaryRoot(), fetch, credentialStore: store() })
    const response = await post(
      request({ connection: { ...connection, baseUrl: 'https://gateway.example/openai/v1?key=x' } }),
    )
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 'invalid_model_config',
        details: { issues: [{ path: 'connection.baseUrl' }] },
      },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
