import { describe, expect, it } from 'vitest'
import { buildSegmentGeometryIndex } from './segmentGeometry'
import { computeOccurrenceIndices, resolveTableCellMatches } from './tableCellMatch'
import type { EvidenceSourceScope, Highlight } from './evidenceHighlights'
import type { ParsedTable, TableCell } from './parsedDocument'

function cell(partial: Partial<TableCell> & Pick<TableCell, 'row' | 'col' | 'text'>): TableCell {
  return { role: null, bbox: null, ...partial }
}

function table(
  tableId: string,
  pageNumber: number,
  canonicalMarkdownStart: number | null,
  canonicalMarkdownEnd: number | null,
  rowLabel: string,
  y: number,
): ParsedTable {
  return {
    tableId,
    pageNumber,
    canonicalMarkdownStart,
    canonicalMarkdownEnd,
    cells: [
      cell({ row: 0, col: 0, text: 'Grave', role: 'header' }),
      cell({ row: 0, col: 1, text: 'Count', role: 'header' }),
      cell({ row: 1, col: 0, text: rowLabel, role: 'row_header' }),
      cell({ row: 1, col: 1, text: '5', role: 'data', bbox: { x0: 10, y0: y, x1: 30, y1: y + 10 } }),
    ],
  }
}

function highlight(scope: EvidenceSourceScope, rowHeader: string): Highlight & { sourceScope: EvidenceSourceScope } {
  return {
    path: ['records', scope.segmentId.split(':')[1], 'count'],
    value: '5',
    snippet: '5',
    hintPage: scope.startPage,
    rowHeader,
    columnHeader: 'Count',
    sourceScope: scope,
    canonicalSpan: null,
    matchStrategy: 'snippet-primary',
    color: 'rgba(148, 203, 236, 0.55)',
  }
}

function routedMatch(
  tables: ParsedTable[],
  scopes: EvidenceSourceScope[],
  target: Highlight & { sourceScope: EvidenceSourceScope },
) {
  const index = buildSegmentGeometryIndex([], tables, scopes)
  const geometry = index.get(target.sourceScope.segmentId)
  const matches = resolveTableCellMatches(
    geometry?.tables ?? [],
    [target],
    computeOccurrenceIndices([target]),
  )
  return {
    ownedTableIds: geometry?.tables.map((item) => item.tableId) ?? [],
    match: matches.get(target) ?? null,
  }
}

describe('table highlight routing diagnostics', () => {
  const markdown = [
    '# Grave 1',
    '',
    '| Grave | Count |',
    '| --- | --- |',
    '| Grave 1 | 5 |',
    '',
    '# Grave 2',
    '',
    '| Grave | Count |',
    '| --- | --- |',
    '| Grave 2 | 5 |',
  ].join('\n')
  const secondStart = markdown.indexOf('# Grave 2')
  const firstTableStart = markdown.indexOf('| Grave | Count |')
  const secondTableStart = markdown.indexOf('| Grave | Count |', firstTableStart + 1)
  const scopes: EvidenceSourceScope[] = [
    { segmentId: 'catalog:0', markdownStart: 0, markdownEnd: secondStart, startPage: 1, endPage: 1 },
    { segmentId: 'catalog:1', markdownStart: secondStart, markdownEnd: markdown.length, startPage: 1, endPage: 1 },
  ]

  it('shows the full route succeeds for a later segment when its table is linked', () => {
    const tables = [
      table('first', 1, firstTableStart, secondStart - 2, 'Grave 1', 10),
      table('second', 1, secondTableStart, markdown.length, 'Grave 2', 60),
    ]
    const target = highlight(scopes[1], 'Grave 2')

    const route = routedMatch(tables, scopes, target)

    expect(route.ownedTableIds).toEqual(['second'])
    expect(route.match).toEqual({
      pageNumber: 1,
      bbox: { x0: 10, y0: 60, x1: 30, y1: 70 },
    })
  })

  it('shows the route breaks before cell matching when the later table has no canonical offsets', () => {
    const tables = [
      table('first', 1, firstTableStart, secondStart - 2, 'Grave 1', 10),
      table('second', 1, null, null, 'Grave 2', 60),
    ]
    const target = highlight(scopes[1], 'Grave 2')

    const route = routedMatch(tables, scopes, target)

    expect(route.ownedTableIds).toEqual([])
    expect(route.match).toBeNull()
  })
})
