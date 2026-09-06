import type { ParsedDocument, ParsedLogicalTable } from './parsed-document.js'

export type SourceContext = Readonly<{
  text: string
  anchorIdByLabel: ReadonlyMap<string, string>
  textByAnchorId: ReadonlyMap<string, string>
}>
export type AnchoredSource = SourceContext

export type CanonicalAnchorEntry =
  | Readonly<{
      kind: 'text'
      anchorId: string
      text: string
      page: number
    }>
  | Readonly<{
      kind: 'table_cell'
      anchorId: string
      text: string
      page: number
      logicalTableId: string
      row: number
    }>
export type CanonicalAnchorInventoryEntry = CanonicalAnchorEntry

export function canonicalAnchorInventory(document: ParsedDocument): readonly CanonicalAnchorEntry[] {
  const anchorByBlock = new Map(document.evidence_index.anchors.flatMap((anchor) => anchor.kind === 'text' ? [[anchor.block_id, anchor.anchor_id] as const] : []))
  const tables = new Map(document.tables.map((table) => [table.table_id, table]))
  const renderedTableIds = new Set<string>()
  const entries: CanonicalAnchorEntry[] = []
  const addTable = (tableId: string, page: number) => {
    if (renderedTableIds.has(tableId)) return
    renderedTableIds.add(tableId)
    const table = tables.get(tableId)
    if (!table) return
    for (const cell of [...table.cells].sort((left, right) => left.row - right.row || left.column - right.column))
      entries.push({ kind: 'table_cell', anchorId: cell.evidence_anchor_id, text: cell.text, page, logicalTableId: tableId, row: cell.row })
  }
  for (const page of document.pages) {
    for (const blockId of page.ordered_content) {
      const block = document.content_stream.find((candidate) => candidate.block_id === blockId)
      if (!block) continue
      if (block.kind === 'table') {
        addTable(block.table_id, page.page_number)
        continue
      }
      const text = 'text' in block ? block.text : block.kind === 'list' ? block.items.join('; ') : ''
      const anchorId = anchorByBlock.get(blockId)
      if (text.trim() && anchorId) entries.push({ kind: 'text', anchorId, text, page: page.page_number })
    }
    for (const tableId of page.unplaced_content) addTable(tableId, page.page_number)
  }
  return entries
}

function projectCanonicalSource(
  document: ParsedDocument,
  selectedBlockIds?: ReadonlySet<string>,
  headingIdByBlockId?: ReadonlyMap<string, string>,
): string {
  const tables = new Map(document.tables.map((table) => [table.table_id, table]))
  const renderedTableIds = new Set<string>()
  const lines: string[] = []
  const addTable = (table: ParsedLogicalTable | undefined) => {
    if (!table || renderedTableIds.has(table.table_id)) return
    renderedTableIds.add(table.table_id)
    const rows = new Map<number, string[]>()
    for (const cell of [...table.cells].sort((left, right) => left.row - right.row || left.column - right.column)) rows.set(cell.row, [...(rows.get(cell.row) ?? []), cell.text])
    if (rows.size === 0) return
    lines.push(`### Table ${table.table_id}`)
    for (const cells of rows.values()) lines.push(cells.join(' | '))
  }
  for (const page of document.pages) {
    const orderedBlockIds = page.ordered_content.filter((blockId) =>
      selectedBlockIds ? selectedBlockIds.has(blockId) : true,
    )
    const unplacedTableIds = page.unplaced_content.filter((tableId) =>
      selectedBlockIds
        ? document.content_stream.some(
            (block) =>
              selectedBlockIds.has(block.block_id) &&
              block.kind === 'table' &&
              block.table_id === tableId,
          )
        : true,
    )
    if (selectedBlockIds && orderedBlockIds.length === 0 && unplacedTableIds.length === 0) continue
    lines.push(`## Page ${page.page_number}`)
    for (const blockId of orderedBlockIds) {
      const block = document.content_stream.find((candidate) => candidate.block_id === blockId)
      if (!block) continue
      if (block.kind === 'table') {
        addTable(tables.get(block.table_id))
        continue
      }
      const text = 'text' in block ? block.text : block.kind === 'list' ? block.items.join('; ') : ''
      if (text.trim())
        lines.push(
          block.kind === 'heading' && headingIdByBlockId?.has(block.block_id)
            ? `[[heading:${headingIdByBlockId.get(block.block_id)}]] ${text}`
            : text,
        )
    }
    for (const tableId of unplacedTableIds) addTable(tables.get(tableId))
  }
  return lines.join('\n')
}

export function canonicalSource(document: ParsedDocument): string {
  return projectCanonicalSource(document)
}

export type CatalogDiscoveryContext = Readonly<{
  text: string
  startBlockIdByHeadingId: ReadonlyMap<string, string>
}>

/** Full canonical source whose parser headings carry compact, copy-safe IDs. */
export function catalogDiscoveryContext(
  document: ParsedDocument,
): CatalogDiscoveryContext {
  const startBlockIdByHeadingId = new Map<string, string>()
  const headingIdByBlockId = new Map<string, string>()
  for (const block of document.content_stream) {
    if (block.kind !== 'heading') continue
    const headingId = `H${startBlockIdByHeadingId.size + 1}`
    startBlockIdByHeadingId.set(headingId, block.block_id)
    headingIdByBlockId.set(block.block_id, headingId)
  }
  return {
    text: projectCanonicalSource(document, undefined, headingIdByBlockId),
    startBlockIdByHeadingId,
  }
}

/** Canonical parser content for one end-exclusive content-stream slice. */
export function canonicalSourceSlice(
  document: ParsedDocument,
  startContentIndex: number,
  endContentIndex: number,
): string {
  return projectCanonicalSource(
    document,
    new Set(
      document.content_stream
        .slice(startContentIndex, endContentIndex)
        .map((block) => block.block_id),
    ),
  )
}

export function sourceContext(document: ParsedDocument, selectedAnchorIds?: ReadonlySet<string>): SourceContext {
  const anchorIdByLabel = new Map<string, string>()
  const labelByAnchorId = new Map<string, string>()
  const label = (anchorId: string) => {
    const existing = labelByAnchorId.get(anchorId)
    if (existing) return existing
    const next = `E${anchorIdByLabel.size + 1}`
    anchorIdByLabel.set(next, anchorId)
    labelByAnchorId.set(anchorId, next)
    return next
  }
  const lines: string[] = []
  let lastPage: number | null = null
  let lastTable: string | null = null
  let lastRow: number | null = null
  const textByAnchorId = new Map<string, string>()
  for (const entry of canonicalAnchorInventory(document)) {
    if (selectedAnchorIds && !selectedAnchorIds.has(entry.anchorId)) continue
    textByAnchorId.set(entry.anchorId, entry.text)
    const rendered = `[${label(entry.anchorId)}] ${entry.text}`
    if (entry.page !== lastPage) {
      lines.push(`## Page ${entry.page}`)
      lastPage = entry.page
      lastTable = null
      lastRow = null
    }
    if (entry.kind === 'table_cell') {
      if (entry.logicalTableId !== lastTable) {
        lines.push(`### Table ${entry.logicalTableId}`)
        lastTable = entry.logicalTableId ?? null
        lastRow = null
      }
      if (entry.row !== lastRow) {
        lines.push(rendered)
        lastRow = entry.row ?? null
      } else lines[lines.length - 1] += ` | ${rendered}`
    } else {
      lastTable = null
      lastRow = null
      lines.push(rendered)
    }
  }
  return { text: lines.join('\n'), anchorIdByLabel, textByAnchorId }
}

export const anchoredSource = sourceContext
