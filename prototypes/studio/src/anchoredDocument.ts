import { isAllowedValues, isScalarFieldType } from '../shared/allowedValues'
import type { ParsedDocumentV2, ParsedLogicalTable } from './parsedDocument'

export type AnchoredSource = {
  /** The canonical content the model reads, each passage labelled. */
  text: string
  /** Exact label → canonical Evidence Anchor ID; nothing else resolves. */
  anchorIdByLabel: ReadonlyMap<string, string>
}

/**
 * The Source Document as the model reads it: canonical content in page order,
 * each passage carrying a short citation label. Labels rather than raw anchor
 * IDs because a 71-character ID is echoed back mangled; a label from a closed
 * set is resolved by exact lookup, never by matching text to the PDF.
 */
export function anchoredSource(document: ParsedDocumentV2): AnchoredSource {
  const anchorIdByLabel = new Map<string, string>()
  const label = (anchorId: string) => {
    const next = `E${anchorIdByLabel.size + 1}`
    anchorIdByLabel.set(next, anchorId)
    return next
  }
  const anchorByBlock = new Map(
    document.evidence_index.anchors.flatMap((anchor) =>
      anchor.kind === 'text' ? [[anchor.block_id, anchor.anchor_id] as const] : [],
    ),
  )
  const tables = new Map(document.tables.map((table) => [table.table_id, table]))
  const lines: string[] = []
  const tableLines = (table: ParsedLogicalTable | undefined) => {
    if (!table) return
    lines.push(`### Table ${table.table_id}`)
    const rows = new Map<number, string[]>()
    for (const cell of [...table.cells].sort(
      (left, right) => left.row - right.row || left.column - right.column,
    ))
      rows.set(cell.row, [
        ...(rows.get(cell.row) ?? []),
        `[${label(cell.evidence_anchor_id)}] ${cell.text}`,
      ])
    for (const cells of rows.values()) lines.push(cells.join(' | '))
  }

  for (const page of document.pages) {
    lines.push(`## Page ${page.page_number}`)
    for (const blockId of page.ordered_content) {
      const block = document.content_stream.find(
        (candidate) => candidate.block_id === blockId,
      )
      if (!block) continue
      if (block.kind === 'table') {
        tableLines(tables.get(block.table_id))
        continue
      }
      const text =
        'text' in block ? block.text : block.kind === 'list' ? block.items.join('; ') : ''
      const anchorId = anchorByBlock.get(blockId)
      if (!text.trim() || !anchorId) continue
      lines.push(`[${label(anchorId)}] ${text}`)
    }
    for (const tableId of page.unplaced_content) tableLines(tables.get(tableId))
  }
  return { text: lines.join('\n'), anchorIdByLabel }
}

export const ANCHOR_CITATION_INSTRUCTION =
  'Every field is an object with "value" and "anchor_id". Put the extracted ' +
  'content in "value" and, in "anchor_id", the exact bracketed label (for ' +
  'example E12) of the passage the value came from. Use only labels that ' +
  'appear in the document, and add no snippets, page numbers, or coordinates.'

/**
 * Rewrites each Extraction Schema leaf as `{ value, anchor_id }` so a cited
 * anchor rides beside the value it evidences instead of in a second tree.
 */
export function wrapTemplateWithAnchors(template: unknown): unknown {
  if (isAllowedValues(template) || isScalarFieldType(template))
    return { value: template, anchor_id: 'verbatim-string' }
  if (Array.isArray(template)) return template.map(wrapTemplateWithAnchors)
  if (template && typeof template === 'object')
    return Object.fromEntries(
      Object.entries(template as Record<string, unknown>).map(([key, value]) => [
        key,
        wrapTemplateWithAnchors(value),
      ]),
    )
  return { value: template, anchor_id: 'verbatim-string' }
}

/**
 * Replaces each cited label with the canonical Evidence Anchor ID it stands
 * for. A label the document never published resolves to no Evidence at all.
 */
export function resolveResultAnchors(
  result: unknown,
  anchorIdByLabel: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(result))
    return result.map((item) => resolveResultAnchors(item, anchorIdByLabel))
  if (!result || typeof result !== 'object') return result
  return Object.fromEntries(
    Object.entries(result as Record<string, unknown>).map(([key, value]) => [
      key,
      key === 'anchor_id' && typeof value === 'string'
        ? (anchorIdByLabel.get(value.trim()) ?? null)
        : resolveResultAnchors(value, anchorIdByLabel),
    ]),
  )
}
