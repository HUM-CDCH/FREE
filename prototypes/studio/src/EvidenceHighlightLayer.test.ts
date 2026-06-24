import { describe, expect, it } from 'vitest'
import { buildHighlights } from './evidenceHighlights'

describe('buildHighlights', () => {
  it('falls back to direct result search for leaves without evidence', () => {
    const result = {
      title: 'Anchored title',
      author: 'Searchable author',
    }
    const evidence = {
      title: { value: 'Anchored title', snippet: 'Anchored title appears here', page: 2 },
    }

    expect(buildHighlights(result, evidence, { title: 'yellow', author: 'blue' })).toEqual([
      { value: 'Anchored title', snippet: 'Anchored title appears here', hintPage: 2, color: 'yellow' },
      { value: 'Searchable author', snippet: null, hintPage: null, color: 'blue' },
    ])
  })
})
