import type { ParsedDocument, ParsedLogicalTable } from './parsed-document.js'
import { catalogStartText } from './catalog-boundaries.js'

export type SourceContext = Readonly<{
  text: string
  anchorIdByLabel: ReadonlyMap<string, string>
  labelByAnchorId: ReadonlyMap<string, string>
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
  labelByBlockId?: ReadonlyMap<string, string>,
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
          labelByBlockId?.has(block.block_id)
            ? `[[block:${labelByBlockId.get(block.block_id)}]] ${text}`
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
  startBlockIdByLabel: ReadonlyMap<string, string>
}>

/** Canonical text blocks with compact, copy-safe IDs, including numbered lists. */
export function catalogDiscoveryContext(
  document: ParsedDocument,
  selectedBlockIds?: ReadonlySet<string>,
): CatalogDiscoveryContext {
  const startBlockIdByLabel = new Map<string, string>()
  const labelByBlockId = new Map<string, string>()
  let ordinal = 0
  for (const block of document.content_stream) {
    if (!catalogStartText(block)?.trim()) continue
    const label = `B${++ordinal}`
    if (selectedBlockIds && !selectedBlockIds.has(block.block_id)) continue
    startBlockIdByLabel.set(label, block.block_id)
    labelByBlockId.set(block.block_id, label)
  }
  return {
    text: projectCanonicalSource(document, selectedBlockIds, labelByBlockId),
    startBlockIdByLabel,
  }
}

/** Keep physical pages together, subdividing oversized pages at whole blocks. */
export function catalogDiscoveryChunks(document: ParsedDocument): CatalogDiscoveryContext[] {
  const chunks: CatalogDiscoveryContext[] = []
  const tables = new Map(document.tables.map(table => [table.table_id, table]))
  let start = 0
  let size = 0
  const append = (end: number) => {
    const selected = new Set(document.content_stream.slice(start, end).map(block => block.block_id))
    const context = catalogDiscoveryContext(document, selected)
    const previous = start === 0 ? '' : canonicalSourceSlice(document, Math.max(0, start - 3), start).slice(-2000)
    const following = canonicalSourceSlice(document, end, end + 3).slice(0, 2000)
    chunks.push({ ...context, text: [
      ...(previous ? [`Previous context (not selectable):\n${previous}\n\nSelectable source blocks:`] : []),
      context.text,
      ...(following ? [`Following context (not selectable):\n${following}`] : []),
    ].join('\n\n') })
    start = end
    size = 0
  }
  for (const [index, block] of document.content_stream.entries()) {
    const text = catalogStartText(block) ?? (block.kind === 'table'
      ? tables.get(block.table_id)?.cells.map(cell => cell.text).join(' | ') ?? '' : '')
    // ponytail: an exceptionally large single block stays intact; split within
    // blocks only if a source demonstrates that need.
    if (size > 0 && (block.page_number !== document.content_stream[start].page_number
      || size + text.length + 32 > 24_000)) append(index)
    size += text.length + 32
  }
  if (start < document.content_stream.length) append(document.content_stream.length)
  return chunks
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

/** Anchors of the blocks inside one Catalog record boundary. */
export function recordAnchorIds(document: ParsedDocument, boundary: { startContentIndex: number; endContentIndex: number }): Set<string> {
  const blocks = document.content_stream.slice(boundary.startContentIndex, boundary.endContentIndex)
  const blockIds = new Set(blocks.map((block) => block.block_id))
  const tableIds = new Set(blocks.flatMap((block) => (block.kind === 'table' ? [block.table_id] : [])))
  return new Set(
    document.evidence_index.anchors
      .filter((anchor) => (anchor.kind === 'text' ? blockIds.has(anchor.block_id) : tableIds.has(anchor.logical_table_id)))
      .map((anchor) => anchor.anchor_id),
  )
}

/** Render the selected anchors as labelled lines. `labels` pins the labels
 *  (for example the whole document's) so a record slice cites the same
 *  E labels the grounder will see; otherwise labels are numbered in order. */
export function sourceContext(document: ParsedDocument, selectedAnchorIds?: ReadonlySet<string>, labels?: ReadonlyMap<string, string>): SourceContext {
  const anchorIdByLabel = new Map<string, string>()
  const labelByAnchorId = new Map<string, string>()
  const label = (anchorId: string) => {
    const existing = labelByAnchorId.get(anchorId)
    if (existing) return existing
    const next = labels?.get(anchorId) ?? `E${anchorIdByLabel.size + 1}`
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
  return { text: lines.join('\n'), anchorIdByLabel, labelByAnchorId, textByAnchorId }
}

export const anchoredSource = sourceContext
