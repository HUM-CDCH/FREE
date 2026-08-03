import { describe, expect, it } from 'vitest'
import { findMarkdownAnchorMatch, findScopedMarkdownAnchorMatch } from './markdownAnchorMatch'
import type { EvidenceAnchor } from './parsedDocument'

function anchor(partial: Partial<EvidenceAnchor> & Pick<EvidenceAnchor, 'markdownStart' | 'markdownEnd'>): EvidenceAnchor {
  return { page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 }, ...partial }
}

describe('findMarkdownAnchorMatch', () => {
  it('resolves a snippet to the anchor covering its character range', () => {
    const markdown = 'intro Grave 8 contained pottery tail'
    const anchors = [anchor({ markdownStart: 0, markdownEnd: markdown.length, page: 3, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } })]

    const match = findMarkdownAnchorMatch(markdown, anchors, 'Grave 8 contained pottery')

    expect(match).toEqual({ fragments: [{ page: 3, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }] })
  })

  it('unions bboxes when the snippet spans two adjacent anchors', () => {
    const markdown = 'Grave 8 contained pottery'
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: 8, page: 2, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: 8, markdownEnd: markdown.length, page: 2, bbox: { x0: 10, y0: 5, x1: 20, y1: 15 } }),
    ]

    const match = findMarkdownAnchorMatch(markdown, anchors, markdown)

    expect(match).toEqual({ fragments: [{ page: 2, bbox: { x0: 0, y0: 0, x1: 20, y1: 15 } }] })
  })

  it('returns null when the snippet is not present in the markdown', () => {
    const anchors = [anchor({ markdownStart: 0, markdownEnd: 5 })]

    expect(findMarkdownAnchorMatch('hello world', anchors, 'absent')).toBeNull()
  })

  it('returns null when the anchors list is empty', () => {
    expect(findMarkdownAnchorMatch('hello world', [], 'hello')).toBeNull()
  })

  it('returns null when the snippet is null', () => {
    const anchors = [anchor({ markdownStart: 0, markdownEnd: 5 })]

    expect(findMarkdownAnchorMatch('hello world', anchors, null)).toBeNull()
  })

  it('returns null when no anchor covers the snippet range', () => {
    const anchors = [anchor({ markdownStart: 100, markdownEnd: 110 })]

    expect(findMarkdownAnchorMatch('hello world', anchors, 'hello')).toBeNull()
  })

  it('returns one fragment per page when the snippet crosses a page boundary', () => {
    const markdown = 'Grave 8 contained pottery'
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: 8, page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: 8, markdownEnd: markdown.length, page: 2, bbox: { x0: 10, y0: 5, x1: 20, y1: 15 } }),
    ]

    expect(findMarkdownAnchorMatch(markdown, anchors, markdown)).toEqual({
      fragments: [
        { page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } },
        { page: 2, bbox: { x0: 10, y0: 5, x1: 20, y1: 15 } },
      ],
    })
  })

  it('prefers the occurrence on the hint page when the snippet recurs earlier in the document', () => {
    const early = 'Grave 8 contained pottery'
    const late = 'intro filler filler filler Grave 8 contained pottery tail'
    const markdown = `${early} ${late}`
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: early.length, page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: early.length, markdownEnd: markdown.length, page: 9, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }),
    ]

    const match = findMarkdownAnchorMatch(markdown, anchors, 'Grave 8 contained pottery', 9, null)

    expect(match).toEqual({ fragments: [{ page: 9, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }] })
  })

  it('without a hint page, falls back to the first occurrence (documenting current best-effort behavior)', () => {
    const early = 'Grave 8 contained pottery'
    const late = 'intro filler filler filler Grave 8 contained pottery tail'
    const markdown = `${early} ${late}`
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: early.length, page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: early.length, markdownEnd: markdown.length, page: 9, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }),
    ]

    const match = findMarkdownAnchorMatch(markdown, anchors, 'Grave 8 contained pottery')

    expect(match).toEqual({ fragments: [{ page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }] })
  })

  it('uses occurrenceIndex to disambiguate multiple occurrences that share a hint page', () => {
    const markdown = 'Grave 8 contained pottery. Later, Grave 8 contained pottery again.'
    const firstEnd = markdown.indexOf('again') // covers both occurrences on the same page
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: 26, page: 5, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: 26, markdownEnd: firstEnd + 5, page: 5, bbox: { x0: 20, y0: 20, x1: 30, y1: 30 } }),
    ]

    const match = findMarkdownAnchorMatch(markdown, anchors, 'Grave 8 contained pottery', 5, 1)

    expect(match).toEqual({ fragments: [{ page: 5, bbox: { x0: 20, y0: 20, x1: 30, y1: 30 } }] })
  })

  it('uses the source scope instead of global occurrence order for duplicate snippets', () => {
    const snippet = 'Grave 8 contained pottery'
    const markdown = `${snippet}\n\n# Grave 9\n\n${snippet}`
    const secondStart = markdown.lastIndexOf(snippet)
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: snippet.length, page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: secondStart, markdownEnd: markdown.length, page: 1, bbox: { x0: 20, y0: 20, x1: 30, y1: 30 } }),
    ]

    expect(findMarkdownAnchorMatch(markdown, anchors, snippet, null, null, {
      segmentId: 'catalog:1',
      markdownStart: secondStart,
      markdownEnd: markdown.length,
      startPage: 1,
      endPage: 1,
    })).toEqual({ fragments: [{ page: 1, bbox: { x0: 20, y0: 20, x1: 30, y1: 30 } }] })
  })

  it('does not widen to an identical snippet outside the source scope', () => {
    const snippet = 'Grave 8 contained pottery'
    const markdown = `${snippet}\n\n# Grave 9\n\nNo matching evidence here.`
    const anchors = [anchor({ markdownStart: 0, markdownEnd: snippet.length, page: 1 })]

    expect(findMarkdownAnchorMatch(markdown, anchors, snippet, null, null, {
      segmentId: 'catalog:1',
      markdownStart: snippet.length + 1,
      markdownEnd: markdown.length,
      startPage: 1,
      endPage: 1,
    })).toBeNull()
  })

  it('uses a unique result value before its broader evidence snippet', () => {
    const markdown = 'Grave 8 contains pottery and a bronze pin.'
    const scope = { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: markdown.length, startPage: 1, endPage: 1 }
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: 7, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: 8, markdownEnd: markdown.length, bbox: { x0: 20, y0: 0, x1: 80, y1: 10 } }),
    ]

    expect(findScopedMarkdownAnchorMatch(markdown, anchors, 'bronze pin', 'contains pottery and a bronze pin', scope))
      .toEqual({ fragments: [{ page: 1, bbox: { x0: 20, y0: 0, x1: 80, y1: 10 } }] })
  })

  it('uses scoped snippet context when result text is absent', () => {
    const markdown = 'Grave 8 contains pottery.'
    const scope = { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: markdown.length, startPage: 1, endPage: 1 }
    const anchors = [anchor({ markdownStart: 0, markdownEnd: markdown.length })]

    expect(findScopedMarkdownAnchorMatch(markdown, anchors, 'pottery assemblage', 'Grave 8 contains pottery', scope))
      .toEqual({ fragments: [{ page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }] })
  })
})
