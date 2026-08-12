import { describe, expect, it } from 'vitest'
import {
  candidateFragments,
  findCanonicalSpanAnchorMatch,
  findMarkdownAnchorMatch,
  findScopedMarkdownAnchorMatch,
  findUniqueTolerantScopedRange,
} from './markdownAnchorMatch'
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

  it('rejects an overlapping anchor when its block crosses a scope boundary', () => {
    const markdown = 'Previous segment tail. Datering: Yngre romersk jernalder (?)'
    const term = 'Datering: Yngre romersk jernalder (?)'
    const termStart = markdown.indexOf(term)
    const anchors = [
      anchor({
        markdownStart: 0,
        markdownEnd: markdown.length,
        page: 5,
        bbox: { x0: 5, y0: 6, x1: 50, y1: 16 },
      }),
    ]

    expect(findMarkdownAnchorMatch(markdown, anchors, term, null, null, {
      segmentId: 'catalog:4',
      markdownStart: termStart,
      markdownEnd: markdown.length,
      startPage: 5,
      endPage: 5,
    })).toBeNull()
  })

  it('does not use a scoped anchor that is not contained in the source scope', () => {
    const markdown = 'Datering: Yngre romersk jernalder (?)'
    const anchors = [
      anchor({
        markdownStart: 0,
        markdownEnd: 10,
        page: 5,
        bbox: { x0: 5, y0: 6, x1: 50, y1: 16 },
      }),
    ]

    expect(findMarkdownAnchorMatch(markdown, anchors, 'jernalder', null, null, {
      segmentId: 'catalog:4',
      markdownStart: 20,
      markdownEnd: markdown.length,
      startPage: 5,
      endPage: 5,
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

  it('uses a label-trimmed tolerant snippet when punctuation makes exact matching fail', () => {
    const markdown = 'Skelet: Der var bevaret et stykke af underkæben med 3 tænder heraf en godt bevaret kindtand beliggende i graven.'
    const scope = { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: markdown.length, startPage: 1, endPage: 1 }
    const anchors = [anchor({ markdownStart: 0, markdownEnd: markdown.length, bbox: { x0: 2, y0: 3, x1: 40, y1: 12 } })]

    expect(findScopedMarkdownAnchorMatch(
      markdown,
      anchors,
      'Skelet: Der var bevaret et stykke af underkæben med 3 tænder heraf en godt bevaret kindtand.',
      null,
      scope,
      'Der var bevaret et stykke af underkæben med 3 tænder',
    )).toEqual({ fragments: [{ page: 1, bbox: { x0: 2, y0: 3, x1: 40, y1: 12 } }] })
  })

  it('uses an ellipsis fragment as a tolerant candidate', () => {
    const markdown = 'Nedgravningen målte ca. 2 m x 1 m og var senere ca. 1,4 m x 0,6 m.'
    const scope = { segmentId: 'catalog:5', markdownStart: 0, markdownEnd: markdown.length, startPage: 5, endPage: 5 }
    const anchors = [anchor({ markdownStart: 0, markdownEnd: markdown.length, bbox: { x0: 4, y0: 5, x1: 60, y1: 20 } })]

    expect(findScopedMarkdownAnchorMatch(
      markdown,
      anchors,
      'Nedgravningen målte ca. 2 m x 1 m ... ca. 1,4 m x 0,6 m.',
      null,
      scope,
      'ca. 1,4 m x 0,6 m',
    )).toEqual({ fragments: [{ page: 1, bbox: { x0: 4, y0: 5, x1: 60, y1: 20 } }] })
  })

  it('rejects duplicate tolerant candidates inside the source scope', () => {
    const markdown = 'Gravudstyr: en bronzefibel blev fundet. Senere omtales en bronzefibel blev fundet igen.'
    const scope = { segmentId: 'catalog:6', markdownStart: 0, markdownEnd: markdown.length, startPage: 6, endPage: 6 }

    expect(findUniqueTolerantScopedRange(markdown, 'en bronzefibel blev fundet', scope)).toBeNull()
  })

  it('does not produce tolerant candidates for table-like snippets', () => {
    expect(candidateFragments('| 26-15 | Keramik | Niv. 6 |', 'Keramik')).toEqual([])
  })

  it('resolves a canonical span directly without searching duplicate snippet text', () => {
    const snippet = 'Grave 8 contained pottery'
    const markdown = `${snippet}. Later ${snippet}.`
    const secondStart = markdown.lastIndexOf(snippet)
    const scope = { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: markdown.length, startPage: 1, endPage: 1 }
    const anchors = [
      anchor({ markdownStart: 0, markdownEnd: snippet.length, page: 1, bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }),
      anchor({ markdownStart: secondStart, markdownEnd: secondStart + snippet.length, page: 1, bbox: { x0: 20, y0: 20, x1: 30, y1: 30 } }),
    ]

    expect(findCanonicalSpanAnchorMatch(markdown, anchors, {
      markdownStart: secondStart,
      markdownEnd: secondStart + snippet.length,
    }, scope)).toEqual({ fragments: [{ page: 1, bbox: { x0: 20, y0: 20, x1: 30, y1: 30 } }] })
  })

  it('rejects a coarse anchor that would paint a whole block for a short canonical span', () => {
    const markdown = 'Name: Jean. A long OCR paragraph continues with many unrelated words and fields.'
    const start = markdown.indexOf('Jean')
    const scope = { segmentId: 'notice:0', markdownStart: 0, markdownEnd: markdown.length, startPage: 1, endPage: 1 }
    const anchors = [
      anchor({
        markdownStart: 0,
        markdownEnd: markdown.length,
        bbox: { x0: 1, y0: 2, x1: 300, y1: 120 },
      }),
    ]

    expect(findCanonicalSpanAnchorMatch(markdown, anchors, {
      markdownStart: start,
      markdownEnd: start + 'Jean'.length,
    }, scope)).toBeNull()
  })

  it('keeps a precise anchor for a short canonical span', () => {
    const markdown = 'Name: Jean. Tail.'
    const start = markdown.indexOf('Jean')
    const scope = { segmentId: 'notice:0', markdownStart: 0, markdownEnd: markdown.length, startPage: 1, endPage: 1 }
    const anchors = [
      anchor({
        markdownStart: start,
        markdownEnd: start + 'Jean'.length,
        bbox: { x0: 10, y0: 20, x1: 30, y1: 30 },
      }),
    ]

    expect(findCanonicalSpanAnchorMatch(markdown, anchors, {
      markdownStart: start,
      markdownEnd: start + 'Jean'.length,
    }, scope)).toEqual({ fragments: [{ page: 1, bbox: { x0: 10, y0: 20, x1: 30, y1: 30 } }] })
  })

  it('rejects canonical spans outside the source scope', () => {
    const markdown = 'First occurrence. Second occurrence.'
    const secondStart = markdown.indexOf('Second')
    const anchors = [anchor({ markdownStart: secondStart, markdownEnd: markdown.length, page: 1 })]

    expect(findCanonicalSpanAnchorMatch(markdown, anchors, {
      markdownStart: secondStart,
      markdownEnd: markdown.length,
    }, {
      segmentId: 'catalog:0',
      markdownStart: 0,
      markdownEnd: secondStart - 1,
      startPage: 1,
      endPage: 1,
    })).toBeNull()
  })
})
