import { describe, expect, it } from 'vitest'
import { findTableCellMatch, computeOccurrenceIndices } from './tableCellMatch'
import type { ParsedTable, TableCell } from './parsedDocument'

function cell(partial: Partial<TableCell> & Pick<TableCell, 'row' | 'col' | 'text'>): TableCell {
  return { role: null, bbox: null, ...partial }
}

function table(tableId: string, pageNumber: number, cells: TableCell[]): ParsedTable {
  return { tableId, pageNumber, cells }
}

// Two-row grave table sharing the value "5" in a single "Count" column.
function graveTable(): ParsedTable {
  return table('t1', 1, [
    cell({ row: 0, col: 0, text: 'Grave', role: 'header' }),
    cell({ row: 0, col: 1, text: 'Count', role: 'header' }),
    cell({ row: 1, col: 0, text: 'Grave 1', role: 'row_header' }),
    cell({ row: 1, col: 1, text: '5', role: 'data', bbox: { x0: 0, y0: 10, x1: 10, y1: 20 } }),
    cell({ row: 2, col: 0, text: 'Grave 2', role: 'row_header' }),
    cell({ row: 2, col: 1, text: '5', role: 'data', bbox: { x0: 0, y0: 30, x1: 10, y1: 40 } }),
  ])
}

describe('findTableCellMatch', () => {
  it('resolves directly when exactly one cell matches the value', () => {
    const t = table('t1', 1, [
      cell({ row: 0, col: 0, text: 'Depth', role: 'header' }),
      cell({ row: 1, col: 0, text: '42 cm', role: 'data', bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } }),
    ])

    const match = findTableCellMatch([t], '42 cm', null, null, null, null)

    expect(match).toEqual({ pageNumber: 1, bbox: { x0: 1, y0: 2, x1: 3, y1: 4 } })
  })

  it('narrows duplicate candidates using the row header hint alone', () => {
    const match = findTableCellMatch([graveTable()], '5', 'Grave 2', null, null, null)

    expect(match).toEqual({ pageNumber: 1, bbox: { x0: 0, y0: 30, x1: 10, y1: 40 } })
  })

  it('narrows duplicate candidates using the column header hint alone', () => {
    const t = table('t1', 1, [
      cell({ row: 0, col: 0, text: 'Label', role: 'header' }),
      cell({ row: 0, col: 1, text: 'Weight', role: 'header' }),
      cell({ row: 0, col: 2, text: 'Count', role: 'header' }),
      cell({ row: 1, col: 0, text: 'Item A', role: 'row_header' }),
      cell({ row: 1, col: 1, text: '5', role: 'data', bbox: { x0: 0, y0: 10, x1: 10, y1: 20 } }),
      cell({ row: 1, col: 2, text: '5', role: 'data', bbox: { x0: 20, y0: 10, x1: 30, y1: 20 } }),
    ])

    const match = findTableCellMatch([t], '5', null, 'Count', null, null)

    expect(match).toEqual({ pageNumber: 1, bbox: { x0: 20, y0: 10, x1: 30, y1: 20 } })
  })

  it('narrows duplicate candidates using both row and column header hints', () => {
    const match = findTableCellMatch([graveTable()], '5', 'Grave 1', 'Count', null, null)

    expect(match).toEqual({ pageNumber: 1, bbox: { x0: 0, y0: 10, x1: 10, y1: 20 } })
  })

  it('falls through to reading-order positional fallback when no header hints are given', () => {
    const match = findTableCellMatch([graveTable()], '5', null, null, null, 1)

    // Sorted by (page, y0, x0): index 0 -> y0=10, index 1 -> y0=30.
    expect(match).toEqual({ pageNumber: 1, bbox: { x0: 0, y0: 30, x1: 10, y1: 40 } })
  })

  it('falls through to positional fallback when header hints do not narrow to one', () => {
    const match = findTableCellMatch([graveTable()], '5', 'Grave 3 (typo, matches nothing)', null, null, 0)

    expect(match).toEqual({ pageNumber: 1, bbox: { x0: 0, y0: 10, x1: 10, y1: 20 } })
  })

  it('returns no match when the positional index is out of range', () => {
    const match = findTableCellMatch([graveTable()], '5', null, null, null, 5)

    expect(match).toBeNull()
  })

  it('returns no match when disambiguation is inconclusive and no occurrence index is available', () => {
    const match = findTableCellMatch([graveTable()], '5', null, null, null, null)

    expect(match).toBeNull()
  })

  it('narrows to the hinted page before considering header hints', () => {
    const onPageOne = table('t1', 1, [cell({ row: 0, col: 0, text: '5', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } })])
    const onPageTwo = table('t2', 2, [cell({ row: 0, col: 0, text: '5', bbox: { x0: 2, y0: 2, x1: 3, y1: 3 } })])

    const match = findTableCellMatch([onPageOne, onPageTwo], '5', null, null, 2, null)

    expect(match).toEqual({ pageNumber: 2, bbox: { x0: 2, y0: 2, x1: 3, y1: 3 } })
  })

  it('returns no match when no table cell contains the value', () => {
    expect(findTableCellMatch([graveTable()], 'nonexistent', null, null, null, null)).toBeNull()
  })

  it('returns no match when no tables are supplied', () => {
    expect(findTableCellMatch([], '5', null, null, null, null)).toBeNull()
  })

  it('returns no match when the sole candidate has no bbox', () => {
    const t = table('t1', 1, [cell({ row: 0, col: 0, text: 'Unlocated' })])

    expect(findTableCellMatch([t], 'Unlocated', null, null, null, null)).toBeNull()
  })
})

