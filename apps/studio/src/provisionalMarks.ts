import { blockForAnchor, tableForAnchor, type ParsedDocument } from 'extraction/parsed-document'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { valueParts, type RetainedValue } from './durableRailModel'

/** Display-only text matches while citations are checked. They never become saved Evidence or review decisions.
 * A repeated, missing or partial-token match has no preview; only the verifier can decide what supports a field. */
export function provisionalMarks(document: ParsedDocument, values: readonly RetainedValue[]) {
  const texts = document.evidence_index.anchors.flatMap(anchor => {
    const block = anchor.kind === 'text' ? blockForAnchor(document, anchor) : null
    const text = anchor.kind === 'table_cell' ? tableForAnchor(document, anchor)?.cells.find(cell => cell.cell_id === anchor.cell_id)?.text
      : block && 'text' in block ? block.text : block?.kind === 'list' ? block.items.join('\n') : null
    return text ? [{anchorId: anchor.anchor_id, text}] : []
  })
  const matches = new Map<string, string | null>()
  const unique = (text: string) => {
    if (matches.has(text)) return matches.get(text)!
    const found: string[] = []
    const word = (character: string) => /[\p{L}\p{N}_]/u.test(character)
    for (const source of texts) for (let at = source.text.indexOf(text); at !== -1; at = source.text.indexOf(text, at + 1)) {
      const before = [...source.text.slice(Math.max(0, at - 2), at)].at(-1) ?? '', after = [...source.text.slice(at + text.length, at + text.length + 2)][0] ?? ''
      if (word([...text][0]!) && word(before) || word([...text].at(-1)!) && word(after)) continue
      found.push(source.anchorId)
      if (found.length > 1) { matches.set(text, null); return null }
    }
    const anchor = found.length === 1 ? found[0]! : null
    matches.set(text, anchor)
    return anchor
  }
  return values.flatMap(value => {
    if (value.grounding !== 'provisional' || value.processing !== 'saved' || value.correction || value.disagreement) return []
    const parts = value.node.type === 'object' || value.node.type === 'array' ? valueParts(value)
      : [{key:value.id, path:value.path, name:value.node.name, value:value.modelValue, link:value.links[0] ?? null}]
    return parts.flatMap(part => {
      if (part.link || typeof part.value !== 'string' || !part.value.trim()) return []
      const anchorId = unique(part.value)
      return anchorId ? [{key:part.key, name:part.name, value:part.value, field:value.node.name,
        link:{resultPath:[...part.path], evidenceAnchorId:anchorId} satisfies EvidenceLink}] : []
    })
  })
}
