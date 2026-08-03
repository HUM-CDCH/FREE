import { describe, expect, it } from 'vitest'
import { buildSegmentGeometryIndex } from './segmentGeometry'
import type { ParsedTable } from './parsedDocument'

function table(id: string, pageNumber: number, start: number, end: number): ParsedTable {
  return { tableId: id, pageNumber, canonicalMarkdownStart: start, canonicalMarkdownEnd: end, cells: [] }
}

describe('buildSegmentGeometryIndex', () => {
  it('assigns same-page tables to exactly one explicit segment', () => {
    const first = '| Grave | Count |\n| --- | --- |\n| 1 | 5 |'
    const second = '| Grave | Count |\n| --- | --- |\n| 2 | 5 |'
    const markdown = `# Grave 1\n\n${first}\n\n# Grave 2\n\n${second}`
    const secondStart = markdown.indexOf('# Grave 2')
    const tables = [
      table('first', 1, markdown.indexOf(first), markdown.indexOf(first) + first.length),
      table('second', 1, markdown.indexOf(second), markdown.indexOf(second) + second.length),
    ]

    const index = buildSegmentGeometryIndex([], tables, [
      { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: secondStart, startPage: 1, endPage: 1 },
      { segmentId: 'catalog:1', markdownStart: secondStart, markdownEnd: markdown.length, startPage: 1, endPage: 1 },
    ])
    expect(index.get('catalog:0')?.tables.map((item) => item.tableId)).toEqual(['first'])
    expect(index.get('catalog:1')?.tables.map((item) => item.tableId)).toEqual(['second'])
  })

  it('leaves an unlinked table unassigned', () => {
    const unlinked: ParsedTable = { tableId: 'unlinked', pageNumber: 1, canonicalMarkdownStart: null, canonicalMarkdownEnd: null, cells: [] }
    const index = buildSegmentGeometryIndex([], [unlinked], [
      { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: 20, startPage: 1, endPage: 1 },
    ])
    expect(index.get('catalog:0')?.tables).toEqual([])
  })
})
