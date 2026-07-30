import { describe, expect, it } from 'vitest'
import { unwrapArticleResult } from './useExtraction'

describe('unwrapArticleResult', () => {
  it('unwraps a singleton records array for article strategy', () => {
    const result = { records: [{ title: 'Report', author: 'Anna' }] }
    const evidence = { records: [{ title: { value: 'Report', snippet: 'Report' } }] }

    expect(unwrapArticleResult('article', result, evidence)).toEqual({
      result: { title: 'Report', author: 'Anna' },
      evidence: { title: { value: 'Report', snippet: 'Report' } },
    })
  })

  it('unwraps evidence to null when evidence has no records array', () => {
    const result = { records: [{ title: 'Report' }] }

    expect(unwrapArticleResult('article', result, null)).toEqual({
      result: { title: 'Report' },
      evidence: null,
    })
  })

  it('leaves catalog strategy results unchanged regardless of shape', () => {
    const result = { records: [{ grave: '8' }, { grave: '13' }] }
    const evidence = { records: [{ grave: { value: '8', snippet: '8' } }] }

    expect(unwrapArticleResult('catalog', result, evidence)).toEqual({ result, evidence })
  })

  it('falls back to the original value when records is missing', () => {
    const result = { title: 'Report' }

    expect(unwrapArticleResult('article', result, null)).toEqual({ result, evidence: null })
  })

  it('falls back to the original value when records is an empty array', () => {
    const result = { records: [] }

    expect(unwrapArticleResult('article', result, null)).toEqual({ result, evidence: null })
  })

  it('falls back to the original value when result is not a record', () => {
    expect(unwrapArticleResult('article', null, null)).toEqual({ result: null, evidence: null })
    expect(unwrapArticleResult('article', ['a', 'b'], null)).toEqual({ result: ['a', 'b'], evidence: null })
  })
})
