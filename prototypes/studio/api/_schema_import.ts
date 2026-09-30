import ExcelJS from 'exceljs'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { Unzip, UnzipInflate, zipSync, type UnzipFile } from 'fflate'
import { SaxesParser } from 'saxes'
import { IMPORT_LIMITS, type ImportColumn } from '../shared/schemaImport.js'

export class SchemaImportError extends Error {}
function refuse(message: string): never { throw new SchemaImportError(message) }
const utf8 = new TextDecoder('utf-8', { fatal: true })
const bytes = (text: string) => Buffer.byteLength(text, 'utf8')

/** Validate central/local identity and flags before inflation; declared sizes are only an early check. */
function zipDirectory(input: Uint8Array) {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  let end = input.length - 22
  while (end >= Math.max(0, input.length - 65557) && view.getUint32(end, true) !== 0x06054b50) end--
  if (end < 0 || view.getUint32(end, true) !== 0x06054b50 || end + 22 + view.getUint16(end + 20, true) !== input.length || view.getUint32(end + 4, true) !== 0)
    refuse('An unencrypted .xlsx ZIP workbook is required.')
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true)
  if (count === 0 || count > 1000 || start + view.getUint32(end + 12, true) !== end) refuse('Unsupported workbook ZIP directory.')
  const entries = new Map<string, number>(), normalized = new Set<string>()
  let at = start, declared = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) refuse('Invalid workbook ZIP entry.')
    const flags = view.getUint16(at + 8, true), method = view.getUint16(at + 10, true)
    const length = view.getUint16(at + 28, true), next = at + 46 + length + view.getUint16(at + 30, true) + view.getUint16(at + 32, true)
    if (next > end || (flags & 1) || ![0, 8].includes(method)) refuse('Encrypted or unsupported workbook ZIP entry.')
    const name = utf8.decode(input.subarray(at + 46, at + 46 + length))
    if (!name || name.startsWith('/') || name.includes('\\') || [...name].some((char) => char.charCodeAt(0) < 32) || name.replace(/\/$/, '').split('/').some((part) => !part || part === '.' || part === '..'))
      refuse(`Invalid ZIP entry name: ${name.slice(0, 80)}`)
    const identity = name.normalize('NFC').toLowerCase().replace(/\/$/, '')
    if (normalized.has(identity)) refuse(`Duplicate or ambiguous ZIP entry: ${name}`)
    normalized.add(identity)
    if (/vbaProject|encryptedPackage/i.test(name)) refuse('Macro-enabled and encrypted workbooks are unsupported.')
    const size = view.getUint32(at + 24, true), local = view.getUint32(at + 42, true)
    declared += size
    if (size === 0xffffffff || declared > IMPORT_LIMITS.expanded) refuse('Workbook exceeds 25 MiB expanded ZIP bytes.')
    if (local + 30 > start || view.getUint32(local, true) !== 0x04034b50 || view.getUint16(local + 6, true) !== flags || view.getUint16(local + 8, true) !== method ||
      utf8.decode(input.subarray(local + 30, local + 30 + view.getUint16(local + 26, true))) !== name)
      refuse('Ambiguous workbook ZIP headers.')
    entries.set(name, size)
    at = next
  }
  if (at !== end) refuse('Unsupported workbook ZIP directory.')
  return entries
}

