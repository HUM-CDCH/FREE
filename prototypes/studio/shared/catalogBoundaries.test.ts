import { describe, expect, it } from 'vitest'
import {
  resolveCatalogBoundaries,
  type CatalogBoundaryErrorCode,
} from './catalogBoundaries.js'
import type { ParsedContentBlock } from './parsedDocument.js'

function heading(blockId: string, text: string, level: number): ParsedContentBlock {
  return {
    block_id: blockId,
    page_number: 1,
    parser: 'test',
    bbox: null,
    markdown_span: null,
    kind: 'heading',
    text,
    level,
  }
}

function paragraph(blockId: string, text: string): ParsedContentBlock {
  return {
    block_id: blockId,
    page_number: 1,
    parser: 'test',
    bbox: null,
    markdown_span: null,
    kind: 'paragraph',
    text,
  }
}

function document(content_stream: ParsedContentBlock[]) {
  return { content_stream }
}

function expectCode(action: () => unknown, code: CatalogBoundaryErrorCode) {
  expect(action).toThrow(expect.objectContaining({ code }))
}

describe('resolveCatalogBoundaries', () => {
  it('resolves exact labels in source order and closes non-terminal records at the next start', () => {
    const source = document([
      paragraph('intro', 'Introduction'),
      heading('first', 'First', 1),
      paragraph('first-body', 'First body'),
      heading('second', 'Second', 1),
      paragraph('second-body', 'Second body'),
    ])

    expect(resolveCatalogBoundaries(source, ['First', 'Second'])).toEqual([
      {
        startBlockId: 'first',
        startContentIndex: 1,
        endContentIndex: 3,
        headingText: 'First',
        headingLevel: 1,
      },
      {
        startBlockId: 'second',
        startContentIndex: 3,
        endContentIndex: 5,
        headingText: 'Second',
        headingLevel: 1,
      },
    ])
  })

  it.each([
    ['unknown', ['Missing'], 'unknown_label'],
    ['duplicate', ['First', 'First'], 'duplicate_label'],
    ['non-heading', ['Introduction'], 'non_heading_label'],
    ['non-monotonic', ['Second', 'First'], 'non_monotonic_order'],
  ] as const)('rejects %s discovery labels', (_, labels, code) => {
    const source = document([
      paragraph('intro', 'Introduction'),
      heading('first', 'First', 1),
      heading('second', 'Second', 1),
    ])
    expectCode(() => resolveCatalogBoundaries(source, labels), code)
  })

  it('rejects canonical headings with identical exact text', () => {
    const source = document([
      heading('first', 'Same', 1),
      paragraph('body', 'Body'),
      heading('second', 'Same', 2),
    ])

    expectCode(() => resolveCatalogBoundaries(source, ['Same']), 'ambiguous_heading')
  })

  it('does not normalize heading labels', () => {
    const source = document([heading('first', 'Café', 1)])

    expectCode(() => resolveCatalogBoundaries(source, [' Café ']), 'unknown_label')
    expectCode(() => resolveCatalogBoundaries(source, ['Cafe\u0301']), 'unknown_label')
  })

  it('closes a terminal nested heading before its later peer', () => {
    const source = document([
      heading('parent', 'Parent', 1),
      heading('child', 'Child', 2),
      paragraph('child-body', 'Child body'),
      heading('grandchild', 'Grandchild', 3),
      paragraph('grandchild-body', 'Grandchild body'),
      heading('peer', 'Peer', 2),
    ])

    expect(resolveCatalogBoundaries(source, ['Child'])).toEqual([
      {
        startBlockId: 'child',
        startContentIndex: 1,
        endContentIndex: 5,
        headingText: 'Child',
        headingLevel: 2,
      },
    ])
  })

  it('closes a terminal heading before a later shallower heading', () => {
    const source = document([
      heading('section', 'Section', 2),
      paragraph('body', 'Body'),
      heading('chapter', 'Chapter', 1),
    ])

    expect(resolveCatalogBoundaries(source, ['Section'])[0].endContentIndex).toBe(2)
  })

  it('uses canonical document end when no later peer or shallower heading exists', () => {
    const source = document([
      heading('section', 'Section', 1),
      heading('subsection', 'Subsection', 2),
      paragraph('body', 'Body'),
    ])

    expect(resolveCatalogBoundaries(source, ['Section'])[0].endContentIndex).toBe(3)
  })
})
