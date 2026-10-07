import { describe, expect, it } from 'vitest'
import type { SourcePageSpan } from 'db'
import { EXCERPT_THRESHOLD, schemaPrompt, schemaSourceExcerpts, schemaSourceWindows } from './_schema.js'

describe('schemaPrompt', () => {
  it('requires an explicit root record description', () => {
    const prompt = schemaPrompt('')

    expect(prompt).toContain('"_description"')
    expect(prompt).toContain('defining what constitutes ONE root record')
    expect(prompt).toContain('field names alone are not a record definition')
  })
})

/** Pages written as `renderMarkdown` writes them: a blank line between, a final newline, and no marker; spans in UTF-8 bytes. */
function rendered(pages: { page: number; text: string }[]) {
  const encoder = new TextEncoder()
  let markdown = ''
  let bytes = 0
  const pageSpans: SourcePageSpan[] = []
  for (const [i, { page, text }] of pages.entries()) {
    if (i > 0) {
      markdown += '\n\n'
      bytes += 2
    }
    const end = bytes + encoder.encode(text).length
    pageSpans.push({ pageNumber: page, start: bytes, end })
    markdown += text
    bytes = end
  }
  return { markdown: markdown + '\n', pageSpans }
}

describe('schemaSourceExcerpts', () => {
  it('declares a source under the excerpt threshold complete and sends it whole', () => {
    const source = 'A short register.\n\nIts second page.'

    expect(schemaSourceExcerpts(source)).toEqual({ text: source, sourceCoverage: { complete: true } })
  })

  it('declares the middle of a long unnumbered source unread when page spans are unavailable (audit probe: 50,000 characters)', () => {
    const marker = 'UNIQUE_MIDDLE_FIELD'
    const source = 'A'.repeat(25000) + marker + 'Z'.repeat(25000)
    const markerAt = source.indexOf(marker)

    const { text, sourceCoverage } = schemaSourceExcerpts(source)

    expect(text).not.toContain(marker)
    expect(text).not.toContain('physical page')
    expect(sourceCoverage).toEqual({
      complete: false,
      sourceCharacters: 50_019,
      omitted: [{ page: null, start: 23_000, end: 27_019 }],
    })
    if (sourceCoverage.complete) throw new Error('expected an excerpted source')
    const [omission] = sourceCoverage.omitted
    expect(markerAt).toBeGreaterThanOrEqual(omission!.start)
    expect(markerAt + marker.length).toBeLessThanOrEqual(omission!.end)
    // What was sent is exactly the source outside the declared range.
    expect(text).toContain(source.slice(0, omission!.start))
    expect(text).toContain(source.slice(omission!.end))
  })

  it('names only the pages it excerpted, by their physical page number, with UTF-16 ranges in the whole source', () => {
    const pages = [
      { page: 1, text: 'æøå 😀 ' + 'a'.repeat(100) },
      { page: 2, text: 'æøå 😀 ' + 'b'.repeat(30_000) },
      { page: 5, text: 'c'.repeat(200) },
      { page: 6, text: 'd'.repeat(30_000) + ' æøå 😀' },
    ]
    const { markdown, pageSpans } = rendered(pages)
    const half = Math.floor(46_000 / 4 / 2)
    const second = markdown.indexOf(pages[1]!.text)
    const fifth = markdown.indexOf(pages[2]!.text)
    const sixth = markdown.indexOf(pages[3]!.text)

    const { text, sourceCoverage } = schemaSourceExcerpts(markdown, pageSpans)

    expect(text).toContain('from every physical page')
    expect(text).toContain(pages[0]!.text)
    expect(text).toContain(pages[2]!.text)
    expect(sourceCoverage).toEqual({
      complete: false,
      sourceCharacters: markdown.length,
      omitted: [
        // Each page runs to the next page's start, so its separator belongs to it.
        { page: 2, start: second + half, end: fifth - half },
        { page: 6, start: sixth + half, end: markdown.length - half },
      ],
    })
    if (sourceCoverage.complete) throw new Error('expected an excerpted source')
    // What was sent of an excerpted page is its head and tail: the source just outside its declared range.
    const [first, last] = sourceCoverage.omitted
    expect(text.includes(markdown.slice(first!.start - half, first!.start) + '\n[... omitted for schema design ...]\n' + markdown.slice(first!.end, first!.end + half))).toBe(true)
    expect(text.endsWith(markdown.slice(last!.end))).toBe(true)
    expect(markdown.slice(first!.start, first!.end)).toBe('b'.repeat(first!.end - first!.start))
  })

  it('never sends half of a surrogate pair at a cut, and declares the whole pair omitted', () => {
    // An emoji straddles the head cut (indices 22,999-23,000) and another the tail cut.
    const source = 'a'.repeat(22_999) + '😀' + 'b'.repeat(4000) + '😀' + 'c'.repeat(22_999)

    const { text, sourceCoverage } = schemaSourceExcerpts(source)

    expect(text.isWellFormed()).toBe(true)
    expect(sourceCoverage).toEqual({
      complete: false,
      sourceCharacters: source.length,
      omitted: [{ page: null, start: 22_999, end: source.length - 22_999 }],
    })
  })

  it('rejects spans that do not fall on character boundaries of the source', () => {
    const { markdown, pageSpans } = rendered([{ page: 1, text: 'æ'.repeat(30_000) }, { page: 2, text: 'b'.repeat(30_000) }])

    expect(() => schemaSourceExcerpts(markdown, [pageSpans[0]!, { ...pageSpans[1]!, start: 1 }]))
      .toThrow('not a character boundary')
  })
})

describe('schemaSourceWindows', () => {
  it('sends a fitting source as one window', () => {
    expect(schemaSourceWindows('# Register\n\nOne entry.')).toEqual(['# Register\n\nOne entry.'])
  })

  it('covers a long source with bounded, gap-free windows, cut at paragraphs where it can (audit probe)', () => {
    const marker = 'UNIQUE_MIDDLE_FIELD'
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Entry ${i}. ${'x'.repeat(3_000)}`)
    paragraphs[20] += marker
    const source = paragraphs.join('\n\n')

    const windows = schemaSourceWindows(source)

    expect(windows.join('')).toBe(source)
    expect(windows.length).toBeGreaterThan(1)
    expect(windows.every((window) => window.length <= EXCERPT_THRESHOLD)).toBe(true)
    expect(windows.slice(0, -1).every((window) => window.endsWith('\n\n'))).toBe(true)
    expect(windows.filter((window) => window.includes(marker))).toHaveLength(1)
  })

  it('hard-cuts unbroken text without splitting a surrogate pair', () => {
    const source = 'a' + '😀'.repeat(EXCERPT_THRESHOLD)

    const windows = schemaSourceWindows(source)

    expect(windows.join('')).toBe(source)
    expect(windows.every((window) => window.length <= EXCERPT_THRESHOLD && !/^[\udc00-\udfff]/.test(window))).toBe(true)
  })
})
