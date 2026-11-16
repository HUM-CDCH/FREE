// @vitest-environment jsdom
import { articleSettingsSchema } from 'extraction/extraction-method'
const UNWINDOWED_ARTICLE = articleSettingsSchema.parse({})
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { canonicalArticle, METHOD_MESSAGES, REFERENCE_ARTICLE, REFERENCE_CATALOG } from 'extraction/extraction-method'
import type { ModelConfig } from '../../shared/modelConfig.contract'
import { STARTING_POINTS, withStartingPoint } from './advancedSettings'
import { useProviderConfigDraft } from './useProviderConfigDraft'

const saved: ModelConfig = {
  connections: [], routes: { schemaSuggestion: null, interaction: null },
  extractionModels: { fields: 'instruct' }, ingestionModels: {},
  extractionSettings: { catalog: { unified: { input_tokens: 30000 } } },
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
    expect(result.current.draft?.extractionSettings).toEqual({ catalog: { unified: {} } })
  })

  it('an inactive context ceiling left behind by full source is not an unsaved change: Apply would store the saved value', () => {
    const { result } = draftHook()
    act(() => result.current.initialize({ ...saved, extractionSettings: { article: UNWINDOWED_ARTICLE } }))
    act(() => result.current.setArticle('context', 'bounded'))
    act(() => result.current.setNumber('article.context_tokens', '9000'))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setArticle('context', 'full'))
    expect(result.current.draft?.extractionSettings.article?.context_tokens).toBe(9000)
    expect(result.current.dirty).toBe(false)
  })

  it('an optional factor switched off and on again, or a number edited back, is not an unsaved change', () => {
    const { result } = draftHook()
    // Saved documents are canonical: `ArticleOptions` key order.
    act(() => result.current.initialize({ ...saved, extractionSettings: { article: canonicalArticle({ ...REFERENCE_ARTICLE, grounding: 'spans', evidence_policy: 'schema' }) } }))
    act(() => result.current.setArticle('evidence_policy', undefined))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setArticle('evidence_policy', 'schema'))
    expect(result.current.dirty).toBe(false)
    // The ceiling is editable only with bounded source units.
    act(() => result.current.initialize({ ...saved, extractionSettings: { article: { ...REFERENCE_ARTICLE, context: 'bounded' } } }))
    act(() => result.current.setNumber('article.context_tokens', '16384'))
    expect(result.current.dirty).toBe(true)
    act(() => result.current.setNumber('article.context_tokens', '12288'))
    expect(result.current.dirty).toBe(false)
  })

  it('a strategy removed and customized again is not an unsaved change: the saved key order is kept', () => {
    const { result } = draftHook()
    act(() => result.current.initialize({ ...saved, extractionSettings: { article: REFERENCE_ARTICLE, catalog: { unified: {} } } }))
    act(() => result.current.useServiceDefaults('article'))
    act(() => result.current.customize('article'))
    expect(result.current.dirty).toBe(false)
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

  it('verification turned off from the defaults is valid at once: their large checks need it and go with it', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('grounding', 'off'))
    expect(result.current.draft?.extractionSettings.article).toEqual({ ...UNWINDOWED_ARTICLE, grounding: 'off' })
    expect(result.current.settingsIssues).toEqual([])
  })

  it('a Catalog shape issue does not hide an Article cross-field issue', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('context', 'bounded'))
    act(() => result.current.setArticle('overlap_passages', 1))
    act(() => result.current.setArticle('context', 'full'))
    act(() => result.current.setNumber('catalog.unified.input_tokens', '511'))
    expect(result.current.settingsIssues).toEqual([
      { path: 'article.overlap_passages', message: METHOD_MESSAGES.bounded },
      { path: 'catalog.unified.input_tokens', message: METHOD_MESSAGES.inputTokens },
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
    act(() => result.current.setNumber('catalog.unified.output_tokens', '12'))
    act(() => result.current.discard())
    expect(result.current.numberEdits).toEqual({})
    expect(result.current.draft).toEqual(saved)
  })

  it('replaceArticle replaces the Article number text too; Undo with the prior edits restores it exactly', () => {
    const { result } = draftHook()
    act(() => result.current.customize('article'))
    act(() => result.current.setArticle('context', 'bounded'))
    act(() => result.current.setNumber('article.context_tokens', 'abc'))
    act(() => result.current.setNumber('catalog.unified.output_tokens', 'x'))
    const prior = result.current.draft!.extractionSettings.article
    const priorEdits = result.current.numberEdits
    act(() => result.current.replaceArticle(withStartingPoint(prior, STARTING_POINTS[1]!)))
    expect(result.current.numberEdits).toEqual({ 'catalog.unified.output_tokens': 'x' })
    expect(result.current.settingsIssues.filter((issue) => issue.path.startsWith('article.'))).toEqual([])
    act(() => result.current.replaceArticle(prior, priorEdits))
    expect(result.current.draft?.extractionSettings.article).toEqual(prior)
    expect(result.current.numberEdits).toEqual({ 'article.context_tokens': 'abc', 'catalog.unified.output_tokens': 'x' })
    expect(result.current.settingsIssues).toContainEqual({ path: 'article.context_tokens', message: METHOD_MESSAGES.contextTokens })
    act(() => result.current.replaceArticle(undefined))
    expect(result.current.numberEdits).toEqual({ 'catalog.unified.output_tokens': 'x' })
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
