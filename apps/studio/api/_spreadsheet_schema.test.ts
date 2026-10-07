import ExcelJS from 'exceljs'
import { describe, expect, it } from 'vitest'
import { templateToNodes } from 'extraction/schema'
import {
  buildSpreadsheetTemplate,
  columnFieldIds,
  mapGoldRows,
  parseSpreadsheetColumns,
  parseSpreadsheetRows,
} from './_spreadsheet_schema.js'

describe('parseSpreadsheetColumns', () => {
  it('reads the header row and never reads the values below it', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['filename', 'species', 'temperature'])
    sheet.addRow(['doc1.pdf', 'Salmon', 4.2])
    sheet.addRow(['doc1.pdf', 'Cod', 3.8])
    const buffer = await workbook.xlsx.writeBuffer()

    const columns = await parseSpreadsheetColumns(buffer as unknown as ArrayBuffer)

    expect(columns).toEqual([
      { columnName: 'filename' },
      { columnName: 'species' },
      { columnName: 'temperature' },
    ])
  })

  it('skips blank header cells without producing a column', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['species', null, 'temperature'])
    sheet.addRow(['Salmon', 'ignored', 4.2])
    const buffer = await workbook.xlsx.writeBuffer()

    expect(await parseSpreadsheetColumns(buffer as unknown as ArrayBuffer)).toEqual([
      { columnName: 'species' },
      { columnName: 'temperature' },
    ])
  })

  it('returns no columns for an empty workbook', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Sheet1')
    const buffer = await workbook.xlsx.writeBuffer()
    expect(await parseSpreadsheetColumns(buffer as unknown as ArrayBuffer)).toEqual([])
  })
})

describe('parseSpreadsheetRows', () => {
  it('keeps the header and each non-blank data row keyed by column name', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow(['filename', 'species', 'temperature'])
    sheet.addRow(['doc1.pdf', 'Salmon', 4.2])
    sheet.addRow(['doc1.pdf', 'Cod', null])
    sheet.addRow([null, null, null])
    const buffer = await workbook.xlsx.writeBuffer()

    const parsed = await parseSpreadsheetRows(buffer as unknown as ArrayBuffer)

    expect(parsed.columns).toEqual([
      { columnName: 'filename' },
      { columnName: 'species' },
      { columnName: 'temperature' },
    ])
    expect(parsed.rows).toEqual([
      { filename: 'doc1.pdf', species: 'Salmon', temperature: '4.2' },
      { filename: 'doc1.pdf', species: 'Cod', temperature: '' },
    ])
  })

  it('returns no rows when the workbook has no header row', async () => {
    const workbook = new ExcelJS.Workbook()
    const sheet = workbook.addWorksheet('Sheet1')
    sheet.addRow([null, null])
    sheet.addRow(['ignored', 'ignored'])
    const buffer = await workbook.xlsx.writeBuffer()

    expect(await parseSpreadsheetRows(buffer as unknown as ArrayBuffer)).toEqual({
      columns: [],
      rows: [],
    })
  })

  it('returns nothing for a worksheet with no rows', async () => {
    const workbook = new ExcelJS.Workbook()
    workbook.addWorksheet('Sheet1')
    const buffer = await workbook.xlsx.writeBuffer()
    expect(await parseSpreadsheetRows(buffer as unknown as ArrayBuffer)).toEqual({
      columns: [],
      rows: [],
    })
  })
})

