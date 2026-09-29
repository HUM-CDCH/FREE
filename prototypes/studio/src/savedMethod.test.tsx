// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
import { savedMethodFor, useSavedMethod } from './savedMethod'
import { putModelConfig } from './providerConfig/providerConfig.data'

const config = {
  connections: [], routes: { schemaSuggestion: null, interaction: null },
  extractionModels: { reasoning: 'instruct' }, ingestionModels: {},
  extractionSettings: { article: REFERENCE_ARTICLE, catalog: { generic: { record_chars: 30000 } } },
}
afterEach(() => vi.unstubAllGlobals())

it('derives each strategy\'s method from the saved document', () => {
  expect(savedMethodFor(config, 'ARTICLE', null)).toEqual({ models: { reasoning: 'instruct' }, settings: { article: REFERENCE_ARTICLE } })
  expect(savedMethodFor(config, 'CATALOG', null)).toEqual({ models: { reasoning: 'instruct' }, settings: { generic: { record_chars: 30000 } } })
  expect(savedMethodFor(config, 'CATALOG', 'numbered-catalogue-de@1')).toEqual({ models: { reasoning: 'instruct' }, settings: { recipe: null } })
})

it('reads the account configuration on mount and again on refresh', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ config, providers: [], deployment: { connections: [], defaultRoute: null } }),
    { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useSavedMethod())
  await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config }))
  await result.current.refresh()
  expect(fetch).toHaveBeenCalledTimes(2)
})

it('adopts the document an Apply saves, without reading again, so the next start submits it', async () => {
  const applied = { ...config, extractionModels: { fields: 'nuextract' }, extractionSettings: {} }
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => new Response(
    JSON.stringify(init?.method === 'PUT' ? { config: applied } : { config, providers: [], deployment: { connections: [], defaultRoute: null } }),
    { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useSavedMethod())
  await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config }))
  await putModelConfig(applied)
  await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config: applied }))
  expect(fetch.mock.calls.filter(([, init]) => init?.method !== 'PUT')).toHaveLength(1)
})

it('an unreadable configuration is an error state that a refresh can recover from', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'persistence_unavailable', message: 'Unavailable.' } }),
      { status: 503, headers: { 'content-type': 'application/json' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ config, providers: [], deployment: { connections: [], defaultRoute: null } }),
      { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useSavedMethod())
  await waitFor(() => expect(result.current.state.status).toBe('error'))
  await result.current.refresh()
  await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config }))
})

it('an older read that answers late never replaces a newer one', async () => {
  const older = { ...config, extractionModels: { fields: 'older' } }
  const slow = Promise.withResolvers<Response>()
  const fetch = vi.fn()
    .mockImplementationOnce((_input: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => slow.reject(new DOMException('Aborted', 'AbortError')))
      return slow.promise
    })
    .mockResolvedValueOnce(new Response(JSON.stringify({ config, providers: [], deployment: { connections: [], defaultRoute: null } }),
      { headers: { 'content-type': 'application/json' } }))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useSavedMethod())
  await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
  await result.current.refresh()
  await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config }))
  slow.resolve(new Response(JSON.stringify({ config: older, providers: [], deployment: { connections: [], defaultRoute: null } }),
    { headers: { 'content-type': 'application/json' } }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(result.current.state).toEqual({ status: 'ready', config })
})
