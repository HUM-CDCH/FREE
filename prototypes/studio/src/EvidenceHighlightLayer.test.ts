import { describe, expect, it } from 'vitest'
import { buildHighlights } from './evidenceHighlights'

describe('buildHighlights', () => {
  it('uses embedded Evidence and falls back to direct searches for ungrounded leaves', () => {
    const result = {
      title: 'Anchored title',
      author: 'Searchable author',
      _evidence: {
        title: { snippets: ['Anchored title appears here'], page: 2 },
      },
    }

    expect(buildHighlights(result, { title: 'yellow', author: 'blue' })).toEqual([
      {
        value: 'Anchored title',
        snippet: 'Anchored title appears here',
        hintPage: 2,
        color: 'yellow',
      },
      {
        value: 'Searchable author',
        snippet: null,
        hintPage: null,
        color: 'blue',
      },
    ])
  })

  it('skips Evidence metadata instead of treating it as extracted values', () => {
    const result = {
      entries: [
        {
          id: '8',
          _evidence: {
            id: {
              snippets: ['Grav 8'],
              source_type: 'text',
              row_header_text: 'must not become a highlight',
            },
          },
        },
      ],
    }

    expect(buildHighlights(result, { entries: 'yellow' })).toEqual([
      { value: '8', snippet: 'Grav 8', hintPage: null, color: 'yellow' },
    ])
  })

  it('highlights numeric and boolean leaves when they have Evidence', () => {
    const result = {
      count: 7,
      verified: true,
      missing: null,
      _evidence: {
        count: { snippets: ['seven'] },
        verified: { snippets: ['verified'] },
        missing: { snippets: ['missing'] },
      },
    }

    expect(buildHighlights(result, { count: 'yellow', verified: 'blue', missing: 'green' })).toEqual([
      { value: '7', snippet: 'seven', hintPage: null, color: 'yellow' },
      { value: 'true', snippet: 'verified', hintPage: null, color: 'blue' },
    ])
  })
})
