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
      {
        value: 'Anchored title',
        snippet: 'Anchored title appears here',
        hintPage: 2,
        rowHeader: null,
        columnHeader: null,
        color: 'yellow',
        path: ['title'],
      },
      {
        value: 'Searchable author',
        snippet: null,
        hintPage: null,
        rowHeader: null,
        columnHeader: null,
        color: 'blue',
        path: ['author'],
      },
    ])
  })

  it('carries row_header/column_header hints into the highlight', () => {
    const result = { records: [{ count: '5' }] }
    const evidence = {
      records: [{ count: { value: '5', snippet: '5', page: 1, row_header: 'Grave 1', column_header: 'Count' } }],
    }

    expect(buildHighlights(result, evidence, { count: 'yellow' })).toEqual([
      {
        value: '5',
        snippet: '5',
        hintPage: 1,
        rowHeader: 'Grave 1',
        columnHeader: 'Count',
        color: 'yellow',
        path: ['records', '0', 'count'],
      },
    ])
  })
})
