import type { SchemaNode } from './schema.js'

/** The spreadsheet column (case/whitespace-insensitive) whose value
 *  resolves each row to a project Source Document, rather than becoming a
 *  schema field itself (extraction-quality-evaluation design.md D1b/
 *  gold-standard-corpus spec.md). */
export const GOLD_SPREADSHEET_FILENAME_COLUMN = 'filename'

function normalizedColumnName(name: string): string {
  return name.trim().toLowerCase()
}

export function isGoldFilenameColumn(columnName: string): boolean {
  return normalizedColumnName(columnName) === GOLD_SPREADSHEET_FILENAME_COLUMN
}

function nodePathById(
  nodes: readonly SchemaNode[],
  id: string,
  prefix: readonly string[] = [],
): string[] | null {
  for (const node of nodes) {
    const path = [...prefix, node.name]
    if (node.id === id) return path
    if (node.children) {
      const found = nodePathById(node.children, id, path)
      if (found) return found
    }
  }
  return null
}

function setAtPath(
  target: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): void {
  let cursor = target
  for (const segment of path.slice(0, -1)) {
    const next = cursor[segment]
    if (next && typeof next === 'object' && !Array.isArray(next)) {
      cursor = next as Record<string, unknown>
    } else {
      const child: Record<string, unknown> = {}
      cursor[segment] = child
      cursor = child
    }
  }
  cursor[path[path.length - 1]] = value
}

export type GoldSpreadsheetColumn = {
  columnName: string
  values: readonly unknown[]
}

/**
 * Builds one row's `GoldRecord.fields`, shaped like the target schema, using
 * the confirmed column-to-field mapping (`columnName -> SchemaNode.id`) so a
 * field renamed after the suggestion was created still receives its
 * column's value — traced by id, not the (possibly stale) column header.
 * The filename column (row->document resolution, not a schema field) is
 * excluded, and any column with no resolvable mapping/node is skipped
 * rather than failing the whole record.
 */
export function buildGoldRecordFields(
  schemaNodes: readonly SchemaNode[],
  columnFieldMapping: Readonly<Record<string, string>>,
  columns: readonly GoldSpreadsheetColumn[],
  rowIndex: number,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const column of columns) {
    if (isGoldFilenameColumn(column.columnName)) continue
    const fieldId = columnFieldMapping[column.columnName]
    if (!fieldId) continue
    const path = nodePathById(schemaNodes, fieldId)
    if (!path) continue
    setAtPath(fields, path, column.values[rowIndex] ?? null)
  }
  return fields
}

/** The filename column's per-row values, or `null` if the spreadsheet has
 *  no such column (a `SCHEMA_AND_VALIDATE` spreadsheet always needs one to
 *  populate gold data). */
export function goldFilenameColumnValues(
  columns: readonly GoldSpreadsheetColumn[],
): readonly unknown[] | null {
  return (
    columns.find((column) => isGoldFilenameColumn(column.columnName))
      ?.values ?? null
  )
}

/** How many data rows a spreadsheet has, from the longest column — columns
 *  can differ in length only if the source sheet had ragged rows, in which
 *  case a short column's missing cells read as `null` (`values[i] ??
 *  null` in `buildGoldRecordFields`). */
export function goldSpreadsheetRowCount(
  columns: readonly GoldSpreadsheetColumn[],
): number {
  return columns.reduce((max, column) => Math.max(max, column.values.length), 0)
}
