import { isRecord } from './template'

// Paul Tol's Muted palette — sky blue, olive, rose, teal
// Distinguishable across deuteranopia, protanopia, and tritanopia.
export const PALETTE: string[] = [
  'rgba(148, 203, 236, 0.55)',
  'rgba(220, 205, 125, 0.55)',
  'rgba(194, 106, 119, 0.45)',
  'rgba(93, 168, 153, 0.45)',
]

export type Highlight = { value: string; snippet: string | null; hintPage: number | null; color: string; path: string[] }

function collectEvidenceLeaf(node: unknown, color: string, path: string[], out: Highlight[]): boolean {
  if (
    isRecord(node) &&
    typeof node.value === 'string' &&
    typeof node.snippet === 'string'
  ) {
    const v = node.value.trim()
    const s = node.snippet.trim()
    if (v && s) {
      out.push({ value: v, snippet: s, hintPage: typeof node.page === 'number' ? node.page : null, color, path })
      return true
    }
  }
  return false
}

function collectResultLeaves(node: unknown, color: string, path: string[], out: Highlight[]): void {
  if (typeof node === 'string' || typeof node === 'number') {
    const v = String(node).trim()
    if (v) out.push({ value: v, snippet: null, hintPage: null, color, path })
  } else if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) collectResultLeaves(node[i], color, [...path, String(i)], out)
  } else if (isRecord(node)) {
    for (const [k, sub] of Object.entries(node)) collectResultLeaves(sub, color, [...path, k], out)
  }
}

function collectHighlightLeaves(resultNode: unknown, evidenceNode: unknown, color: string, path: string[], out: Highlight[]): void {
  if (collectEvidenceLeaf(evidenceNode, color, path, out)) return

  if (Array.isArray(resultNode)) {
    const evidenceItems = Array.isArray(evidenceNode) ? evidenceNode : []
    for (let i = 0; i < resultNode.length; i++) collectHighlightLeaves(resultNode[i], evidenceItems[i], color, [...path, String(i)], out)
  } else if (isRecord(resultNode)) {
    const evidenceRecord = isRecord(evidenceNode) ? evidenceNode : {}
    for (const [key, value] of Object.entries(resultNode)) collectHighlightLeaves(value, evidenceRecord[key], color, [...path, key], out)
  } else {
    collectResultLeaves(resultNode, color, path, out)
  }
}

export function buildHighlights(
  result: Record<string, unknown>,
  evidence: unknown,
  fieldColorMap?: Record<string, string>,
): Highlight[] {
  const out: Highlight[] = []

  // Unwrap array-wrapped results: { records: [{field1, field2, ...}, ...] }
  // Color is assigned per schema field name, consistent across all records.
  if (Array.isArray(result.records)) {
    const evidenceRecords = isRecord(evidence) && Array.isArray(evidence.records)
      ? evidence.records : []
    for (let r = 0; r < result.records.length; r++) {
      const rec = result.records[r]
      if (!isRecord(rec)) continue
      const evidenceRec = isRecord(evidenceRecords[r]) ? evidenceRecords[r] : {}
      let i = 0
      for (const [key, value] of Object.entries(rec)) {
        const color = fieldColorMap?.[key] ?? PALETTE[i % PALETTE.length]
        collectHighlightLeaves(value, (evidenceRec as Record<string, unknown>)[key], color, ['records', String(r), key], out)
        i++
      }
    }
    return out
  }

  // Non-wrapped: assign color per top-level key
  const evidenceRecord = isRecord(evidence) ? evidence : {}
  let i = 0
  for (const [key, value] of Object.entries(result)) {
    const color = fieldColorMap?.[key] ?? PALETTE[i % PALETTE.length]
    collectHighlightLeaves(value, evidenceRecord[key], color, [key], out)
    i++
  }
  return out
}
