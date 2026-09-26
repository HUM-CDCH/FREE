import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEPLOYMENT_CONNECTION_IDS, type ModelConnection } from '../shared/modelConfig.contract.js'
import { studioProcess } from './_model_keys.js'
import { createResearcherApiHandlers, type ModelProbeDependencies } from './model_probe.js'

const ACCOUNT = '11111111-1111-4111-8111-1111111111a1'
const ID = '11111111-1111-4111-8111-111111111111'
const connection: ModelConnection = {
  id: ID,
  name: 'OpenAI',
  provider: 'openai',
  baseUrl: 'https://gateway.example/openai/v1',
  hasKey: true,
}
const keyless: ModelConnection = {
  id: '11111111-1111-4111-8111-111111111112',
  name: 'Lab vLLM',
  provider: 'vllm',
  baseUrl: 'http://lab.example:8000/v1',
  hasKey: false,
}

function accountProbe(dependencies: ModelProbeDependencies) {
  return createResearcherApiHandlers({ researcherAccountId: ACCOUNT }, dependencies).POST
}

function request(body: unknown, contentType = 'application/json'): Request {
  return new Request('http://local.test/api/model_probe', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

afterEach(() => {
  studioProcess.keys.forgetAccount(ACCOUNT)
  vi.restoreAllMocks()
})

describe('POST /api/model_probe', () => {
  const deployed: ModelConnection = {
    id: DEPLOYMENT_CONNECTION_IDS.instruct, name: 'Deployment instruction model', provider: 'vllm',
    baseUrl: 'http://extraction_model:8000/v1', hasKey: false,
  }
  const deployment = () => ({ connections: [deployed], defaultRoute: null })

  it('a hasKey connection is probed with the key the page sent, never one Studio holds', async () => {
    studioProcess.keys.put(ACCOUNT, ID, { provider: connection.provider, baseUrl: connection.baseUrl }, 'sk-test-cached')
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'gpt-manual' }] }))
    const post = accountProbe({ fetch, now: () => new Date('2026-07-25T00:00:00Z') })

    const response = await post(request({ connection, credential: 'sk-test-page' }))
    const text = await response.text()

    expect(response.status).toBe(200)
    expect(JSON.parse(text)).toMatchObject({ status: 'connected', catalog: [{ id: 'gpt-manual' }] })
    expect(text).not.toContain('sk-test-page')
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledWith('https://gateway.example/openai/v1/models', expect.objectContaining({
      method: 'GET',
      headers: expect.objectContaining({ authorization: 'Bearer sk-test-page' }),
    }))
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('sk-test-cached')
  })

  it('a hasKey probe without a key, and a keyless probe with one, are refused before any request', async () => {
    studioProcess.keys.put(ACCOUNT, ID, { provider: connection.provider, baseUrl: connection.baseUrl }, 'sk-test-cached')
    const fetch = vi.fn()
    const post = accountProbe({ fetch })

    const withoutKey = await post(request({ connection }))
    expect(withoutKey.status).toBe(409)
    await expect(withoutKey.json()).resolves.toEqual({
      error: { code: 'invalid_model_config', message: 'Probe this connection with its key.' },
    })
    const unexpectedKey = await post(request({ connection: keyless, credential: 'sk-test-keyless' }))
    expect(unexpectedKey.status).toBe(409)
    const text = await unexpectedKey.text()
    expect(JSON.parse(text)).toEqual({
      error: { code: 'invalid_model_config', message: 'This connection uses no key; probe it without one.' },
    })
    expect(text).not.toContain('sk-test-keyless')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a keyless connection is probed without a key', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'lab-model' }] }))
    const post = accountProbe({ fetch })

    const response = await post(request({ connection: keyless }))

    expect(response.status).toBe(200)
    expect(fetch).toHaveBeenCalledWith('http://lab.example:8000/v1/models', expect.objectContaining({
      headers: expect.not.objectContaining({ authorization: expect.anything() }),
    }))
  })

  it('a deployment connection is probed at the served address without a key', async () => {
    const fetch = vi.fn(async () => Response.json({ data: [{ id: 'Qwen/Qwen3.8-27B-FP8' }] }))
    const post = accountProbe({ fetch, deployment })

    const response = await post(request({ connection: { ...deployed, baseUrl: 'https://attacker.example/v1' } }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'connected', catalog: [{ id: 'Qwen/Qwen3.8-27B-FP8' }] })
    expect(fetch).toHaveBeenCalledWith('http://extraction_model:8000/v1/models', expect.objectContaining({
      headers: expect.not.objectContaining({ authorization: expect.anything() }),
    }))
  })

  it('refuses a credential for, or a probe of an unserved, deployment connection', async () => {
    const fetch = vi.fn()
    const post = accountProbe({ fetch, deployment })
    expect((await post(request({ connection: deployed, credential: 'sk-test-deployment' }))).status).toBe(409)
    const unserved = { ...deployed, id: DEPLOYMENT_CONNECTION_IDS.nuextract }
    expect((await post(request({ connection: unserved }))).status).toBe(409)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('Probe rejects a researcher-defined CLI connection before running any CLI', async () => {
    const codexListModels = vi.fn(async () => [])
    const claudeStatus = vi.fn(async () => {})
    const post = accountProbe({ codexListModels, claudeStatus, deployment })
    for (const provider of ['codex-cli', 'claude-code'] as const) {
      const response = await post(request({ connection: { ...keyless, provider, baseUrl: null } }))

      expect(response.status).toBe(409)
      const body = (await response.json()) as { error: { code: string; details: { issues: { path: string }[] } } }
      expect(body.error.code).toBe('invalid_model_config')
      expect(body.error.details.issues.map(({ path }) => path)).toEqual(['connection.provider'])
    }
    expect(codexListModels).not.toHaveBeenCalled()
    expect(claudeStatus).not.toHaveBeenCalled()
  })

  it('an enabled CLI deployment connection is probed through its deployment ID', async () => {
    const codexCli: ModelConnection = {
      id: DEPLOYMENT_CONNECTION_IDS.codexCli, name: 'Codex CLI on this server', provider: 'codex-cli', baseUrl: null, hasKey: false,
    }
    const codexListModels = vi.fn(async () => [{ id: 'gpt-5.5-codex', displayName: 'GPT-5.5 Codex' }])
    const enabled = accountProbe({ codexListModels, deployment: () => ({ connections: [codexCli], defaultRoute: null }) })

    const response = await enabled(request({ connection: codexCli }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'connected', catalog: [{ id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex' }] })
    expect(codexListModels).toHaveBeenCalledOnce()

    const disabled = accountProbe({ codexListModels, deployment: () => ({ connections: [], defaultRoute: null }) })
    const refused = await disabled(request({ connection: codexCli }))
    expect(refused.status).toBe(409)
    await expect(refused.json()).resolves.toEqual({
      error: { code: 'invalid_model_config', message: 'This deployment does not serve that connection.' },
    })
    expect(codexListModels).toHaveBeenCalledOnce()
  })

  it('holds a deployment probe to the same request contract as any probe', async () => {
    const fetch = vi.fn()
    const post = accountProbe({ fetch, deployment })
    for (const body of [{ connection: { id: deployed.id } }, { connection: deployed, unknown: true }]) {
      const response = await post(request(body))
      expect(response.status).toBe(400)
      await expect(response.json()).resolves.toEqual({ error: { code: 'invalid_request', message: 'The request is invalid.' } })
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid JSON', `{"connection":{"id":"${ID}"},"credential":"sk-test-planted-3"`, 'application/json'],
    ['a credential of the wrong type', { connection, credential: ['sk-test-planted-3'] }, 'application/json'],
    ['an extra property', { connection, credential: 'sk-test-planted-3', 'sk-test-planted-3': 'sk-test-planted-3' }, 'application/json'],
    ['an extra connection property', { connection: { ...connection, key: 'sk-test-planted-3' } }, 'application/json'],
    ['a deployment probe with an extra property', { connection: deployed, 'sk-test-planted-3': 'sk-test-planted-3' }, 'application/json'],
    ['a wrong media type', { connection, credential: 'sk-test-planted-3' }, 'text/plain'],
  ])('a malformed probe (%s) echoes nothing and logs nothing', async (_label, body, contentType) => {
    const fetch = vi.fn()
    const logs = (['error', 'warn', 'log', 'info'] as const).map((level) => vi.spyOn(console, level))
    const post = accountProbe({ fetch, deployment })

    const response = await post(request(body, contentType))

    expect(response.status).toBe(400)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: { code: 'invalid_request', message: 'The request is invalid.' } })
    expect(text).not.toContain('sk-test-planted-3')
    for (const log of logs) expect(log).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not serialize credential-bearing upstream detail', async () => {
    const post = accountProbe({ fetch: async () => new Response('{malformed', { status: 403 }) })
    const response = await post(request({ connection, credential: 'sk-test-transient' }))
    const result = await response.json()

    expect(response.status).toBe(200)
    expect(result).toMatchObject({ status: 'authentication_failed', catalog: [] })
    expect(result).not.toHaveProperty('credential')
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain('sk-test-transient')
  })

  it('does not serialize credential-bearing malformed responses', async () => {
    const post = accountProbe({ fetch: async () => new Response('{malformed') })
    const response = await post(request({ connection, credential: 'sk-test-transient' }))
    const result = await response.json()

    expect(result).toMatchObject({ status: 'invalid_response', catalog: [] })
    expect(result).not.toHaveProperty('credential')
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain('sk-test-transient')
  })

  it('returns provider failures as sanitized completed 200 observations', async () => {
    const post = accountProbe({ fetch: async () => new Response('unauthorized', { status: 403 }) })
    const response = await post(request({ connection: keyless }))
    expect(response.status).toBe(200)
    const result = await response.json()
    expect(result).toMatchObject({ status: 'authentication_failed' })
    expect(result).not.toHaveProperty('upstream')
    expect(JSON.stringify(result)).not.toContain('unauthorized')
  })

  it('runs overlapping probes independently against each immutable draft snapshot', async () => {
    const firstReply = Promise.withResolvers<Response>()
    const secondReply = Promise.withResolvers<Response>()
    const bothStarted = Promise.withResolvers<void>()
    let started = 0
    const fetch = vi.fn((input: string | URL | Request) => {
      started += 1
      if (started === 2) bothStarted.resolve()
      return String(input).includes('second.example') ? secondReply.promise : firstReply.promise
    })
    const post = accountProbe({ fetch })
    const secondConnection: ModelConnection = {
      ...connection,
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Second OpenAI-compatible gateway',
      baseUrl: 'https://second.example/v1',
    }
    const completionOrder: string[] = []

    const firstProbe = post(request({ connection, credential: 'sk-test-first-transient' })).then((response) => {
      completionOrder.push('first')
      return response
    })
    const secondProbe = post(request({ connection: secondConnection, credential: 'sk-test-second-transient' })).then((response) => {
      completionOrder.push('second')
      return response
    })
    await bothStarted.promise

    secondReply.resolve(Response.json({ data: [{ id: 'second-model' }] }))
    const secondText = await (await secondProbe).text()
    expect(JSON.parse(secondText)).toMatchObject({ status: 'connected', catalog: [{ id: 'second-model' }] })
    expect(secondText).not.toContain('sk-test-second-transient')
    expect(completionOrder).toEqual(['second'])

    firstReply.resolve(Response.json({ data: [{ id: 'first-model' }] }))
    const firstText = await (await firstProbe).text()
    expect(JSON.parse(firstText)).toMatchObject({ status: 'connected', catalog: [{ id: 'first-model' }] })
    expect(firstText).not.toContain('sk-test-first-transient')
    expect(completionOrder).toEqual(['second', 'first'])
    expect(fetch).toHaveBeenCalledWith('https://gateway.example/openai/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer sk-test-first-transient' }),
    }))
    expect(fetch).toHaveBeenCalledWith('https://second.example/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer sk-test-second-transient' }),
    }))
  })

  // The issue paths are rewritten from the shared connection-contract check, so
  // they must name the probe payload's `connection`, not a `connections` array.
  it('reports semantic issues against the submitted payload shape', async () => {
    const fetch = vi.fn()
    const post = accountProbe({ fetch })
    const response = await post(request({
      connection: { ...connection, baseUrl: 'https://gateway.example/openai/v1?key=x' },
      credential: 'sk-test-semantic',
    }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_model_config', details: { issues: [{ path: 'connection.baseUrl' }] } },
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a managed connection without hasKey is refused as a semantic issue', async () => {
    const fetch = vi.fn()
    const post = accountProbe({ fetch })
    const response = await post(request({ connection: { ...connection, hasKey: false } }))
    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'invalid_model_config', details: { issues: [{ path: 'connection.hasKey' }] } },
    })
    expect(fetch).not.toHaveBeenCalled()
  })
})
