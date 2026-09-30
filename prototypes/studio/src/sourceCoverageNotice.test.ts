import { describe, expect, it } from 'vitest'
import { sourceCoverageNotice } from './sourceCoverageNotice'

describe('sourceCoverageNotice', () => {
  it('says nothing for a suggestion that read its whole source', () => {
    expect(sourceCoverageNotice({ complete: true })).toBeNull()
  })

  it('lists several pages, collapsing consecutive ones into a range', () => {
    const omitted = [1, 2, 3, 7, 9, 10].map((page, index) => ({ page, start: index * 100, end: index * 100 + 10 }))
    expect(sourceCoverageNotice({ complete: false, sourceCharacters: 1_000, omitted })).toBe(
      'Suggested from excerpts: the middle of pages 1–3, 7 and 9–10 was not read (60 of 1,000 characters).',
    )
  })

  it('describes a source without page markers as a whole', () => {
    expect(
      sourceCoverageNotice({ complete: false, sourceCharacters: 60_000, omitted: [{ page: null, start: 23_000, end: 37_000 }] }),
    ).toBe('Suggested from excerpts: the middle of the source was not read (14,000 of 60,000 characters).')
  })
})
