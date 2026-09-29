import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { templateToNodes } from 'extraction/schema'
import {
  buildSpreadsheetTemplate,
  columnFieldIds,
  inferColumnType,
  parseSpreadsheetColumns,
} from './_spreadsheet_schema.js'

describe('parseSpreadsheetColumns', () => {
  it('reads headers from the first row and values from every row after', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['filename', 'species', 'temperature'])
    sheet.addRow(['doc1.pdf', 'Salmon', 4.2])
    sheet.addRow(['doc1.pdf', 'Cod', 3.8])
    const buffer = await workbook.xlsx.writeBuffer()

    const columns = await parseSpreadsheetColumns(buffer as unknown as ArrayBuffer)

    expect(columns).toEqual([
      { columnName: 'filename', values: ['doc1.pdf', 'doc1.pdf'] },
      { columnName: 'species', values: ['Salmon', 'Cod'] },
      { columnName: 'temperature', values: [4.2, 3.8] },
    ])
  })

  it('returns no columns for an empty workbook', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Sheet1')
    const buffer = await workbook.xlsx.writeBuffer()
    expect(await parseSpreadsheetColumns(buffer as unknown as ArrayBuffer)).toEqual([])
  })
})

describe('inferColumnType', () => {
  it('infers a numeric column', () => {
    expect(inferColumnType([4.2, 3.8, 5.0])).toEqual({ type: 'number' })
  })

  it('infers an integer column', () => {
    expect(inferColumnType([1, 2, 3])).toEqual({ type: 'integer' })
  })

  it('infers an enum from a small, repeated set of distinct strings', () => {
    expect(inferColumnType(['Salmon', 'Cod', 'Salmon', 'Trout', 'Cod'])).toEqual({
      type: 'enum',
      allowedValues: ['Salmon', 'Cod', 'Trout'],
    })
  })

  it('infers plain string for many distinct free-text values', () => {
    const values = Array.from({ length: 20 }, (_, i) => `Unique value ${i}`)
    expect(inferColumnType(values)).toEqual({ type: 'string' })
  })

  it('ignores blank cells when inferring', () => {
    expect(inferColumnType([4.2, null, '', 3.8])).toEqual({ type: 'number' })
  })

  it('defaults to string for an entirely empty column', () => {
    expect(inferColumnType([null, '', undefined])).toEqual({ type: 'string' })
  })
})

describe('buildSpreadsheetTemplate', () => {
  const numericColumn = { columnName: 'temperature', values: [4.2, 3.8] }
  const stringColumn = { columnName: 'notes', values: ['a', 'b'] }

  it('builds a flat template with no separator', () => {
    const result = buildSpreadsheetTemplate([numericColumn, stringColumn], null, true)
    expect(result).toEqual({
      ok: true,
      template: { temperature: 'number', notes: 'string' },
      columnPaths: new Map([
        ['temperature', ['temperature']],
        ['notes', ['notes']],
      ]),
    })
  })

  it('treats a dotted header as one literal flat field when no separator is given', () => {
    const result = buildSpreadsheetTemplate(
      [{ columnName: 'measurement.temperature', values: [4.2, 3.8] }],
      null,
      true,
    )
    expect(result).toEqual({
      ok: true,
      template: { 'measurement.temperature': 'number' },
      columnPaths: new Map([['measurement.temperature', ['measurement.temperature']]]),
    })
  })

  it('groups columns sharing a dot-separated prefix into a nested object', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement.temperature', values: [4.2, 3.8] },
        { columnName: 'measurement.unit', values: ['C', 'F', 'C'] },
      ],
      '.',
      true,
    )
    expect(result).toEqual({
      ok: true,
      template: { measurement: { temperature: 'number', unit: ['C', 'F'] } },
      columnPaths: new Map([
        ['measurement.temperature', ['measurement', 'temperature']],
        ['measurement.unit', ['measurement', 'unit']],
      ]),
    })
  })

  it('reports a leaf/group conflict instead of silently resolving it', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement', values: ['x', 'y'] },
        { columnName: 'measurement.temperature', values: [4.2, 3.8] },
      ],
      '.',
      true,
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.conflicts).toEqual([
      ['measurement', 'measurement.temperature'],
    ])
  })

  it('produces a template that round-trips through templateToNodes', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement.temperature', values: [4.2, 3.8] },
        { columnName: 'measurement.unit', values: ['C', 'F', 'C'] },
        { columnName: 'species', values: ['Salmon', 'Cod'] },
      ],
      '.',
      true,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    const nodes = templateToNodes(result.template)
    const measurement = nodes.find((node) => node.name === 'measurement')
    expect(measurement?.type).toBe('object')
    expect(measurement?.children?.map((child) => child.name)).toEqual(['temperature', 'unit'])
    expect(measurement?.children?.find((child) => child.name === 'unit')?.allowedValues).toEqual(['C', 'F'])
    expect(nodes.find((node) => node.name === 'species')?.type).toBe('string')
  })

  it('excludes a "filename" column (case-insensitive) from the template, regardless of purpose', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'Filename', values: ['a.pdf', 'b.pdf'] },
        { columnName: 'species', values: ['Salmon', 'Cod'] },
      ],
      null,
      true,
    )
    expect(result).toEqual({
      ok: true,
      template: { species: 'string' },
      columnPaths: new Map([['species', ['species']]]),
    })
  })

  it('gives every field a plain string type when inferTypesFromValues is false, ignoring cell values', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement.temperature', values: [4.2, 3.8] },
        { columnName: 'measurement.unit', values: ['C', 'F', 'C'] },
        { columnName: 'species', values: ['Salmon', 'Cod'] },
      ],
      '.',
      false,
    )
    expect(result).toEqual({
      ok: true,
      template: { measurement: { temperature: 'string', unit: 'string' }, species: 'string' },
      columnPaths: new Map([
        ['measurement.temperature', ['measurement', 'temperature']],
        ['measurement.unit', ['measurement', 'unit']],
        ['species', ['species']],
      ]),
    })
  })
})

describe('columnFieldIds', () => {
  it('maps each column to the id of the node its path resolved to', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement.temperature', values: [4.2] },
        { columnName: 'species', values: ['Salmon'] },
      ],
      '.',
      true,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    const nodes = templateToNodes(result.template)
    const mapping = columnFieldIds(nodes, result.columnPaths)

    const measurement = nodes.find((node) => node.name === 'measurement')!
    const temperature = measurement.children!.find((node) => node.name === 'temperature')!
    const species = nodes.find((node) => node.name === 'species')!

    expect(mapping).toEqual({
      'measurement.temperature': temperature.id,
      species: species.id,
    })
  })

  it('must be computed once at creation time, before any rename — re-walking by name afterwards fails', () => {
    const result = buildSpreadsheetTemplate([{ columnName: 'species', values: ['Salmon'] }], null, true)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    const nodes = templateToNodes(result.template)

    // Computed immediately, while the tree still matches the column names:
    // this is the id a caller must persist/return right away.
    const idAtCreation = columnFieldIds(nodes, result.columnPaths).species
    expect(idAtCreation).toBe(nodes.find((node) => node.name === 'species')!.id)

    // If a field is later renamed and someone tries to re-derive the mapping
    // by walking the tree by name again, it no longer finds anything --
    // proving the id must be captured up front, not recomputed after edits.
    const renamed = nodes.map((node) => (node.name === 'species' ? { ...node, name: 'organism' } : node))
    expect(columnFieldIds(renamed, result.columnPaths)).toEqual({})
  })
})
