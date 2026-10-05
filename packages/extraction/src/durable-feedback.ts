import { createHash } from 'node:crypto'
import { stableJson } from 'db'
import { schemaNodesToZod, type SchemaNode } from './schema.js'
import { blockForAnchor, tableForAnchor, type ParsedDocument } from './parsed-document.js'
import type { DurableValue } from './durable-contract.js'

/** Immutable examples contain source material, not just application IDs. Links
 * remain distinct from model Evidence and never become target-source Evidence.
 * With no locatable anchor retain the whole source; budgeting omits it whole. */
export function correctionSourceContext(document: ParsedDocument, markdown: string, value: DurableValue,
  evidence: {anchorId:string;occurrenceIds:string[]}[]) {
  const selected=evidence.length?evidence:value.evidence
  const excerpts=selected.flatMap(link=> {
    const anchor=document.evidence_index.anchors.find(each=>each.anchor_id===link.anchorId)
    if(!anchor)return []
    let text: string | undefined
    if(anchor.kind==='text') {
      const block=blockForAnchor(document,anchor)
      if(block && 'text' in block)text=block.text
      else if(block?.kind==='list')text=block.items.join('\n')
    } else text=tableForAnchor(document,anchor)?.cells.find(cell=>cell.cell_id===anchor.cell_id)?.text
    return text===undefined?[]:[{anchorId:link.anchorId,occurrenceIds:link.occurrenceIds,text}]
  })
  return {
    source:excerpts.length?{scope:evidence.length?'correction-anchors':'model-anchors',excerpts}:{scope:'document',text:markdown},
    correctionEvidence:evidence,modelEvidence:value.evidence,modelGrounding:value.grounding,
  }
}

/** Names are presentation. Identity and meaning/type/constraints determine
 * compatibility; reinterpreting a field deliberately changes this digest. */
export function fieldMeaning(node: SchemaNode): string {
  const { id: _id, name: _name, children, ...meaning } = node
  if(children) Object.assign(meaning,{children:children.map(child=>[child.id,fieldMeaning(child)]).sort((a,b)=>Buffer.compare(Buffer.from(String(a[0])),Buffer.from(String(b[0]))))})
  return createHash('sha256').update(stableJson(meaning)).digest('hex')
}
/** Rename object keys by stable child IDs; preserve the original decision. */
export function adaptedCorrection(source:SchemaNode,target:SchemaNode,value:unknown):unknown {
  if(fieldMeaning(source)!==fieldMeaning(target))return undefined
  if(value===null)return null
  const remap=(original:SchemaNode,destination:SchemaNode,raw:unknown):unknown=> {
    if(raw===null)return null
    if(original.type==='array'&&original.children&&Array.isArray(raw))return raw.map(item=>object(original,destination,item))
    if(original.type==='object')return object(original,destination,raw)
    return raw
  }
  const object=(original:SchemaNode,destination:SchemaNode,raw:unknown):unknown=> {
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return raw
    const fields=raw as Record<string,unknown>
    return Object.fromEntries((destination.children??[]).map(child=> {
      const previous=original.children?.find(n=>n.id===child.id)
      return [child.name,previous?remap(previous,child,fields[previous.name]):undefined]
    }))
  }
  const adapted=remap(source,target,value)
  return correctionValueFits(target,adapted)?adapted:undefined
}
export function correctionValueFits(node: SchemaNode, value: unknown): boolean {
  return value !== undefined && schemaNodesToZod([node]).safeParse({ [node.name]: value }).success
}
export type FeedbackExample = {
  id: string; fieldId: string; meaning: string; value: unknown; sourceContext: string; grounded: boolean; node: SchemaNode
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
    if (!node || fieldMeaning(node) !== candidate.meaning || adaptedCorrection(candidate.node,node,candidate.value)===undefined) {
      omissions.push({ id: candidate.id, reason: 'incompatible' }); continue
    }
    if (!input.fits([...examples, candidate])) { omissions.push({ id: candidate.id, reason: 'budget' }); continue }
    examples.push(candidate)
  }
  return { examples, omissions }
}
