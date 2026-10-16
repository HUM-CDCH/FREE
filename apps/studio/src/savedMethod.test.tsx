// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BOUNDED_ARTICLE, REFERENCE_ARTICLE } from 'extraction/extraction-method'
import { savedMethodFor, useSavedMethod } from './savedMethod'
import { putModelConfig } from './providerConfig/providerConfig.data'

const config = {
  connections: [], routes: { schemaSuggestion: null, interaction: null },
  extractionModels: { reasoning: 'instruct' }, ingestionModels: {},
  extractionSettings: { article: REFERENCE_ARTICLE, catalog: { generic: { record_chars: 30000 } } },
}
afterEach(() => vi.unstubAllGlobals())

it('derives each strategy\'s method from the saved document', () => {
  expect(savedMethodFor({ config }, 'ARTICLE', null)).toEqual({ models: { reasoning: 'instruct' }, settings: { article: REFERENCE_ARTICLE } })
  expect(savedMethodFor({ config }, 'CATALOG', null)).toEqual({ models: { reasoning: 'instruct' }, settings: { generic: { record_chars: 30000 } } })
  expect(savedMethodFor({ config }, 'CATALOG', 'numbered-catalogue-de@1')).toEqual({ models: { reasoning: 'instruct' }, settings: { recipe: null } })
})

it('pins the deployment Article default only when the saved account has no override', () => {
  const omitted = { ...config, extractionSettings: {} }
  expect(savedMethodFor({ config: omitted }, 'ARTICLE', null).settings).toEqual({ article: null })
  expect(savedMethodFor({ config: omitted, boundedArticle: true }, 'ARTICLE', null).settings).toEqual({ article: BOUNDED_ARTICLE })
  for (const article of [REFERENCE_ARTICLE, { ...BOUNDED_ARTICLE, context_tokens: 8192, overlap_passages: 1 }])
    expect(savedMethodFor({ config: { ...omitted, extractionSettings: { article } }, boundedArticle: true }, 'ARTICLE', null).settings)
      .toEqual({ article })
  expect(savedMethodFor({ config: omitted, boundedArticle: true }, 'CATALOG', null).settings).toEqual({ generic: null })
})

it('derives the unified Catalog method, and no recipe, where the deployment enables it', () => {
  const unified = { config: { ...config, extractionSettings: { catalog: { unified: { overlap: 0 } } } }, unifiedCatalog: true }
  expect(savedMethodFor(unified, 'CATALOG', 'numbered-catalogue-de@1'))
    .toEqual({ models: { reasoning: 'instruct' }, settings: { unified: { defaults: 4, overlap: 0 } } })
})

it('keeps the deployment\'s Catalog method with the saved document it read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ config, providers: [],
    deployment: { connections: [], defaultRoute: null, unifiedCatalog: true } }), { headers: { 'content-type': 'application/json' } })))
  const { result } = renderHook(() => useSavedMethod())
  await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config, unifiedCatalog: true }))
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

it('retains both deployment gates when Apply supersedes an in-flight refresh', async () => {
  const applied = { ...config, extractionSettings: {} }
  const slow = Promise.withResolvers<Response>()
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ config, providers: [],
      deployment: { connections: [], defaultRoute: null, unifiedCatalog: true, boundedArticle: true } })))
    .mockImplementationOnce(() => slow.promise)
    .mockResolvedValueOnce(new Response(JSON.stringify({ config: applied })))
  vi.stubGlobal('fetch', fetch)
  const { result } = renderHook(() => useSavedMethod())
  await waitFor(() => expect(result.current.state.status).toBe('ready'))
  let refreshing!: Promise<unknown>
  act(() => { refreshing = result.current.refresh() })
  expect(result.current.state.status).toBe('loading')
  await act(async () => { await putModelConfig(applied) })
  expect(result.current.state).toEqual({ status: 'ready', config: applied, unifiedCatalog: true, boundedArticle: true })
  if (result.current.state.status === 'ready')
    expect(savedMethodFor(result.current.state, 'ARTICLE', null).settings).toEqual({ article: BOUNDED_ARTICLE })
  await act(async () => {
    slow.resolve(new Response(JSON.stringify({ config, providers: [], deployment: { connections: [], defaultRoute: null } })))
    await refreshing
  })
  expect(result.current.state).toEqual({ status: 'ready', config: applied, unifiedCatalog: true, boundedArticle: true })
})

it('does not guess full defaults if Apply arrives before the first deployment read', async () => {
  const applied = { ...config, extractionSettings: {} }
  const first = Promise.withResolvers<Response>()
  const refreshed = Promise.withResolvers<Response>()
  let reads = 0
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PUT') return Promise.resolve(new Response(JSON.stringify({ config: applied })))
    reads += 1
    return reads === 1 ? first.promise : refreshed.promise
  }))
  const { result } = renderHook(() => useSavedMethod())
  await waitFor(() => expect(reads).toBe(1))
  await act(async () => { await putModelConfig(applied) })
  expect(result.current.state.status).toBe('loading')
  expect(reads).toBe(2)
  await act(async () => {
    refreshed.resolve(new Response(JSON.stringify({ config: applied, providers: [],
      deployment: { connections: [], defaultRoute: null, boundedArticle: true } })))
  })
  await waitFor(() => expect(result.current.state).toEqual({ status: 'ready', config: applied, boundedArticle: true }))
  await act(async () => {
    first.resolve(new Response(JSON.stringify({ config, providers: [], deployment: { connections: [], defaultRoute: null } })))
  })
  expect(result.current.state).toEqual({ status: 'ready', config: applied, boundedArticle: true })
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
