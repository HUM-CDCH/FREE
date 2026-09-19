import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildGoldRecordFields,
  goldFilenameColumnValues,
  goldSpreadsheetRowCount,
  isGoldFilenameColumn,
} from './gold-spreadsheet.js'
import type { SchemaNode } from './schema.js'

describe('isGoldFilenameColumn', () => {
  it('matches "filename" case- and whitespace-insensitively', () => {
    assert.equal(isGoldFilenameColumn('filename'), true)
    assert.equal(isGoldFilenameColumn('Filename'), true)
    assert.equal(isGoldFilenameColumn('  FILENAME  '), true)
  })

  it('does not match an unrelated column name', () => {
    assert.equal(isGoldFilenameColumn('species'), false)
    assert.equal(isGoldFilenameColumn('file'), false)
  })
})

describe('buildGoldRecordFields', () => {
  const nodes: SchemaNode[] = [
    { id: 'species-id', name: 'species', type: 'string' },
    {
      id: 'measurement-id',
      name: 'measurement',
      type: 'object',
      children: [
        { id: 'temp-id', name: 'temperature', type: 'number' },
      ],
    },
  ]
  const mapping = { species: 'species-id', 'measurement.temperature': 'temp-id' }
  const columns = [
    { columnName: 'filename', values: ['a.pdf', 'b.pdf'] },
    { columnName: 'species', values: ['Salmon', 'Cod'] },
    { columnName: 'measurement.temperature', values: [4.2, 3.8] },
  ]

  it('builds one row shaped like the target schema, excluding the filename column', () => {
    assert.deepEqual(buildGoldRecordFields(nodes, mapping, columns, 0), {
      species: 'Salmon',
      measurement: { temperature: 4.2 },
    })
    assert.deepEqual(buildGoldRecordFields(nodes, mapping, columns, 1), {
      species: 'Cod',
      measurement: { temperature: 3.8 },
    })
  })

  it('still resolves a column whose mapped field was renamed after suggestion creation', () => {
    const renamedNodes: SchemaNode[] = [
      { id: 'species-id', name: 'renamed_species', type: 'string' },
    ]
    const result = buildGoldRecordFields(
      renamedNodes,
      { species: 'species-id' },
      [{ columnName: 'species', values: ['Salmon'] }],
      0,
    )
    assert.deepEqual(result, { renamed_species: 'Salmon' })
  })

  it('skips a column with no resolvable mapping rather than failing the record', () => {
    const result = buildGoldRecordFields(
      nodes,
      {},
      [{ columnName: 'species', values: ['Salmon'] }],
      0,
    )
    assert.deepEqual(result, {})
  })
})

describe('goldFilenameColumnValues / goldSpreadsheetRowCount', () => {
  it('finds the filename column values, or null when absent', () => {
    const columns = [
      { columnName: 'filename', values: ['a.pdf', 'b.pdf'] },
      { columnName: 'species', values: ['Salmon', 'Cod'] },
    ]
    assert.deepEqual(goldFilenameColumnValues(columns), ['a.pdf', 'b.pdf'])
    assert.equal(
      goldFilenameColumnValues([{ columnName: 'species', values: ['x'] }]),
      null,
    )
  })

  it('counts rows from the longest column', () => {
    assert.equal(
      goldSpreadsheetRowCount([
        { columnName: 'a', values: [1, 2, 3] },
        { columnName: 'b', values: [1] },
      ]),
      3,
    )
    assert.equal(goldSpreadsheetRowCount([]), 0)
  })
})
