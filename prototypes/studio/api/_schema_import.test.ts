// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import ExcelJS from 'exceljs'
import { zipSync } from 'fflate'
import { preflightWorkbook, previewWorkbook } from './_schema_import.js'
import { IMPORT_LIMITS, importDefinition, type ImportColumn } from '../shared/schemaImport.js'
import { createResearcherApiHandlers } from './schema_import_preview.js'

async function workbook(rows: unknown[][], setup?: (sheet: ExcelJS.Worksheet) => void) {
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet('Codebook')
  rows.forEach((row) => sheet.addRow(row)); setup?.(sheet)
  return new Uint8Array(await book.xlsx.writeBuffer())
}
const field = (name: string, column = 1): ImportColumn => ({ id: `column-${column}`, column, name, type: 'string', include: true,
  examples: [], choices: ['A', 'B'], kinds: ['text'], suggestedType: 'string' })

describe('bounded workbook preview', () => {
  it('requires sheet selection, leaves identifiers as strings and makes representations explicit', async () => {
    const input = await workbook([['filename', 'id', 'rich', 'formula', 'date'], ['0012', 12, { richText: [{ text: 'Rich' }, { text: ' text' }] },
      { formula: '1+1', result: 2 }, new Date('2026-09-30T00:00:00Z')]], (sheet) => { sheet.getCell('B2').numFmt = '0000' })
    expect((await previewWorkbook(input, null, 1)).columns).toEqual([])
    const preview = await previewWorkbook(input, 'Codebook', 1)
    expect(preview.columns[0]?.name).toBe('filename')
    expect(preview.columns[0]?.examples).toEqual(['0012'])
    expect(preview.columns[1]?.examples).toEqual(['0012'])
    expect(preview.columns.every((column) => column.type === 'string')).toBe(true)
    expect(preview.columns[2]?.kinds).toContain('rich text (text only)')
    expect(preview.columns[3]?.kinds).toContain('cached formula result')
    expect(preview.columns[4]?.kinds).toContain('date (ISO)')
  })
  it('accepts exactly 200 columns and 5,000 data rows and refuses the next cell', async () => {
    expect((await previewWorkbook(await workbook([Array.from({ length: 200 }, (_, i) => `field${i}`)]), 'Codebook', 1)).columns).toHaveLength(200)
    await expect(previewWorkbook(await workbook([Array.from({ length: 201 }, (_, i) => `field${i}`)]), 'Codebook', 1)).rejects.toThrow('column 201')
    expect((await previewWorkbook(await workbook([['name'], ...Array.from({ length: 5000 }, () => ['row'])]), 'Codebook', 1)).columns).toHaveLength(1)
    await expect(previewWorkbook(await workbook([['name'], ...Array.from({ length: 5001 }, () => ['row'])]), 'Codebook', 1)).rejects.toThrow('5,000 data rows')
  })
  it('refuses merged headers, unsupported cells and excessive decoded shared strings', async () => {
    await expect(previewWorkbook(await workbook([['a', 'b']], (sheet) => sheet.mergeCells('A1:B1')), 'Codebook', 1)).rejects.toThrow('Merged header A1:B1')
    await expect(previewWorkbook(await workbook([['a'], [{ error: '#DIV/0!' }]]), 'Codebook', 1)).rejects.toThrow('Cell A2')
    await expect(previewWorkbook(await workbook([['a'], ['x'.repeat(IMPORT_LIMITS.cell + 1)]]), 'Codebook', 1)).rejects.toThrow('64 KiB')
    expect((await previewWorkbook(await workbook([['a'], ['x'.repeat(IMPORT_LIMITS.cell)]]), 'Codebook', 1)).columns).toHaveLength(1)
  })
  it('checks compressed, declared and actual ZIP limits before constructing ExcelJS', async () => {
    const reader = vi.spyOn(ExcelJS.stream.xlsx, 'WorkbookReader')
    const overhead = zipSync({ padding: new Uint8Array() }, { level: 0 }).length
    expect(preflightWorkbook(zipSync({ padding: new Uint8Array(IMPORT_LIMITS.compressed - overhead) }, { level: 0 })).size).toBe(1)
    expect(() => preflightWorkbook(new Uint8Array(IMPORT_LIMITS.compressed + 1))).toThrow('5 MiB')
    expect(preflightWorkbook(zipSync({ padding: new Uint8Array(IMPORT_LIMITS.expanded) })).get('padding')?.length).toBe(IMPORT_LIMITS.expanded)
    const bomb = zipSync({ padding: new Uint8Array(IMPORT_LIMITS.expanded + 1) }), view = new DataView(bomb.buffer)
    await expect(previewWorkbook(bomb, 'Codebook', 1)).rejects.toThrow('25 MiB')
    for (let at = 0; at < bomb.length - 46; at++) if (view.getUint32(at, true) === 0x02014b50) view.setUint32(at + 24, 0, true)
    await expect(previewWorkbook(bomb, 'Codebook', 1)).rejects.toThrow('actual expanded')
    expect(reader).not.toHaveBeenCalled(); reader.mockRestore()
  })
  it('rejects dangerous ZIP names and ownership before parsing or any save', async () => {
    for (const name of ['../workbook.xml', '/workbook.xml', 'xl\\workbook.xml'])
      expect(() => preflightWorkbook(zipSync({ [name]: new Uint8Array() }))).toThrow('Invalid ZIP entry name')
    expect(() => preflightWorkbook(zipSync({ 'xl/A.xml': new Uint8Array(), 'xl/a.xml': new Uint8Array() }))).toThrow('Duplicate or ambiguous')
    expect(() => preflightWorkbook(zipSync({ 'xl/vbaProject.bin': new Uint8Array() }))).toThrow('Macro-enabled')
    const store = { getProjectContextWithDocuments: vi.fn().mockResolvedValue(null) }
    const { POST } = createResearcherApiHandlers(store as never)
    const response = await POST(new Request('http://localhost/api/schema_import_preview?projectContextId=11111111-1111-4111-8111-111111111111&filename=code.xlsx', { method: 'POST', body: 'not a workbook' }))
    expect(response.status).toBe(404)
    expect(Object.keys(store)).toEqual(['getProjectContextWithDocuments'])
  })
})