describe('computeOccurrenceIndices', () => {
  it('ranks by occurrence among ties on the same field key and value, not by array position', () => {
    // Mirrors the real case that exposed the bug: a flattened records array
    // spanning multiple unrelated tables, where only two of many records
    // share an identical value for the same field.
    const highlights = [
      { path: ['records', '0', 'beskrivelse'], value: '8-1 unrelated', hintPage: 1 },
      { path: ['records', '1', 'beskrivelse'], value: 'Dele af lårben', hintPage: 1 },
      { path: ['records', '2', 'beskrivelse'], value: 'Dele af lårben', hintPage: 1 },
      { path: ['records', '3', 'beskrivelse'], value: '8-2 unrelated', hintPage: 1 },
    ]

    const indices = computeOccurrenceIndices(highlights)

    expect(indices.get(highlights[0])).toBe(0)
    expect(indices.get(highlights[1])).toBe(0) // first occurrence of the tied value
    expect(indices.get(highlights[2])).toBe(1) // second occurrence, NOT its array index (2)
    expect(indices.get(highlights[3])).toBe(0)
  })

  it('keys occurrence counts by field (last path segment), not just value', () => {
    const highlights = [
      { path: ['records', '0', 'nummer'], value: 'Meget fragmenteret', hintPage: 1 },
      { path: ['records', '0', 'bemaerkninger'], value: 'Meget fragmenteret', hintPage: 1 },
      { path: ['records', '1', 'bemaerkninger'], value: 'Meget fragmenteret', hintPage: 1 },
    ]

    const indices = computeOccurrenceIndices(highlights)

    expect(indices.get(highlights[0])).toBe(0) // different field key -> its own count
    expect(indices.get(highlights[1])).toBe(0)
    expect(indices.get(highlights[2])).toBe(1)
  })

  it('normalizes whitespace/case when grouping ties', () => {
    const highlights = [
      { path: ['records', '0', 'name'], value: '  Grave   1  ', hintPage: 1 },
      { path: ['records', '1', 'name'], value: 'grave 1', hintPage: 1 },
    ]

    const indices = computeOccurrenceIndices(highlights)

    expect(indices.get(highlights[0])).toBe(0)
    expect(indices.get(highlights[1])).toBe(1)
  })

  it('groups occurrence counts per hint page, matching how candidates get page-narrowed', () => {
    // A second duplicate pair on a later page must restart its own count at 0,
    // since findTableCellMatch narrows candidates to a single page before
    // indexing into them (see the real Grav 8 / Grav 13 case this fixes).
    const highlights = [
      { path: ['records', '1', 'bemaerkninger'], value: 'Meget fragmenteret', hintPage: 1 },
      { path: ['records', '2', 'bemaerkninger'], value: 'Meget fragmenteret', hintPage: 1 },
      { path: ['records', '4', 'bemaerkninger'], value: 'Meget fragmenteret', hintPage: 2 },
      { path: ['records', '8', 'bemaerkninger'], value: 'Meget fragmenteret', hintPage: 2 },
    ]

    const indices = computeOccurrenceIndices(highlights)

    expect(indices.get(highlights[0])).toBe(0)
    expect(indices.get(highlights[1])).toBe(1)
    expect(indices.get(highlights[2])).toBe(0) // restarts for page 2, not global index 2
    expect(indices.get(highlights[3])).toBe(1)
  })
})
