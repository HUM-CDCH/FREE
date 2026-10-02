import { partitionSchemaNodes } from './schema.js'
import { resultPathKey } from './review-paths.js'
import type { EvidenceLink, ExtractionSchemaNode, ResultPath, ReviewDecisionInput } from './types.js'

export type ReviewCell = {
  nodeId: string
  resultPath: ResultPath
  presence: 'grounded' | 'ungrounded' | 'missing'
  decision: { action: ReviewDecisionInput['action'] } | null
}

/** Classify the pinned tree's scalar occurrences. Pass saved/explicit decisions, never prepared approvals. */
export function reviewAttention(
  result: Readonly<Record<string, unknown>>,
  nodes: readonly ExtractionSchemaNode[],
  evidence: readonly EvidenceLink[],
  decisions: readonly ReviewDecisionInput[],
) {
  const grounded = new Set(evidence.map((link) => resultPathKey(link.resultPath)))
  const decided = new Map(decisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
  const cells: ReviewCell[] = []
  function visit(node: ExtractionSchemaNode, value: unknown, path: ResultPath) {
    if (node.type === 'array') {
      if (Array.isArray(value)) value.forEach((item, index) => {
        const itemPath = [...path, index]
        if (node.children) children(node.children, item, itemPath)
        else scalar(node, item, itemPath)
      })
    } else if (node.children) children(node.children, value, path)
    else scalar(node, value, path)
  }
  function children(tree: readonly ExtractionSchemaNode[], value: unknown, path: ResultPath) {
    for (const node of tree) visit(node, value && typeof value === 'object' && Object.hasOwn(value, node.name)
      ? (value as Record<string, unknown>)[node.name] : undefined, [...path, node.name])
  }
  function scalar(node: ExtractionSchemaNode, value: unknown, resultPath: ResultPath) {
    const key = resultPathKey(resultPath)
    const decision = decided.get(key)
    cells.push({ nodeId: node.id, resultPath,
      presence: value === undefined || value === null || value === '' ? 'missing' : grounded.has(key) ? 'grounded' : 'ungrounded',
      decision: decision ? { action: decision.action } : null })
  }
  const tree = partitionSchemaNodes(nodes).recordNodes
  if (Array.isArray(result.records)) result.records.forEach((record, index) => children(tree, record, ['records', index]))
  return { cells,
    grounded: cells.filter((cell) => cell.presence === 'grounded').length,
    ungrounded: cells.filter((cell) => cell.presence === 'ungrounded').length,
    missing: cells.filter((cell) => cell.presence === 'missing').length,
    requiredRemaining: cells.filter((cell) => cell.presence === 'grounded' && !cell.decision).length,
  }
}
