import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelConnection } from '../shared/modelConfig.contract.js'
import { ApiError } from './_http.js'
import {
  MODEL_KEY_WAIT_MS,
  ModelKeyRequiredError,
  createModelKeyCache,
  requireModelKey,
  withStepCancellation,
} from './_model_keys.js'

const stepStatus = vi.hoisted(() => ({ current: undefined as undefined | { cancelSignal: AbortSignal } }))
vi.mock('@dbos-inc/dbos-sdk', () => ({ DBOS: { get stepStatus() { return stepStatus.current } } }))

const ACCOUNT = '10000000-0000-4000-8000-000000000001'
const OTHER_ACCOUNT = '10000000-0000-4000-8000-000000000002'
const ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ID = '22222222-2222-4222-8222-222222222222'
const BASE_A = 'https://a.example/v1'
const BASE_B = 'https://b.example/v1'
const KEY = 'sk-test-cache'

const connection: Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'> = {
  id: ID,
  provider: 'openai-compatible',
  baseUrl: BASE_A,
}
const address = { provider: connection.provider, baseUrl: connection.baseUrl }

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  stepStatus.current = undefined
})

describe('model key cache', () => {
  it('a key sent for one API base is never read for another', () => {
    const cache = createModelKeyCache()
    cache.put(ACCOUNT, ID, address, KEY)

    expect(cache.read(ACCOUNT, connection)).toBe(KEY)
    expect(cache.read(ACCOUNT, { ...connection, baseUrl: BASE_B })).toBeNull()
    expect(cache.read(ACCOUNT, { ...connection, provider: 'vllm' })).toBeNull()
  })

  it("one account never reads another account's key", () => {
    const cache = createModelKeyCache()
    cache.put(ACCOUNT, ID, address, KEY)

    expect(cache.read(OTHER_ACCOUNT, connection)).toBeNull()
  })

  it('remove and forgetAccount drop keys; forgetAccount leaves other accounts alone', () => {
    const cache = createModelKeyCache()
    const second = { ...connection, id: SECOND_ID }
    cache.put(ACCOUNT, ID, address, KEY)
    cache.put(ACCOUNT, SECOND_ID, address, 'sk-test-second')
    cache.put(OTHER_ACCOUNT, ID, address, 'sk-test-other')

    cache.remove(ACCOUNT, ID)
    expect(cache.read(ACCOUNT, connection)).toBeNull()
    expect(cache.read(ACCOUNT, second)).toBe('sk-test-second')

    cache.forgetAccount(ACCOUNT)
    expect(cache.read(ACCOUNT, second)).toBeNull()
    expect(cache.read(OTHER_ACCOUNT, connection)).toBe('sk-test-other')
  })

  it("a handoff begun before the account's sign-out stores nothing after it; other accounts and later handoffs store", () => {
    const cache = createModelKeyCache()
    const before = cache.handoff(ACCOUNT)
    const other = cache.handoff(OTHER_ACCOUNT)

    cache.forgetAccount(ACCOUNT)

    expect(before.put(ID, address, 'sk-test-before-sign-out')).toBe(false)
    expect(cache.read(ACCOUNT, connection)).toBeNull()
    expect(other.put(ID, address, 'sk-test-other')).toBe(true)
    expect(cache.read(OTHER_ACCOUNT, connection)).toBe('sk-test-other')
    const after = cache.handoff(ACCOUNT)
    expect(after.put(ID, address, KEY)).toBe(true)
    expect(cache.read(ACCOUNT, connection)).toBe(KEY)
    // Removal is always safe: it only ever takes a key away.
    before.remove(ID)
    expect(cache.read(ACCOUNT, connection)).toBeNull()
  })

  it('retain drops keys of removed, re-addressed or keyless connections and keeps the rest', () => {
    const cache = createModelKeyCache()
    const ids = {
      kept: '30000000-0000-4000-8000-000000000001',
      removed: '30000000-0000-4000-8000-000000000002',
      rebased: '30000000-0000-4000-8000-000000000003',
      reprovided: '30000000-0000-4000-8000-000000000004',
      keyless: '30000000-0000-4000-8000-000000000005',
    }
    for (const id of Object.values(ids)) cache.put(ACCOUNT, id, address, `sk-test-${id}`)
    cache.put(OTHER_ACCOUNT, ids.removed, address, 'sk-test-other')

    cache.retain(ACCOUNT, [
      { ...connection, id: ids.kept, hasKey: true },
      { ...connection, id: ids.rebased, baseUrl: BASE_B, hasKey: true },
      { ...connection, id: ids.reprovided, provider: 'vllm', hasKey: true },
      { ...connection, id: ids.keyless, hasKey: false },
    ])

    expect(cache.read(ACCOUNT, { ...connection, id: ids.kept })).toBe(`sk-test-${ids.kept}`)
    for (const id of [ids.removed, ids.rebased, ids.reprovided, ids.keyless])
      expect(cache.read(ACCOUNT, { ...connection, id })).toBeNull()
    expect(cache.read(OTHER_ACCOUNT, { ...connection, id: ids.removed })).toBe('sk-test-other')
  })

  it('wait resolves as soon as a matching key arrives', async () => {
    const cache = createModelKeyCache()
    let settled: string | null | undefined
    const waiting = cache.wait(ACCOUNT, connection, undefined).then((key) => (settled = key))

    cache.put(ACCOUNT, ID, { ...address, baseUrl: BASE_B }, 'sk-test-wrong-base')
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBeUndefined()

    cache.put(ACCOUNT, ID, address, KEY)
    await expect(waiting).resolves.toBe(KEY)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wait resolves null after the wait and leaves no timer or listener behind', async () => {
    const cache = createModelKeyCache()
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    let settled: string | null | undefined
    const waiting = cache.wait(ACCOUNT, connection, controller.signal).then((key) => (settled = key))

    await vi.advanceTimersByTimeAsync(MODEL_KEY_WAIT_MS - 1)
    expect(settled).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)

    await expect(waiting).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(add).toHaveBeenCalledTimes(1)
    expect(add.mock.calls[0]![0]).toBe('abort')
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1])
    // A key arriving later wakes nobody and changes nothing for the finished wait.
    cache.put(ACCOUNT, ID, address, KEY)
    expect(settled).toBeNull()
  })

  it('wait rejects with the abort reason before any key arrives, and immediately when already aborted', async () => {
    const cache = createModelKeyCache()
    const controller = new AbortController()
    const reason = new Error('cancelled')
    const waiting = cache.wait(ACCOUNT, connection, controller.signal)

    controller.abort(reason)
    await expect(waiting).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)

    cache.put(ACCOUNT, ID, address, KEY)
    await expect(cache.wait(ACCOUNT, connection, controller.signal)).rejects.toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('requireModelKey throws model_key_required, 409, isRetryable false, with a message naming no key or connection', async () => {
    const cache = createModelKeyCache()
    cache.put(ACCOUNT, ID, { ...address, baseUrl: BASE_B }, KEY)
    const required = requireModelKey(cache, ACCOUNT, connection, undefined, 10).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(10)
    const error = await required

    expect(error).toBeInstanceOf(ModelKeyRequiredError)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({ status: 409, code: 'model_key_required', isRetryable: false })
    const message = (error as Error).message
    for (const secret of [KEY, ID, BASE_A, BASE_B]) expect(message).not.toContain(secret)
  })

  it('requireModelKey returns a held key without waiting', async () => {
    const cache = createModelKeyCache()
    cache.put(ACCOUNT, ID, address, KEY)

    await expect(requireModelKey(cache, ACCOUNT, connection, undefined)).resolves.toBe(KEY)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("withStepCancellation returns the call signal unchanged outside a step, the step's cancel signal alone without a call signal, and both composed inside a step", () => {
    const call = new AbortController()
    const cancel = new AbortController()
    expect(withStepCancellation(undefined, undefined)).toBeUndefined()
    expect(withStepCancellation(call.signal, undefined)).toBe(call.signal)
    expect(withStepCancellation(undefined, cancel.signal)).toBe(cancel.signal)

    const byCall = withStepCancellation(call.signal, cancel.signal)!
    expect(byCall).not.toBe(call.signal)
    expect(byCall.aborted).toBe(false)
    call.abort(new Error('client'))
    expect(byCall.aborted).toBe(true)
    expect(byCall.reason).toEqual(new Error('client'))
    expect(cancel.signal.aborted).toBe(false)

    const other = new AbortController()
    const byCancel = withStepCancellation(other.signal, cancel.signal)!
    cancel.abort(new Error('cancelled'))
    expect(byCancel.aborted).toBe(true)
    expect(byCancel.reason).toEqual(new Error('cancelled'))
    expect(other.signal.aborted).toBe(false)
  })

  it("requireModelKey ends the wait when the step's cancel signal fires, and returns no key after it", async () => {
    const cache = createModelKeyCache()
    const controller = new AbortController()
    stepStatus.current = { cancelSignal: controller.signal }
    const required = requireModelKey(cache, ACCOUNT, connection, undefined, 60_000).catch((error: unknown) => error)

    await vi.advanceTimersByTimeAsync(5)
    const reason = new Error('workflow cancelled')
    controller.abort(reason)

    expect(await required).toBe(reason)
    cache.put(ACCOUNT, ID, address, KEY)
    await vi.advanceTimersByTimeAsync(5)
    expect(await required).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)
  })
})
