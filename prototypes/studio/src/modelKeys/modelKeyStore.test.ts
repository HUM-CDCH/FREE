// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelConnection } from '../../shared/modelConfig.contract'
import {
  clearModelKeys,
  modelKeyFor,
  removeModelKey,
  retainModelKeys,
  saveModelKey,
  storedModelKeys,
} from './modelKeyStore'

const ACCOUNT = '10000000-0000-4000-8000-000000000001'
const OTHER_ACCOUNT = '10000000-0000-4000-8000-000000000002'
const ID = '11111111-1111-4111-8111-111111111111'
const BASE_A = 'https://a.example/v1'
const BASE_B = 'https://b.example/v1'
const KEY = 'sk-test-store'

const connection: Pick<ModelConnection, 'id' | 'provider' | 'baseUrl'> = {
  id: ID,
  provider: 'openai-compatible',
  baseUrl: BASE_A,
}

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('model key store', () => {
  it('keys are kept per account under free.modelKeys.v1:<account>', () => {
    saveModelKey(ACCOUNT, connection, KEY)

    expect(JSON.parse(localStorage.getItem(`free.modelKeys.v1:${ACCOUNT}`)!)).toEqual({
      [ID]: { provider: 'openai-compatible', baseUrl: BASE_A, key: KEY },
    })
    expect(localStorage.getItem(`free.modelKeys.v1:${OTHER_ACCOUNT}`)).toBeNull()
    expect(storedModelKeys(ACCOUNT)).toEqual({ [ID]: { provider: 'openai-compatible', baseUrl: BASE_A, key: KEY } })
    expect(storedModelKeys(OTHER_ACCOUNT)).toEqual({})

    removeModelKey(ACCOUNT, ID)
    expect(localStorage.getItem(`free.modelKeys.v1:${ACCOUNT}`)).toBeNull()
  })

  it("a key is returned only for the connection's current provider and base", () => {
    saveModelKey(ACCOUNT, connection, KEY)

    expect(modelKeyFor(ACCOUNT, connection)).toBe(KEY)
    expect(modelKeyFor(ACCOUNT, { ...connection, baseUrl: BASE_B })).toBeNull()
    expect(modelKeyFor(ACCOUNT, { ...connection, provider: 'vllm' })).toBeNull()
    expect(modelKeyFor(OTHER_ACCOUNT, connection)).toBeNull()
  })

  it('retain drops keys of removed, re-addressed and keyless connections and returns their IDs', () => {
    const ids = {
      kept: '30000000-0000-4000-8000-000000000001',
      removed: '30000000-0000-4000-8000-000000000002',
      rebased: '30000000-0000-4000-8000-000000000003',
      reprovided: '30000000-0000-4000-8000-000000000004',
      keyless: '30000000-0000-4000-8000-000000000005',
    }
    for (const id of Object.values(ids)) saveModelKey(ACCOUNT, { ...connection, id }, `sk-test-${id}`)
    saveModelKey(OTHER_ACCOUNT, { ...connection, id: ids.removed }, 'sk-test-other')

    const dropped = retainModelKeys(ACCOUNT, [
      { ...connection, id: ids.kept, hasKey: true },
      { ...connection, id: ids.rebased, baseUrl: BASE_B, hasKey: true },
      { ...connection, id: ids.reprovided, provider: 'vllm', hasKey: true },
      { ...connection, id: ids.keyless, hasKey: false },
    ])

    expect(dropped.sort()).toEqual([ids.removed, ids.rebased, ids.reprovided, ids.keyless].sort())
    expect(Object.keys(storedModelKeys(ACCOUNT))).toEqual([ids.kept])
    expect(modelKeyFor(OTHER_ACCOUNT, { ...connection, id: ids.removed })).toBe('sk-test-other')
    expect(retainModelKeys(ACCOUNT, [{ ...connection, id: ids.kept, hasKey: true }])).toEqual([])
  })

  it('unreadable storage reads as no keys', () => {
    localStorage.setItem(`free.modelKeys.v1:${ACCOUNT}`, '{not json')
    expect(storedModelKeys(ACCOUNT)).toEqual({})
    expect(modelKeyFor(ACCOUNT, connection)).toBeNull()
    localStorage.setItem(`free.modelKeys.v1:${ACCOUNT}`, JSON.stringify({ [ID]: { provider: 'unknown', key: KEY } }))
    expect(storedModelKeys(ACCOUNT)).toEqual({})

    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('Storage is disabled.', 'SecurityError')
    })
    expect(storedModelKeys(ACCOUNT)).toEqual({})
    expect(modelKeyFor(ACCOUNT, connection)).toBeNull()
    expect(() => saveModelKey(ACCOUNT, connection, KEY)).not.toThrow()
    expect(retainModelKeys(ACCOUNT, [])).toEqual([])
    expect(() => clearModelKeys(ACCOUNT)).not.toThrow()
  })

  it("clearModelKeys removes one account's keys and leaves another's", () => {
    saveModelKey(ACCOUNT, connection, KEY)
    saveModelKey(OTHER_ACCOUNT, connection, 'sk-test-other')

    clearModelKeys(ACCOUNT)

    expect(localStorage.getItem(`free.modelKeys.v1:${ACCOUNT}`)).toBeNull()
    expect(modelKeyFor(OTHER_ACCOUNT, connection)).toBe('sk-test-other')
  })
})
