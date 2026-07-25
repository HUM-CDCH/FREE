import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CredentialStore } from './_keyring.js'
import { writeModelConfig, type ModelConnection } from './_model_config.js'
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

  it('returns provider failures as completed 200 observations', async () => {
    const post = createPostModelProbe({
      configRoot: await temporaryRoot(),
      credentialStore: store(),
      fetch: async () => new Response('unauthorized', { status: 403 }),
    })
    const response = await post(request({ connection, credential: null }))
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      status: 'authentication_failed',
      upstream: { status: 403, body: 'unauthorized', truncated: false },
    })
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
})