/** Count actual output from every entry, including omitted/lying local sizes, before ExcelJS can run. */
export function preflightWorkbook(input: Uint8Array) {
  if (input.length > IMPORT_LIMITS.compressed) refuse('Workbook exceeds 5 MiB compressed input.')
  const declared = zipDirectory(input), files = new Map<string, Uint8Array>(), streams: UnzipFile[] = [], seen = new Set<string>()
  let expanded = 0
  try {
    const unzip = new Unzip((file) => {
      if (!declared.has(file.name) || seen.has(file.name)) refuse('Ambiguous ZIP entries.')
      seen.add(file.name)
      streams.push(file)
      const chunks: Uint8Array[] = []
      let size = 0
      file.ondata = (error, chunk, final) => {
        if (error) throw error
        expanded += chunk.length
        size += chunk.length
        if (expanded > IMPORT_LIMITS.expanded) refuse('Workbook exceeds 25 MiB actual expanded ZIP bytes.')
        chunks.push(chunk)
        if (final) {
          if (size !== declared.get(file.name)) refuse(`Incorrect ZIP size for ${file.name}.`)
          const data = new Uint8Array(size)
          let at = 0
          for (const part of chunks) { data.set(part, at); at += part.length }
          files.set(file.name, data)
        }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    for (let at = 0; at < input.length; at += 4096) unzip.push(input.subarray(at, at + 4096), at + 4096 >= input.length)
    if (files.size !== declared.size) refuse('Incomplete workbook ZIP entries.')
    return files
  } catch (error) {
    if (error instanceof SchemaImportError) throw error
    refuse('Invalid .xlsx workbook ZIP data.')
  } finally { streams.forEach((file) => file.terminate()) }
}

function xml(files: Map<string, Uint8Array>, name: string, configure: (parser: SaxesParser) => void) {
  const data = files.get(name)
  if (!data) refuse(`Workbook is missing ${name}.`)
  const parser = new SaxesParser()
  parser.on('doctype', () => refuse('XML document types are unsupported.'))
  configure(parser)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let at = 0; at < data.length; at += 4096) parser.write(decoder.decode(data.subarray(at, at + 4096), { stream: true }))
  parser.write(decoder.decode()).close()
}
const localName = (name: string) => name.split(':').at(-1)
const coordinate = (reference: string) => {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(reference)
  if (!match) return refuse(`Unsupported cell reference ${reference}.`)
  return { row: Number(match[2]), column: [...match[1]!].reduce((column, char) => column * 26 + char.charCodeAt(0) - 64, 0) }
}

function inspectCells(files: Map<string, Uint8Array>, sheet: string, header: number) {
  let sharedSize = 0
  if (files.has('xl/sharedStrings.xml')) xml(files, 'xl/sharedStrings.xml', (parser) => {
    parser.on('opentag', (tag) => { if (localName(tag.name) === 'si') sharedSize = 0 })
    parser.on('text', (text) => { sharedSize += bytes(text); if (sharedSize > IMPORT_LIMITS.cell) refuse('Shared string exceeds 64 KiB decoded cell limit.') })
  })
  let reference = '', textSize = 0, inCell = false, numeric = false, inValue = false, raw = ''
  const rawNumbers = new Map<string, string>()
  xml(files, sheet, (parser) => {
    parser.on('opentag', (tag) => {
      const name = localName(tag.name)
      if (name === 'row' && Number(tag.attributes.r) > header + IMPORT_LIMITS.rows) refuse(`Row ${tag.attributes.r}: exceeds 5,000 data rows.`)
      if (name === 'mergeCell') {
        const [from, to = from] = String(tag.attributes.ref).split(':').map(coordinate)
        if (from!.row <= header && to!.row >= header) refuse(`Merged header ${tag.attributes.ref}: rename/unmerge the header columns.`)
      }
      if (name === 'c') {
        reference = String(tag.attributes.r); const { row, column } = coordinate(reference)
        if (column > IMPORT_LIMITS.columns) refuse(`Row ${row}, column ${column}: exceeds 200 columns.`)
        if (row > header + IMPORT_LIMITS.rows) refuse(`Row ${row}, column ${column}: exceeds 5,000 data rows.`)
        textSize = 0; raw = ''; inCell = true; numeric = !tag.attributes.t || tag.attributes.t === 'n'
      }
      inValue = name === 'v'
    })
    parser.on('text', (text) => {
      if (inCell) { textSize += bytes(text); if (textSize > IMPORT_LIMITS.cell) refuse(`Cell ${reference}: exceeds 64 KiB decoded cell limit.`) }
      if (inValue && numeric) raw += text
    })
    parser.on('closetag', (tag) => {
      if (localName(tag.name) === 'v') inValue = false
      if (localName(tag.name) === 'c') { if (numeric && raw) rawNumbers.set(reference, raw); inCell = false }
    })
  })
  return rawNumbers
}

function cellText(cell: ExcelJS.Cell, raw: string | undefined): { text: string; kind: string; numeric: boolean } {
  let value = cell.value, kind = 'text'
  if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value)) {
    if (!('result' in value) || value.result === undefined) refuse(`Cell ${cell.address}: formula has no cached result.`)
    value = value.result; kind = 'cached formula result'
  }
  if (value == null) return { text: '', kind, numeric: false }
  if (value instanceof Date) return { text: value.toISOString(), kind: `${kind === 'text' ? '' : kind + ' · '}date (ISO)`, numeric: false }
  if (typeof value === 'object' && 'richText' in value)
    return { text: value.richText.map((run) => run.text).join(''), kind: 'rich text (text only)', numeric: false }
  if (typeof value === 'boolean') return { text: String(value), kind: 'boolean', numeric: false }
  if (typeof value === 'number') {
    const padded = /^0{2,}$/.test(cell.numFmt) && Number.isSafeInteger(value)
    return { text: padded ? String(value).padStart(cell.numFmt.length, '0') : raw ?? String(value),
      kind: padded ? 'formatted identifier' : kind === 'text' ? 'number' : kind,
      numeric: !padded && Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) && (raw === undefined || String(value) === raw) }
  }
  if (typeof value !== 'string') return refuse(`Cell ${cell.address}: unsupported cell representation.`)
  return { text: value, kind, numeric: false }
}

