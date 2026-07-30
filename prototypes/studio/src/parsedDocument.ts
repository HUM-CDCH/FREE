// Narrow mirror of prototypes/parsing_service/app/models/parsed_document.py's
// BoundingBox/TableCell/ParsedTable — only the fields the highlight matcher needs.

export type BoundingBox = { x0: number; y0: number; x1: number; y1: number }

export type TableCellRole = 'header' | 'column_header' | 'row_header' | 'row_header_hint' | 'data' | null

export type TableCell = {
  row: number
  col: number
  text: string
  role: TableCellRole
  bbox: BoundingBox | null
}

export type ParsedTable = {
  tableId: string
  pageNumber: number
  cells: TableCell[]
}

export type EvidenceAnchor = {
  markdownStart: number
  markdownEnd: number
  page: number
  bbox: BoundingBox
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseBoundingBox(value: unknown): BoundingBox | null {
  if (
    !isRecord(value) ||
    typeof value.x0 !== 'number' ||
    typeof value.y0 !== 'number' ||
    typeof value.x1 !== 'number' ||
    typeof value.y1 !== 'number'
  ) {
    return null
  }
  return { x0: value.x0, y0: value.y0, x1: value.x1, y1: value.y1 }
}

function parseTableCell(value: unknown): TableCell | null {
  if (!isRecord(value) || typeof value.row !== 'number' || typeof value.col !== 'number') {
    return null
  }
  return {
    row: value.row,
    col: value.col,
    text: typeof value.text === 'string' ? value.text : '',
    role: typeof value.role === 'string' ? (value.role as TableCellRole) : null,
    bbox: parseBoundingBox(value.bbox),
  }
}

// Tolerant parser for `/tasks/{id}/document`'s `tables` array — malformed or
// unrecognized entries are dropped rather than thrown, since table geometry
// is a best-effort enhancement, not a hard dependency (see design.md).
export function parseParsedTables(value: unknown): ParsedTable[] {
  if (!Array.isArray(value)) {
    return []
  }
  const tables: ParsedTable[] = []
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.table_id !== 'string' || typeof entry.page_number !== 'number') {
      continue
    }
    const cells = Array.isArray(entry.cells) ? entry.cells.map(parseTableCell).filter((c): c is TableCell => c !== null) : []
    tables.push({ tableId: entry.table_id, pageNumber: entry.page_number, cells })
  }
  return tables
}

function parseEvidenceAnchor(value: unknown): EvidenceAnchor | null {
  if (
    !isRecord(value) ||
    typeof value.markdown_start !== 'number' ||
    typeof value.markdown_end !== 'number' ||
    typeof value.page !== 'number'
  ) {
    return null
  }
  const bbox = parseBoundingBox(value.bbox)
  if (bbox === null) {
    return null
  }
  return {
    markdownStart: value.markdown_start,
    markdownEnd: value.markdown_end,
    page: value.page,
    bbox,
  }
}

// Tolerant parser for `/tasks/{id}/document`'s `evidence_index.anchors`
// array — malformed or unrecognized entries are dropped rather than thrown,
// since anchor-based highlighting is a best-effort enhancement layered on
// top of the existing PDF text-search fallback (see design.md).
export function parseEvidenceAnchors(value: unknown): EvidenceAnchor[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(parseEvidenceAnchor).filter((a): a is EvidenceAnchor => a !== null)
}
