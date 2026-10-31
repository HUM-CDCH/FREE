import ExcelJS from 'exceljs'
import type { SchemaNode } from 'extraction/schema'

/** The spreadsheet column (case/whitespace-insensitive) whose value resolves
 *  each row to a project Source Document, rather than becoming a schema field
 *  itself. */
const FILENAME_COLUMN = 'filename'

function isGoldFilenameColumn(columnName: string): boolean {
  return columnName.trim().toLowerCase() === FILENAME_COLUMN
}

export type SpreadsheetColumn = {
  columnName: string
}

/** The first worksheet of an uploaded workbook, or undefined for a workbook
 *  with none. Loading never mutates the buffer. */
async function firstWorksheet(
  buffer: Buffer | ArrayBuffer,
): Promise<ExcelJS.Worksheet | undefined> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as ArrayBuffer)
  return workbook.worksheets[0]
}

/** The header row as ordered columns, skipping blank header cells. Shared so
 *  the header-only and header-plus-rows readers agree on what a column is. */
function headerColumns(
  sheet: ExcelJS.Worksheet,
): { index: number; column: SpreadsheetColumn }[] {
  const headers: { index: number; column: SpreadsheetColumn }[] = []
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, columnNumber) => {
    const name = cell.text.trim()
    if (name) headers.push({ index: columnNumber, column: { columnName: name } })
  })
  return headers
}

/** Reads the first worksheet of an uploaded spreadsheet: the first row is
 *  column headers. Only that header row is read — the cell values in the
 *  rows below it are never read or retained, so an upload carries column
 *  names alone. Blank header cells are skipped (no column produced for
 *  them). */
export async function parseSpreadsheetColumns(
  buffer: Buffer | ArrayBuffer,
): Promise<SpreadsheetColumn[]> {
  const sheet = await firstWorksheet(buffer)
  return sheet ? headerColumns(sheet).map((header) => header.column) : []
}

/** One answer row, keyed by column name, with every cell as its displayed
 *  text. A fully blank row is dropped; the file-name column stays in the row
 *  and is removed by the caller that knows a row maps to a document. */
export type SpreadsheetRow = Record<string, string>

/** Reads the first worksheet's header row and its data rows. The header-only
 *  `parseSpreadsheetColumns` path is unchanged: this reader exists for the
 *  developer evaluation's gold corpus, which alone keeps the answer rows. */
export async function parseSpreadsheetRows(
  buffer: Buffer | ArrayBuffer,
): Promise<{ columns: SpreadsheetColumn[]; rows: SpreadsheetRow[] }> {
  const sheet = await firstWorksheet(buffer)
  if (!sheet) return { columns: [], rows: [] }
  const headers = headerColumns(sheet)
  const columns = headers.map((header) => header.column)
  if (headers.length === 0) return { columns, rows: [] }

  const rows: SpreadsheetRow[] = []
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return
    const record: SpreadsheetRow = {}
    let populated = false
    for (const header of headers) {
      const text = row.getCell(header.index).text
      record[header.column.columnName] = text
      if (text.trim()) populated = true
    }
    if (populated) rows.push(record)
  })
  return { columns, rows }
}

export type SpreadsheetTemplateResult =
  | {
      ok: true
      /** The flat/nested template `templateToNodes` accepts (without a root
       *  `_description` — the caller adds that separately). */
      template: Record<string, unknown>
      /** Each column's path into the template, e.g. `measurement.temperature`
       *  split on "." becomes `['measurement', 'temperature']`. */
      columnPaths: Map<string, string[]>
    }
  | { ok: false; conflicts: string[][] }

/**
 * Splits column headers on `separator` (when given) into a path, groups
 * columns sharing a path prefix into nested objects, and assembles the
 * result into the template shape `templateToNodes`
 * (`packages/extraction/src/schema.ts`) already accepts. When `separator`
 * is null/undefined, every column stays a flat top-level field, even if its
 * header contains a character that would otherwise be a separator
 * (design.md D1b). Every field is a plain `string`: the upload reads the
 * header row alone, so there are no cell values to infer from — the
 * researcher revises type hints in the review step.
 */
export function buildSpreadsheetTemplate(
  columns: readonly SpreadsheetColumn[],
  separator: string | null,
): SpreadsheetTemplateResult {
  // The "filename" column (case-insensitive) identifies which document a
  // row is about — never a schema field to extract, regardless of purpose
  // (extraction-quality-evaluation design.md D1b/gold-standard-corpus).
  const fieldColumns = columns.filter(
    (column) => !isGoldFilenameColumn(column.columnName),
  )
  const paths = fieldColumns.map((column) => ({
    column,
    path: separator ? column.columnName.split(separator).filter((segment) => segment.length > 0) : [column.columnName],
  }))

  const conflicts = findLeafGroupConflicts(paths.map((entry) => entry.path))
  if (conflicts.length > 0) return { ok: false, conflicts }

  const template: Record<string, unknown> = {}
  const columnPaths = new Map<string, string[]>()
  for (const { column, path } of paths) {
    setAtPath(template, path, 'string')
    columnPaths.set(column.columnName, path)
  }
  return { ok: true, template, columnPaths }
}

/** A path that is both a leaf (some other path is exactly it) and a group
 *  (some other path is a strict, longer extension of it) can't be
 *  represented as a single schema node — report every such conflicting pair. */
function findLeafGroupConflicts(paths: readonly string[][]): string[][] {
  const conflicts: string[][] = []
  for (const leaf of paths) {
    for (const group of paths) {
      if (leaf === group) continue
      if (group.length > leaf.length && leaf.every((segment, index) => segment === group[index]))
        conflicts.push([leaf.join('.'), group.join('.')])
    }
  }
  return conflicts
}

function setAtPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment]
    if (isRecord(next)) {
      cursor = next
    } else {
      const child: Record<string, unknown> = {}
      cursor[segment] = child
      cursor = child
    }
  }
  cursor[path[path.length - 1]] = value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nodeIdAtPath(nodes: readonly SchemaNode[], path: readonly string[]): string | null {
  const [name, ...rest] = path
  const node = nodes.find((candidate) => candidate.name === name)
  if (!node) return null
  if (rest.length === 0) return node.id
  return node.children ? nodeIdAtPath(node.children, rest) : null
}

/**
 * Maps each column's name to the id of the `SchemaNode` its path resolved
 * to in the confirmed suggestion — the stable identity a renamed field can
 * still be traced back through (design.md D3 in
 * the spreadsheet-schema-suggestion design).
 */
export function columnFieldIds(
  nodes: readonly SchemaNode[],
  columnPaths: ReadonlyMap<string, string[]>,
): Record<string, string> {
  const mapping: Record<string, string> = {}
  for (const [columnName, path] of columnPaths) {
    const id = nodeIdAtPath(nodes, path)
    if (id) mapping[columnName] = id
  }
  return mapping
}
