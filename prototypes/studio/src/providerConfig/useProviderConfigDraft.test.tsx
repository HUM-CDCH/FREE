// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { METHOD_MESSAGES, REFERENCE_ARTICLE, REFERENCE_CATALOG } from 'extraction/extraction-method'
import type { ModelConfig } from '../../shared/modelConfig.contract'
import { STARTING_POINTS, withStartingPoint } from './advancedSettings'
import { useProviderConfigDraft } from './useProviderConfigDraft'

const saved: ModelConfig = {
  connections: [], routes: { schemaSuggestion: null, interaction: null },
  extractionModels: { fields: 'instruct' }, ingestionModels: {},
  extractionSettings: { catalog: { generic: { record_chars: 30000 } } },
}
function draftHook() {
  const hook = renderHook(() => useProviderConfigDraft({
    accountId: 'acct', providers: [], scheduleProbe: vi.fn(), cancelProbe: vi.fn(), disposeProbe: vi.fn(),
  }))
  act(() => hook.result.current.initialize(saved))
  return hook
}

describe('the Advanced draft', () => {
  it('Customize creates the explicit reference; Use service defaults removes only that strategy', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    expect(result.current.draft?.extractionSettings.article).toEqual(REFERENCE_ARTICLE)
    expect(result.current.dirty).toBe(true)
    act(() => result.current.useServiceDefaults('catalog'))
    expect(result.current.draft?.extractionSettings).toEqual({ article: REFERENCE_ARTICLE })
    expect(result.current.draft?.extractionModels).toEqual({ fields: 'instruct' })
    act(() => result.current.useServiceDefaults('article'))
    act(() => result.current.customize('catalog'))
    expect(result.current.draft?.extractionSettings).toEqual({ catalog: REFERENCE_CATALOG })
  })

  it('an optional factor switched off and on again, or a number edited back, is not an unsaved change', () => {
    const { result } = draftHook()
    act(() => result.current.initialize({ ...saved, extractionSettings: { article: { ...REFERENCE_ARTICLE, grounding: 'spans', evidence_policy: 'schema' } } }))
    act(() => result.current.setArticle('evidence_policy', undefined))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setArticle('evidence_policy', 'schema'))
    expect(result.current.dirty).toBe(false)
    act(() => result.current.setNumber('article.context_tokens', '16384'))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setNumber('article.context_tokens', '12288'))
    expect(result.current.dirty).toBe(false)
  })

  it('a strategy removed and customized again is not an unsaved change: the saved key order is kept', () => {
    const { result } = draftHook()
    act(() => result.current.initialize({ ...saved, extractionSettings: { article: REFERENCE_ARTICLE, catalog: REFERENCE_CATALOG } }))
    act(() => result.current.useServiceDefaults('article'))
    act(() => result.current.customize('article'))
    expect(result.current.dirty).toBe(false)
  })

  it('a Catalog edit returned to the value shown for a saved omission omits it again', () => {
    const { result } = draftHook()
    act(() => result.current.setCatalogFactor('glossary', false))
    expect(result.current.draft?.extractionSettings.catalog?.recipe?.factors?.glossary).toBe(false)
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setCatalogFactor('glossary', true))
    expect(result.current.draft).toEqual(saved)
    expect(result.current.dirty).toBe(false)
    act(() => result.current.setNumber('catalog.generic.discovery_chars', '48001'))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setNumber('catalog.generic.discovery_chars', '48000'))
    act(() => result.current.setNumber('catalog.recipe.input_tokens', '5000'))
    act(() => result.current.setNumber('catalog.recipe.input_tokens', '4096'))
    expect(result.current.draft).toEqual(saved)
    expect(result.current.dirty).toBe(false)
    // A value the saved override sets stays explicit, even at the service default.
    act(() => result.current.setNumber('catalog.generic.record_chars', '24000'))
    expect(result.current.draft?.extractionSettings.catalog).toEqual({ generic: { record_chars: 24000 } })
    expect(result.current.dirty).toBe(true)
  })

  it('a customized Catalog keeps its explicit reference values through a toggle back', () => {
    const { result } = draftHook()
    act(() => result.current.initialize({ ...saved, extractionSettings: {} }))
    act(() => result.current.customize('catalog'))
    act(() => result.current.setCatalogFactor('headings', false))
    act(() => result.current.setCatalogFactor('headings', true))
    act(() => result.current.setNumber('catalog.recipe.output_tokens', '1024'))
    expect(result.current.draft?.extractionSettings.catalog).toEqual(REFERENCE_CATALOG)
  })

  it('a parent change keeps an incompatible child and reports it; switching back resolves it', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('context', 'bounded'))
    act(() => result.current.setArticle('overlap_passages', 1))
    act(() => result.current.setArticle('context', 'full'))
    expect(result.current.draft?.extractionSettings.article?.overlap_passages).toBe(1)
    expect(result.current.settingsIssues).toEqual([{ path: 'article.overlap_passages', message: METHOD_MESSAGES.bounded }])
    act(() => result.current.setArticle('context', 'bounded'))
    expect(result.current.settingsIssues).toEqual([])
  })

  it('a Catalog shape issue does not hide an Article cross-field issue', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('context', 'bounded'))
    act(() => result.current.setArticle('overlap_passages', 1))
    act(() => result.current.setArticle('context', 'full'))
    act(() => result.current.setNumber('catalog.generic.discovery_chars', '999'))
    expect(result.current.settingsIssues).toEqual([
      { path: 'article.overlap_passages', message: METHOD_MESSAGES.bounded },
      { path: 'catalog.generic.discovery_chars', message: METHOD_MESSAGES.characters },
    ])
  })

  it('number text is never clamped: invalid text is kept, reported and blocks; Discard clears it', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('context', 'bounded'))
    for (const text of ['8191', '12288.5', '12,288', '', 'abc']) {
      act(() => result.current.setNumber('article.context_tokens', text))
      expect(result.current.settingsIssues).toContainEqual({ path: 'article.context_tokens', message: METHOD_MESSAGES.contextTokens })
    }
    expect(result.current.numberEdits['article.context_tokens']).toBe('abc')
    act(() => result.current.setNumber('article.context_tokens', '16384'))
    expect(result.current.draft?.extractionSettings.article?.context_tokens).toBe(16384)
    expect(result.current.numberEdits).toEqual({})
    act(() => result.current.setNumber('catalog.recipe.output_tokens', '12'))
    act(() => result.current.discard())
    expect(result.current.numberEdits).toEqual({})
    expect(result.current.draft).toEqual(saved)
  })

  it('identity fields are trimmed, exact-case, unique and non-empty', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    let refused: string | null = null
    act(() => { refused = result.current.addIdentityField('  Species ') })
    expect(refused).toBeNull()
    act(() => { refused = result.current.addIdentityField('Species') })
    expect(refused).toBe(METHOD_MESSAGES.identityNames)
    act(() => { refused = result.current.addIdentityField('   ') })
    expect(refused).toBe(METHOD_MESSAGES.identityNames)
    expect(result.current.draft?.extractionSettings.article?.identity_fields).toEqual(['Species'])
    act(() => result.current.setArticle('identity', 'conservative'))
    act(() => result.current.removeIdentityField('Species'))
    expect(result.current.settingsIssues).toEqual([{ path: 'article.identity_fields', message: METHOD_MESSAGES.identity }])
  })

  it('replaceArticle replaces the Article number text too; Undo with the prior edits restores it exactly', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('context', 'bounded'))
    act(() => result.current.setNumber('article.context_tokens', 'abc'))
    act(() => result.current.setNumber('catalog.recipe.output_tokens', 'x'))
    const prior = result.current.draft!.extractionSettings.article
    const priorEdits = result.current.numberEdits
    act(() => result.current.replaceArticle(withStartingPoint(prior, STARTING_POINTS[1]!)))
    expect(result.current.numberEdits).toEqual({ 'catalog.recipe.output_tokens': 'x' })
    expect(result.current.settingsIssues.filter((issue) => issue.path.startsWith('article.'))).toEqual([])
    act(() => result.current.replaceArticle(prior, priorEdits))
    expect(result.current.draft?.extractionSettings.article).toEqual(prior)
    expect(result.current.numberEdits).toEqual({ 'article.context_tokens': 'abc', 'catalog.recipe.output_tokens': 'x' })
    expect(result.current.settingsIssues).toContainEqual({ path: 'article.context_tokens', message: METHOD_MESSAGES.contextTokens })
    act(() => result.current.replaceArticle(undefined))
    expect(result.current.numberEdits).toEqual({ 'catalog.recipe.output_tokens': 'x' })
    expect(result.current.settingsIssues.filter((issue) => issue.path.startsWith('article.'))).toEqual([])
  })

  it('replaceArticle restores a prior draft exactly, including an invalid one', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('overlap_passages', 2))
    const prior = result.current.draft!.extractionSettings.article
    act(() => result.current.replaceArticle({ ...REFERENCE_ARTICLE, grounding: 'quoted' }))
    act(() => result.current.replaceArticle(prior))
    expect(result.current.draft?.extractionSettings.article).toEqual(prior)
    act(() => result.current.replaceArticle(undefined))
    expect(result.current.draft?.extractionSettings.article).toBeUndefined()
  })
})
