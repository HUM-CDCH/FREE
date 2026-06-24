import { describe, expect, it } from 'vitest'
import { resultStats } from './resultStats'

describe('resultStats', () => {
  it('counts fields, missing values, and array items recursively', () => {
    const stats = resultStats({
      title: 'Report',
      author: null,
      people: [
        { name: 'Anna', role: '' },
        { name: 'Bo', role: 'editor' },
      ],
      notes: [],
    })

    expect(stats).toEqual({ fields: 7, missing: 3, arrayItems: 2 })
  })
})
