import { describe, expect, it } from 'vitest'
import { schemaPrompt, schemaSourceExcerpts } from './_schema.js'

describe('schemaPrompt', () => {
  it('requires an explicit root record description', () => {
    const prompt = schemaPrompt('')

    expect(prompt).toContain('"_description"')
    expect(prompt).toContain('defining what constitutes ONE root record')
    expect(prompt).toContain('field names alone are not a record definition')
  })
})

describe('schemaSourceExcerpts', () => {
  it('declares a source under the excerpt threshold complete and sends it whole', () => {
    const source = '<!-- FREE:PAGE 1 -->\nA short register.\n<!-- FREE:PAGE 2 -->\nIts second page.'

    expect(schemaSourceExcerpts(source)).toEqual({ text: source, sourceCoverage: { complete: true } })
  })

  it('declares the middle of a long page unread when it is not sent (audit probe: a 50,040-character page)', () => {
    const marker = 'UNIQUE_MIDDLE_FIELD'
    const source = '<!-- FREE:PAGE 1 -->\n' + 'A'.repeat(25000) + marker + 'Z'.repeat(25000)
    const markerAt = source.indexOf(marker)

    const { text, sourceCoverage } = schemaSourceExcerpts(source)

    expect(source.length).toBe(50_040)
    expect(text).not.toContain(marker)
    expect(sourceCoverage).toEqual({
      complete: false,
      sourceCharacters: 50_040,
      omitted: [{ page: 1, start: 23_000, end: 27_040 }],
    })
    if (sourceCoverage.complete) throw new Error('expected an excerpted source')
    const [omission] = sourceCoverage.omitted
    expect(markerAt).toBeGreaterThanOrEqual(omission!.start)
    expect(markerAt + marker.length).toBeLessThanOrEqual(omission!.end)
    // What was sent is exactly the source outside the declared range.
    expect(text).toContain(source.slice(0, omission!.start))
    expect(text).toContain(source.slice(omission!.end))
  })

  it('names only the pages it excerpted, by their page marker, with ranges in the whole source', () => {
    const pages = [
      '<!-- FREE:PAGE 1 -->\n' + 'a'.repeat(100),
      '<!-- FREE:PAGE 2 -->\n' + 'b'.repeat(30_000),
      '<!-- FREE:PAGE 5 -->\n' + 'c'.repeat(200),
      '<!-- FREE:PAGE 6 -->\n' + 'd'.repeat(30_000),
    ]
    const source = pages.join('')
    const half = Math.floor(46_000 / 4 / 2)
    const second = pages[0]!.length
    const sixth = pages[0]!.length + pages[1]!.length + pages[2]!.length

    const { text, sourceCoverage } = schemaSourceExcerpts(source)

    expect(text).toContain(pages[0])
    expect(text).toContain(pages[2])
    expect(sourceCoverage).toEqual({
      complete: false,
      sourceCharacters: source.length,
      omitted: [
        { page: 2, start: second + half, end: second + pages[1]!.length - half },
        { page: 6, start: sixth + half, end: sixth + pages[3]!.length - half },
      ],
    })
  })

  it('declares text before the first page marker without a page number', () => {
    const source = 'x'.repeat(60_000)

    const { sourceCoverage } = schemaSourceExcerpts(source)

    expect(sourceCoverage).toEqual({
      complete: false,
      sourceCharacters: 60_000,
      omitted: [{ page: null, start: 23_000, end: 37_000 }],
    })
  })
})
