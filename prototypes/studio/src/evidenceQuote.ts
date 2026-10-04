import { blockForAnchor, tableForAnchor, type ParsedDocument } from 'extraction/parsed-document'

export type EvidenceQuote = { before: string; hit: string; after: string }

/** About four lines of the rail's quote at its widest; longer text is clipped around the mark. */
const LONG = 320
const AROUND = 80

/** The anchor's own text: a block's text (list items joined), or a cell's row with its cells joined " · ". */
function anchorText(document: ParsedDocument, anchorId: string): string | null {
  const anchor = document.evidence_index.anchors.find((each) => each.anchor_id === anchorId)
  if (!anchor) return null
  if (anchor.kind === 'table_cell') {
    const table = tableForAnchor(document, anchor)
    if (!table) return null
    return table.cells.filter((cell) => cell.row === anchor.canonical_row).sort((a, b) => a.column - b.column)
      .map((cell) => cell.text).join(' · ')
  }
  const block = blockForAnchor(document, anchor)
  if (!block) return null
  if (block.kind === 'list') return block.items.join(' · ')
  return 'text' in block ? block.text : null
}

/**
 * The quote a value's Evidence shows (results review redesign §7.1): the anchor's text with the value's occurrence
 * marked, the first case-insensitive match of the grounding's raw text, else of the value's text. No match (a link
 * whose value is not in its passage) gives no mark. A long quote is clipped around the mark with "…" at each cut.
 */
export function evidenceQuote(document: ParsedDocument, anchorId: string, raw: string | null, value: unknown): EvidenceQuote | null {
  const text = anchorText(document, anchorId)
  if (text === null) return null
  const lower = text.toLowerCase()
  const needles = [raw, value === null || value === undefined ? null : String(value)].filter((each): each is string => Boolean(each?.trim()))
  let start = -1
  let needle = ''
  for (const each of needles) {
    start = lower.indexOf(each.toLowerCase())
    if (start >= 0) { needle = each; break }
  }
  if (start < 0) return { before: clip(text, 0, Math.min(text.length, LONG)), hit: '', after: '' }
  const end = start + needle.length
  if (text.length <= LONG) return { before: text.slice(0, start), hit: text.slice(start, end), after: text.slice(end) }
  // ponytail: clipped by characters, not rendered lines; measure lines if the rail's width varies the clip visibly.
  const from = Math.max(0, start - AROUND)
  const to = Math.min(text.length, end + AROUND)
  return { before: `${from > 0 ? '…' : ''}${text.slice(from, start)}`, hit: text.slice(start, end), after: `${text.slice(end, to)}${to < text.length ? '…' : ''}` }
}

function clip(text: string, from: number, to: number) {
  return `${text.slice(from, to)}${to < text.length ? '…' : ''}`
}