export async function previewWorkbook(input: Uint8Array, worksheet: string | null, headerRow: number) {
  const files = preflightWorkbook(input) // Must finish before constructing WorkbookReader.
  const sheets: { name: string; relation: string }[] = [], relations = new Map<string, string>()
  let xlsx = false
  xml(files, '[Content_Types].xml', (parser) => parser.on('opentag', (tag) => {
    const type = String(tag.attributes.ContentType ?? '')
    if (/macroEnabled|vbaProject|encrypted/i.test(type)) refuse('Only ordinary .xlsx workbooks are supported.')
    if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') xlsx = true
  }))
  if (!xlsx) refuse('Only ordinary .xlsx workbooks are supported.')
  xml(files, 'xl/workbook.xml', (parser) => parser.on('opentag', (tag) => {
    if (localName(tag.name) === 'sheet') sheets.push({ name: String(tag.attributes.name), relation: String(tag.attributes['r:id']) })
  }))
  xml(files, 'xl/_rels/workbook.xml.rels', (parser) => parser.on('opentag', (tag) => {
    if (localName(tag.name) === 'Relationship') {
      if (tag.attributes.TargetMode === 'External') return
      const target = String(tag.attributes.Target).replace(/^\//, '')
      relations.set(String(tag.attributes.Id), target.startsWith('xl/') ? target : `xl/${target}`)
    }
  }))
  if (new Set(sheets.map((sheet) => sheet.name)).size !== sheets.length || sheets.length === 0) refuse('Ambiguous or missing worksheet names.')
  if (worksheet === null) return { worksheets: sheets.map((sheet) => sheet.name), columns: [] }
  const selected = sheets.find((sheet) => sheet.name === worksheet), path = selected && relations.get(selected.relation)
  if (!path || !/^xl\/worksheets\/[^/]+\.xml$/.test(path)) refuse('Choose an explicitly listed worksheet.')
  if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 5000) refuse('Choose a header row from 1 to 5,000.')
  const rawNumbers = inspectCells(files, path, headerRow)
  // Put shared strings before the single worksheet: ExcelJS otherwise defers sheets into temporary files.
  const ordered: Record<string, Uint8Array> = Object.create(null)
  for (const name of ['[Content_Types].xml', 'xl/_rels/workbook.xml.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/sharedStrings.xml', path])
    if (files.has(name)) ordered[name] = files.get(name)!
    else if (name === 'xl/sharedStrings.xml') ordered[name] = Buffer.from('<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>')
  const stream = Readable.from([zipSync(ordered, { level: 0 })])
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, { worksheets: 'emit', sharedStrings: 'cache', styles: 'cache', hyperlinks: 'ignore', entries: 'ignore' })
  const columns: ImportColumn[] = [], numeric = new Map<number, boolean>(), choices = new Map<number, Set<string>>()
  try {
    for await (const sheet of reader) for await (const row of sheet) {
      if (row.number < headerRow) continue
      if (row.number > headerRow + IMPORT_LIMITS.rows || row.cellCount > IMPORT_LIMITS.columns) refuse(`Row ${row.number}: workbook bounds exceeded.`)
      for (let column = 1; column <= row.cellCount; column++) {
        const cell = row.getCell(column), value = cellText(cell, rawNumbers.get(cell.address))
        if (bytes(value.text) > IMPORT_LIMITS.cell) refuse(`Row ${row.number}, column ${column}: exceeds 64 KiB decoded cell limit.`)
        if (row.number === headerRow) columns[column - 1] = { id: randomUUID(), column, name: value.text, type: 'string', include: true, examples: [], kinds: [value.kind], choices: [], suggestedType: 'string' }
        else if (value.text !== '') {
          const field = columns[column - 1]
          if (!field) refuse(`Row ${row.number}, column ${column}: no header. Add a header or choose another row.`)
          if (field.examples.length < 3) field.examples.push(value.text.slice(0, 160))
          if (!field.kinds.includes(value.kind)) field.kinds.push(value.kind)
          numeric.set(column, (numeric.get(column) ?? true) && value.numeric)
          const unique = choices.get(column) ?? new Set<string>()
          if (unique.size <= 20) unique.add(value.text)
          choices.set(column, unique)
        }
      }
    }
  } finally { stream.destroy() }
  if (!columns.length) refuse(`Header row ${headerRow} is empty.`)
  for (const field of columns) { field.suggestedType = numeric.get(field.column) ? 'number' : 'string'; const unique = choices.get(field.column); field.choices = unique && unique.size <= 20 ? [...unique] : [] }
  return { worksheets: sheets.map((sheet) => sheet.name), columns }
}