describe('mapGoldRows', () => {
  const documents = [
    { sourceDocumentId: 'doc-a', filename: 'Bauer1988 GAC.pdf' },
    { sourceDocumentId: 'doc-b', filename: 'Harvey 1990.pdf' },
  ]

  it('groups rows by matched document and reports the unmatched ones', () => {
    const parsed = {
      columns: [{ columnName: 'filename' }, { columnName: 'species' }],
      rows: [
        { filename: 'sources/Bauer1988 GAC.pdf', species: 'Salmon' },
        { filename: 'bauer1988 gac', species: 'Cod' },
        { filename: 'Harvey 1990.pdf', species: 'Trout' },
        { filename: 'Unknown.pdf', species: 'Pike' },
      ],
    }

    expect(mapGoldRows(parsed, documents)).toEqual({
      ok: true,
      documents: [
        {
          sourceDocumentId: 'doc-a',
          filename: 'Bauer1988 GAC.pdf',
          rows: [{ species: 'Salmon' }, { species: 'Cod' }],
        },
        {
          sourceDocumentId: 'doc-b',
          filename: 'Harvey 1990.pdf',
          rows: [{ species: 'Trout' }],
        },
      ],
      unmatched: [
        { filename: 'Unknown.pdf', known: ['Bauer1988 GAC.pdf', 'Harvey 1990.pdf'] },
      ],
    })
  })

  it('reports a blank file-name cell as unmatched rather than mapping it', () => {
    const parsed = {
      columns: [{ columnName: 'filename' }, { columnName: 'species' }],
      rows: [{ filename: '', species: 'Salmon' }],
    }
    expect(mapGoldRows(parsed, documents)).toEqual({
      ok: true,
      documents: [],
      unmatched: [{ filename: '', known: ['Bauer1988 GAC.pdf', 'Harvey 1990.pdf'] }],
    })
  })

  it('reports a missing file-name column instead of mapping every row', () => {
    const parsed = {
      columns: [{ columnName: 'species' }],
      rows: [{ species: 'Salmon' }],
    }
    expect(mapGoldRows(parsed, documents)).toEqual({
      ok: false,
      reason: 'filename_column_missing',
    })
  })
})

describe('buildSpreadsheetTemplate', () => {
  const temperature = { columnName: 'temperature' }
  const notes = { columnName: 'notes' }

  it('builds a flat template of plain strings with no separator', () => {
    expect(buildSpreadsheetTemplate([temperature, notes], null)).toEqual({
      ok: true,
      template: { temperature: 'string', notes: 'string' },
      columnPaths: new Map([
        ['temperature', ['temperature']],
        ['notes', ['notes']],
      ]),
    })
  })

  it('treats a dotted header as one literal flat field when no separator is given', () => {
    expect(buildSpreadsheetTemplate([{ columnName: 'measurement.temperature' }], null)).toEqual({
      ok: true,
      template: { 'measurement.temperature': 'string' },
      columnPaths: new Map([['measurement.temperature', ['measurement.temperature']]]),
    })
  })

  it('groups columns sharing a dot-separated prefix into a nested object', () => {
    expect(
      buildSpreadsheetTemplate(
        [
          { columnName: 'measurement.temperature' },
          { columnName: 'measurement.unit' },
        ],
        '.',
      ),
    ).toEqual({
      ok: true,
      template: { measurement: { temperature: 'string', unit: 'string' } },
      columnPaths: new Map([
        ['measurement.temperature', ['measurement', 'temperature']],
        ['measurement.unit', ['measurement', 'unit']],
      ]),
    })
  })

  it('reports a leaf/group conflict instead of silently resolving it', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement' },
        { columnName: 'measurement.temperature' },
      ],
      '.',
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.conflicts).toEqual([
      ['measurement', 'measurement.temperature'],
    ])
  })

  it('produces a template that round-trips through templateToNodes', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement.temperature' },
        { columnName: 'measurement.unit' },
        { columnName: 'species' },
      ],
      '.',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    const nodes = templateToNodes(result.template)
    const measurement = nodes.find((node) => node.name === 'measurement')
    expect(measurement?.type).toBe('object')
    expect(measurement?.children?.map((child) => child.name)).toEqual(['temperature', 'unit'])
    expect(measurement?.children?.every((child) => child.type === 'string')).toBe(true)
    expect(nodes.find((node) => node.name === 'species')?.type).toBe('string')
  })

  it('excludes a "filename" column (case-insensitive) from the template, regardless of purpose', () => {
    const result = buildSpreadsheetTemplate(
      [{ columnName: 'Filename' }, { columnName: 'species' }],
      null,
    )
    expect(result).toEqual({
      ok: true,
      template: { species: 'string' },
      columnPaths: new Map([['species', ['species']]]),
    })
  })
})

describe('columnFieldIds', () => {
  it('maps each column to the id of the node its path resolved to', () => {
    const result = buildSpreadsheetTemplate(
      [
        { columnName: 'measurement.temperature' },
        { columnName: 'species' },
      ],
      '.',
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
    const result = buildSpreadsheetTemplate([{ columnName: 'species' }], null)
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
