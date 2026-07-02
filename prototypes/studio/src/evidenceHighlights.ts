import { isRecord } from './template'

export const PALETTE: string[] = [
  'rgba(255, 220, 0, 0.35)',
  'rgba(59, 130, 246, 0.30)',
  'rgba(34, 197, 94, 0.30)',
  'rgba(239, 68, 68, 0.25)',
]

type Highlight = { value: string; snippet: string | null; hintPage: number | null; color: string }

function collectEvidenceLeaf(node: unknown, color: string, out: Highlight[]): boolean {
  if (
    isRecord(node) &&
    typeof node.value === 'string' &&
    typeof node.snippet === 'string'
  ) {
    const v = node.value.trim()
    const s = node.snippet.trim()
    if (v && s) {
      out.push({ value: v, snippet: s, hintPage: typeof node.page === 'number' ? node.page : null, color })
      return true
    }
  }
  return false
}

function collectResultLeaves(node: unknown, color: string, out: Highlight[]): void {
  if (typeof node === 'string') {
    const v = node.trim()
    if (v) out.push({ value: v, snippet: null, hintPage: null, color })
  } else if (Array.isArray(node)) {
    for (const item of node) collectResultLeaves(item, color, out)
  } else if (isRecord(node)) {
    for (const sub of Object.values(node)) collectResultLeaves(sub, color, out)
  }
}

function collectHighlightLeaves(resultNode: unknown, evidenceNode: unknown, color: string, out: Highlight[]): void {
  if (collectEvidenceLeaf(evidenceNode, color, out)) return

  if (Array.isArray(resultNode)) {
    const evidenceItems = Array.isArray(evidenceNode) ? evidenceNode : []
    for (let i = 0; i < resultNode.length; i++) collectHighlightLeaves(resultNode[i], evidenceItems[i], color, out)
  } else if (isRecord(resultNode)) {
    const evidenceRecord = isRecord(evidenceNode) ? evidenceNode : {}
    for (const [key, value] of Object.entries(resultNode)) collectHighlightLeaves(value, evidenceRecord[key], color, out)
  } else {
    collectResultLeaves(resultNode, color, out)
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
        collectHighlightLeaves(value, (evidenceRec as Record<string, unknown>)[key], color, out)
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
    collectHighlightLeaves(value, evidenceRecord[key], color, out)
    i++
  }
  return out
}
