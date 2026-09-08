import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  resolveCatalogBoundaries,
  type CatalogBoundaryErrorCode,
} from './catalog-boundaries.js'
import type { ParsedContentBlock } from './parsed-document.js'

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
  assert.throws(action, (error: unknown) => (error as { code?: string }).code === code)
}

describe('resolveCatalogBoundaries', () => {
  it('closes a final paragraph record before a discovered non-heading index', () => {
    const source = document([
      paragraph('entry', '3. Final supplement entry'),
      paragraph('body', 'Finds and museum reference'),
      paragraph('index', 'Findspot index'),
      paragraph('index-body', 'Repeated entry references'),
    ])
    assert.equal(resolveCatalogBoundaries(source, ['entry'], 'index')[0].endContentIndex, 2)
    expectCode(() => resolveCatalogBoundaries(source, ['entry'], 'missing'), 'invalid_end')
    expectCode(() => resolveCatalogBoundaries(source, ['entry'], 'entry'), 'invalid_end')
  })
  it('accepts numbered paragraphs and lists while keeping subentries in their record', () => {
    const source = document([
      paragraph('first', '29. Tangermünde'),
      paragraph('first-a', 'a) Grave'),
      paragraph('first-b', 'b) Grave'),
      { block_id: 'second', page_number: 1, parser: 'test', bbox: null, markdown_span: null,
        kind: 'list', ordered: true, items: ['30. Estedt'] },
      paragraph('second-body', 'Finds'),
    ])
    assert.deepEqual(resolveCatalogBoundaries(source, ['first', 'second']), [
      { startBlockId: 'first', startContentIndex: 0, endContentIndex: 3,
        headingText: '29. Tangermünde', headingLevel: null },
      { startBlockId: 'second', startContentIndex: 3, endContentIndex: 5,
        headingText: '30. Estedt', headingLevel: null },
    ])
  })

  it('resolves heading block IDs in source order and closes non-terminal records at the next start', () => {
    const source = document([
      paragraph('intro', 'Introduction'),
      heading('first', 'First', 1),
      paragraph('first-body', 'First body'),
      heading('second', 'Second', 1),
      paragraph('second-body', 'Second body'),
    ])

    assert.deepEqual(resolveCatalogBoundaries(source, ['first', 'second']), [
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

  it('resolves stable heading block IDs despite malformed heading text', () => {
    const source = document([
      paragraph('title', 'Beretning'),
      heading('record-start', 'Tolkinger og perspekঞ  ver', 2),
      paragraph('record-body', 'Body'),
    ])

    assert.equal(
      resolveCatalogBoundaries(source, ['record-start'])[0].headingText,
      'Tolkinger og perspekঞ  ver',
    )
  })

  const rejections: ReadonlyArray<
    readonly [string, readonly string[], CatalogBoundaryErrorCode]
  > = [
    ['unknown', ['missing'], 'unknown_start'],
    ['duplicate', ['first', 'first'], 'duplicate_start'],
    ['non-text', ['page-break'], 'non_text_start'],
    ['non-monotonic', ['second', 'first'], 'non_monotonic_order'],
  ]
  for (const [name, startBlockIds, code] of rejections) {
    it(`rejects ${name} discovery starts`, () => {
      const source = document([
        paragraph('intro', 'Introduction'),
        heading('first', 'First', 1),
        heading('second', 'Second', 1),
        { block_id: 'page-break', page_number: 1, parser: 'test', bbox: null,
          markdown_span: null, kind: 'page_break', next_page: 2 },
      ])
      expectCode(() => resolveCatalogBoundaries(source, startBlockIds), code)
    })
  }

  it('distinguishes canonical headings with identical text by block ID', () => {
    const source = document([
      heading('first', 'Same', 1),
      paragraph('body', 'Body'),
      heading('second', 'Same', 2),
    ])

    assert.deepEqual(
      resolveCatalogBoundaries(source, ['first', 'second']).map(
        (boundary) => boundary.startBlockId,
      ),
      ['first', 'second'],
    )
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

    assert.deepEqual(resolveCatalogBoundaries(source, ['child']), [
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

    assert.equal(resolveCatalogBoundaries(source, ['section'])[0].endContentIndex, 2)
  })

  it('uses canonical document end when no later peer or shallower heading exists', () => {
    const source = document([
      heading('section', 'Section', 1),
      heading('subsection', 'Subsection', 2),
      paragraph('body', 'Body'),
    ])

    assert.equal(resolveCatalogBoundaries(source, ['section'])[0].endContentIndex, 3)
  })

  it('resolves large block-ID selections with linear stream access', () => {
    const startBlockIds = Array.from(
      { length: 1_000 },
      (_, index) => `heading-${index}`,
    )
    const blocks = startBlockIds.map((startBlockId, index) =>
      heading(startBlockId, `Entry ${index}`, 1),
    )
    let indexedReads = 0
    const contentStream = new Proxy(blocks, {
      get(target, property, receiver) {
        if (
          typeof property === 'string' &&
          /^(?:0|[1-9]\d*)$/.test(property)
        )
          indexedReads += 1
        return Reflect.get(target, property, receiver)
      },
    })

    const boundaries = resolveCatalogBoundaries(
      document(contentStream),
      startBlockIds,
    )
    assert.equal(boundaries.length, startBlockIds.length)
    assert.equal(boundaries[0].startBlockId, 'heading-0')
    assert.equal(boundaries.at(-1)?.startBlockId, 'heading-999')
    assert.ok(indexedReads <= 3 * contentStream.length + 10)
  })
})
