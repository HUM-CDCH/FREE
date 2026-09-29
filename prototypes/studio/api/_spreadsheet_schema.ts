import ExcelJS from 'exceljs'
import type { SchemaNode } from 'extraction/schema'
import { isGoldFilenameColumn } from 'extraction/gold-spreadsheet'

export type SpreadsheetColumn = {
  columnName: string
  values: unknown[]
}

/** Reads the first worksheet of an uploaded spreadsheet: the first row is
 *  column headers, every following row is one record. Blank header cells
 *  are skipped (no column produced for them). */
export async function parseSpreadsheetColumns(
  buffer: Buffer | ArrayBuffer,
): Promise<SpreadsheetColumn[]> {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as ArrayBuffer)
  const sheet = workbook.worksheets[0]
  if (!sheet) return []

  const headerRow = sheet.getRow(1)
  const headers: { columnIndex: number; columnName: string }[] = []
  headerRow.eachCell({ includeEmpty: false }, (cell, columnIndex) => {
    const name = cell.text.trim()
    if (name) headers.push({ columnIndex, columnName: name })
  })

  const columns: SpreadsheetColumn[] = headers.map((header) => ({
    columnName: header.columnName,
    values: [],
  }))

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    headers.forEach((header, index) => {
      const cell = row.getCell(header.columnIndex)
      columns[index].values.push(cellValue(cell.value))
    })
  }
  return columns
}

function cellValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && 'text' in value) return String(value.text)
  if (typeof value === 'object' && 'result' in value) return value.result
  return value
}

export type ColumnTypeInference =
  | { type: 'number' | 'integer' }
  | { type: 'enum'; allowedValues: string[] }
  | { type: 'string' }

const ENUM_MAX_DISTINCT_VALUES = 15

function isPopulated(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== ''
}

/** Infers one column's field type from its non-empty cell values: all
 *  numeric -> number/integer; a small, repeated set of distinct strings ->
 *  enum; otherwise plain string (design.md D1). */
export function inferColumnType(values: readonly unknown[]): ColumnTypeInference {
  const populated = values.filter(isPopulated)
  if (populated.length === 0) return { type: 'string' }

  const numbers = populated.map((value) => Number(value))
  if (numbers.every((value) => Number.isFinite(value)))
    return { type: numbers.every((value) => Number.isInteger(value)) ? 'integer' : 'number' }

  const distinct = [...new Set(populated.map((value) => String(value).trim()))]
  const isSmallRepeatedSet =
    distinct.length >= 2 &&
    distinct.length <= ENUM_MAX_DISTINCT_VALUES &&
    distinct.length < populated.length
  if (isSmallRepeatedSet) return { type: 'enum', allowedValues: distinct }

  return { type: 'string' }
}

function templateValueFor(inference: ColumnTypeInference): unknown {
  if (inference.type === 'enum') return inference.allowedValues
  return inference.type
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
 * (design.md D1b). When `inferTypesFromValues` is false, every column
 * becomes a plain `string` field regardless of its cell values — the
 * researcher can opt out of reading anything but the header row.
 */
export function buildSpreadsheetTemplate(
  columns: readonly SpreadsheetColumn[],
  separator: string | null,
  inferTypesFromValues: boolean,
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
    const inference: ColumnTypeInference = inferTypesFromValues
      ? inferColumnType(column.values)
      : { type: 'string' }
    setAtPath(template, path, templateValueFor(inference))
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
 * openspec/changes/spreadsheet-schema-suggestion).
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
