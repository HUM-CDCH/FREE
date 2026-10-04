import { createHash } from 'node:crypto'
import { stableJson } from 'db'
import { schemaNodesToZod, type SchemaNode } from './schema.js'

/** Names are presentation. Identity and meaning/type/constraints determine
 * compatibility; reinterpreting a field deliberately changes this digest. */
export function fieldMeaning(node: SchemaNode): string {
  const { id: _id, name: _name, ...meaning } = node
  return createHash('sha256').update(stableJson(meaning)).digest('hex')
}
export function correctionValueFits(node: SchemaNode, value: unknown): boolean {
  return value !== undefined && schemaNodesToZod([node]).safeParse({ [node.name]: value }).success
}
export type FeedbackExample = {
  id: string; fieldId: string; meaning: string; value: unknown; sourceContext: string; grounded: boolean
}
export function selectFeedback(input: {
  nodes: readonly SchemaNode[]; candidates: readonly FeedbackExample[];
  fits: (examples: readonly FeedbackExample[]) => boolean
}): { examples: FeedbackExample[]; omissions: { id: string; reason: 'incompatible' | 'budget' }[] } {
  const target = new Map<string, SchemaNode>()
  const visit = (nodes: readonly SchemaNode[]) => {
    for (const node of nodes) { target.set(node.id, node); if (node.children) visit(node.children) }
  }
  visit(input.nodes)
  const examples: FeedbackExample[] = [], omissions: { id: string; reason: 'incompatible' | 'budget' }[] = []
  for (const candidate of input.candidates) {
    const node = target.get(candidate.fieldId)
    if (!node || fieldMeaning(node) !== candidate.meaning || !correctionValueFits(node, candidate.value)) {
      omissions.push({ id: candidate.id, reason: 'incompatible' }); continue
    }
    if (!input.fits([...examples, candidate])) { omissions.push({ id: candidate.id, reason: 'budget' }); continue }
    examples.push(candidate)
  }
  return { examples, omissions }
}
export function legacyValueId(extractionId: string, artifactDigest: string, path: readonly (string | number)[]): string {
  return createHash('sha256').update(stableJson(['legacy', extractionId, artifactDigest, path])).digest('hex')
}