describe('schema import confirmation', () => {
  it.each(['__proto__.x', 'constructor.prototype.x', 'a..b', '.a', 'a.'])('rejects ambiguous paths with column context: %s', (name) => {
    expect(() => importDefinition([field(name)], 'Records', '.', new Map())).toThrow('Column 1')
    expect(Object.hasOwn(Object.prototype, 'x')).toBe(false)
  })
  it('rejects duplicates, blanks, collisions and repeated IDs; flat separators stay literal', () => {
    for (const names of [['a', 'a'], ['a', 'a.b'], ['a.b', 'a'], ['']])
      expect(() => importDefinition(names.map((name, i) => field(name, i + 1)), 'Records', '.', new Map())).toThrow('Column')
    expect(() => importDefinition([field('a'), field('b')], 'Records', '', new Map())).toThrow('duplicate node')
    expect(importDefinition([field('a.b')], 'Records', '', new Map()).schemaNodes[0]?.name).toBe('a.b')
  })
  it('keeps IDs through rename/type edits and adds enums only when selected', () => {
    const columns = [field('id'), field('group.name', 2)], groups = new Map<string, string>()
    const first = importDefinition(columns, 'Records', '.', groups)
    columns[0]!.name = 'identifier'; columns[0]!.type = 'number'
    const second = importDefinition(columns, 'Records', '.', groups)
    expect(second.schemaNodes.map((node) => node.id)).toEqual(first.schemaNodes.map((node) => node.id))
    expect(first.schemaNodes[0]?.allowedValues).toBeUndefined()
    columns[0]!.enum = true
    expect(importDefinition(columns, 'Records', '.', groups).schemaNodes[0]?.allowedValues).toEqual(['A', 'B'])
  })
  it('keeps group identities through group renames and include/exclude edits', () => {
    const columns = [field('group.a'), field('group.b', 2)], groups = new Map<string, string>()
    const first = importDefinition(columns, 'Records', '.', groups)
    columns.forEach((column) => { column.name = column.name.replace('group', 'renamed') })
    expect(importDefinition(columns, 'Records', '.', groups).schemaNodes[0]?.id).toBe(first.schemaNodes[0]?.id)
    columns[0]!.include = false
    expect(importDefinition(columns, 'Records', '.', groups).schemaNodes[0]?.id).toBe(first.schemaNodes[0]?.id)
  })
})
