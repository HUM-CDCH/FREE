// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelKeysRequestSchema } from '../../shared/modelKeys.contract'
import { saveModelKey } from './modelKeyStore'

const request = vi.hoisted(() => vi.fn<(input: string, init?: RequestInit) => Promise<Response>>())
vi.mock('../auth/authenticatedFetch', () => ({
  authenticatedFetch: (input: string, init?: RequestInit) => request(input, init),
}))

const ACCOUNT = '10000000-0000-4000-8000-000000000001'
const ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'
const REMOVED_ID = '33333333-3333-4333-8333-333333333333'
const connection = { id: ID, provider: 'openai-compatible', baseUrl: 'https://a.example/v1' } as const

let sendModelKeys: typeof import('./modelKeyHandoff').sendModelKeys
let setModelKeyAccount: typeof import('./modelKeyHandoff').setModelKeyAccount
let ensureModelKeysSent: typeof import('./modelKeyHandoff').ensureModelKeysSent

beforeEach(async () => {
  // The handoff keeps its pending removals and in-flight request in module state; each test gets a fresh module.
  vi.resetModules()
  ;({ sendModelKeys, setModelKeyAccount, ensureModelKeysSent } = await import('./modelKeyHandoff'))
  request.mockReset()
  request.mockImplementation(async () => Response.json({ accepted: [] }))
})

afterEach(() => {
  localStorage.clear()
})

function sentBody(call: number) {
  const [input, init] = request.mock.calls[call]!
  expect(input).toBe('/api/model-keys')
  expect(init).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/json' } })
  return modelKeysRequestSchema.parse(JSON.parse(String(init!.body)))
}

describe('sendModelKeys', () => {
  it('sends every stored key with its address, and null for each removed ID', async () => {
    saveModelKey(ACCOUNT, connection, 'sk-test-first')
    saveModelKey(ACCOUNT, { ...connection, id: SECOND_ID, provider: 'vllm', baseUrl: 'http://vllm:8000/v1' }, 'sk-test-second')

    await sendModelKeys(ACCOUNT, [REMOVED_ID])

    expect(request).toHaveBeenCalledOnce()
    expect(sentBody(0)).toEqual({
      account: ACCOUNT,
      keys: {
        [ID]: { provider: 'openai-compatible', baseUrl: 'https://a.example/v1', key: 'sk-test-first' },
        [SECOND_ID]: { provider: 'vllm', baseUrl: 'http://vllm:8000/v1', key: 'sk-test-second' },
        [REMOVED_ID]: null,
      },
    })
  })

  it('sends nothing when the account has no keys and nothing was removed', async () => {
    await sendModelKeys(ACCOUNT)

    expect(request).not.toHaveBeenCalled()
  })

  it('concurrent calls share one request and a call during it sends once more afterwards', async () => {
    saveModelKey(ACCOUNT, connection, 'sk-test-first')
    const first = Promise.withResolvers<Response>()
    request.mockImplementationOnce(() => first.promise)

    const running = sendModelKeys(ACCOUNT)
    saveModelKey(ACCOUNT, { ...connection, id: SECOND_ID }, 'sk-test-second')
    const during = sendModelKeys(ACCOUNT, [REMOVED_ID])
    const alsoDuring = sendModelKeys(ACCOUNT)
    expect(request).toHaveBeenCalledOnce()
    expect(alsoDuring).toBe(during)

    first.resolve(Response.json({ accepted: [ID] }))
    await Promise.all([running, during, alsoDuring])

    expect(request).toHaveBeenCalledTimes(2)
    expect(Object.keys(sentBody(0).keys)).toEqual([ID])
    expect(sentBody(1).keys).toEqual({
      [REMOVED_ID]: null,
      [ID]: expect.objectContaining({ key: 'sk-test-first' }),
      [SECOND_ID]: expect.objectContaining({ key: 'sk-test-second' }),
    })
  })

  it('a failed request resolves, and its removals are sent with the next call', async () => {
    request.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(sendModelKeys(ACCOUNT, [REMOVED_ID])).resolves.toBeUndefined()

    request.mockResolvedValueOnce(Response.json({ error: { code: 'unexpected_failure' } }, { status: 500 }))
    await expect(sendModelKeys(ACCOUNT)).resolves.toBeUndefined()

    await sendModelKeys(ACCOUNT)
    await sendModelKeys(ACCOUNT)

    expect(request).toHaveBeenCalledTimes(3)
    for (const call of [0, 1, 2]) expect(sentBody(call).keys).toEqual({ [REMOVED_ID]: null })
  })
})

describe('ensureModelKeysSent', () => {
  it('ensureModelKeysSent does nothing before an account is set', async () => {
    saveModelKey(ACCOUNT, connection, 'sk-test-ensure')

    await expect(ensureModelKeysSent()).resolves.toBeUndefined()
    expect(request).not.toHaveBeenCalled()

    setModelKeyAccount(ACCOUNT)
    await ensureModelKeysSent()
    expect(request).toHaveBeenCalledOnce()
    expect(sentBody(0).account).toBe(ACCOUNT)

    setModelKeyAccount(null)
    await ensureModelKeysSent()
    expect(request).toHaveBeenCalledOnce()
  })

  it('resolves only once the handoff has answered', async () => {
    saveModelKey(ACCOUNT, connection, 'sk-test-ensure')
    setModelKeyAccount(ACCOUNT)
    const answer = Promise.withResolvers<Response>()
    request.mockImplementationOnce(() => answer.promise)
    let settled = false

    const sent = ensureModelKeysSent().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    answer.resolve(Response.json({ accepted: [ID] }))
    await sent
    expect(settled).toBe(true)
  })
})
