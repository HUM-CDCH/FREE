import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  findPrimaryArrayKey,
  isEmptyResult,
  offsetPageNumbers,
  pageForOffset,
  splitMarkdownByHeadings,
} from './_catalog_sections'

describe('findPrimaryArrayKey', () => {
  it('finds the sole top-level singleton array-of-objects field', () => {
    expect(findPrimaryArrayKey({ grave: [{ name: 'verbatim-string' }] })).toBe('grave')
  })

  it('ignores a top-level "_description" guidance field', () => {
    expect(
      findPrimaryArrayKey({
        _description: 'One instance per grave.',
        grave: [{ name: 'verbatim-string' }],
      }),
    ).toBe('grave')
  })

  it('returns null when the template mixes a scalar field alongside the array', () => {
    expect(
      findPrimaryArrayKey({
        site_name: 'string',
        grave: [{ name: 'verbatim-string' }],
      }),
    ).toBeNull()
  })

  it('returns null when there is no array-of-objects field', () => {
    expect(findPrimaryArrayKey({ name: 'string' })).toBeNull()
  })

  it('returns null when the array element is not an object', () => {
    expect(findPrimaryArrayKey({ tags: ['string'] })).toBeNull()
  })

  it('returns null for non-record templates', () => {
    expect(findPrimaryArrayKey(null)).toBeNull()
    expect(findPrimaryArrayKey(['a'])).toBeNull()
  })
})

describe('splitMarkdownByHeadings', () => {
  it('splits on level-1 headings only, each section running to the next heading', () => {
    const markdown = '# Grav 8\n\nArk: 67\n\n# Grav 13\n\nArk: 68\n'
    const sections = splitMarkdownByHeadings(markdown)

    expect(sections.map((s) => s.headingText)).toEqual(['Grav 8', 'Grav 13'])
    expect(sections[0].body).toBe('# Grav 8\n\nArk: 67')
    expect(sections[1].body).toBe('# Grav 13\n\nArk: 68')
  })

  it('does not treat "##" (or deeper) headings as section boundaries', () => {
    const markdown = '# Grav 8\n\n## Fundliste\n\nSome finds\n\n# Grav 13\n\nMore text\n'
    const sections = splitMarkdownByHeadings(markdown)

    expect(sections).toHaveLength(2)
    expect(sections[0].body).toContain('## Fundliste')
  })

  it('returns [] when there are fewer than two level-1 headings', () => {
    expect(splitMarkdownByHeadings('# Only One\n\nBody text\n')).toEqual([])
    expect(splitMarkdownByHeadings('No headings here at all.')).toEqual([])
  })

  it('ignores a one-off spurious heading that does not share the recurring shape', () => {
    const markdown = [
      '# Grav 8',
      '',
      'Ark: 67',
      '',
      '# Skelet:',
      '',
      'Bone details that got mis-detected as its own heading.',
      '',
      '# Grav 13',
      '',
      'Ark: 24',
      '',
    ].join('\n')

    const sections = splitMarkdownByHeadings(markdown)

    expect(sections.map((s) => s.headingText)).toEqual(['Grav 8', 'Grav 13'])
    // The spurious "# Skelet:" heading and its text stay folded into Grav 8's section.
    expect(sections[0].body).toContain('# Skelet:')
    expect(sections[0].body).toContain('mis-detected')
  })

  it('returns [] when no heading shape recurs at least twice', () => {
    const markdown = '# Introduction\n\nText\n\n# Methods\n\nText\n\n# Results\n\nText\n'
    expect(splitMarkdownByHeadings(markdown)).toEqual([])
  })

  it('finds exactly the 7 real grave sections in the Ellekilde fixture, ignoring 4 mis-detected headings', () => {
    const markdown = readFileSync(new URL('./test-fixtures/ellekilde-8-13.md', import.meta.url), 'utf8')
    const sections = splitMarkdownByHeadings(markdown)

    expect(sections.map((s) => s.headingText)).toEqual([
      'Grav 8',
      'Grav 13',
      'Grav 24',
      'Grav 26',
      'Grav 28',
      'Grav 30',
      'Grav 31',
    ])
  })
})

describe('pageForOffset', () => {
  it('counts preceding page-break sentinels to derive a 1-based page', () => {
    const page1 = 'Page one text'
    const page2 = 'Page two text'
    const page3 = 'Page three text'
    const markdown = `${page1}\n\n---\n\n${page2}\n\n---\n\n${page3}`

    expect(pageForOffset(markdown, 0)).toBe(1)
    expect(pageForOffset(markdown, markdown.indexOf(page2))).toBe(2)
    expect(pageForOffset(markdown, markdown.indexOf(page3))).toBe(3)
  })

  it('treats a non-positive offset as page 1', () => {
    expect(pageForOffset('anything', 0)).toBe(1)
    expect(pageForOffset('anything', -5)).toBe(1)
  })
})

describe('offsetPageNumbers', () => {
  it('adds the offset to every nested "page" leaf', () => {
    const evidence = {
      name: { value: 'Grave 1', snippet: 'Grave 1', page: 1 },
      finds: [{ item: { value: 'axe', snippet: 'axe', page: 2 } }],
    }

    expect(offsetPageNumbers(evidence, 3)).toEqual({
      name: { value: 'Grave 1', snippet: 'Grave 1', page: 4 },
      finds: [{ item: { value: 'axe', snippet: 'axe', page: 5 } }],
    })
  })

  it('returns the node unchanged when offset is 0', () => {
    const evidence = { name: { value: 'Grave 1', snippet: 'Grave 1', page: 1 } }
    expect(offsetPageNumbers(evidence, 0)).toBe(evidence)
  })

  it('leaves non-"page" numeric fields untouched', () => {
    const evidence = { depth: { value: 12, snippet: '12 cm', page: 1 } }
    expect(offsetPageNumbers(evidence, 2)).toEqual({ depth: { value: 12, snippet: '12 cm', page: 3 } })
  })
})

describe('isEmptyResult', () => {
  it('treats null, empty strings, and empty arrays as empty', () => {
    expect(isEmptyResult(null)).toBe(true)
    expect(isEmptyResult('')).toBe(true)
    expect(isEmptyResult('   ')).toBe(true)
    expect(isEmptyResult([])).toBe(true)
  })

  it('treats an object made entirely of empty leaves as empty', () => {
    expect(isEmptyResult({ name: '', depth: null, finds: [] })).toBe(true)
  })

  it('treats any populated leaf as non-empty', () => {
    expect(isEmptyResult({ name: 'Grave 1', depth: null })).toBe(false)
    expect(isEmptyResult([{ name: '' }, { name: 'Grave 1' }])).toBe(false)
  })

  it('treats 0 and false as non-empty (meaningful values)', () => {
    expect(isEmptyResult({ depth: 0 })).toBe(false)
    expect(isEmptyResult({ confirmed: false })).toBe(false)
  })
})
