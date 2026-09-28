// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { REFERENCE_ARTICLE } from 'extraction/extraction-method'
import { savedMethodFor, useSavedMethod } from './savedMethod'

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
