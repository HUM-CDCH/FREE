import { schemaPathNames, type SchemaNode } from './schema.js'
import { segmentPage } from './parsed-document.js'

/** A disagreeing place's dotted field names inside its value; '' is the value itself. */
export const partName = (node: SchemaNode, path: readonly string[]): string => schemaPathNames(node,path)?.join('.') ?? ''

/** Where an alternative was read: the pages of its segments, as "p. 3" or "pp. 3–4, 9". */
export function originPages(segments: readonly string[]): string | null {
  const pages = [...new Set(segments.map(segmentPage).filter((page): page is number => page !== null))].sort((a,b)=>a-b)
  if (!pages.length) return null
  const ranges: string[] = []
  for (let i=0; i<pages.length; i++) {
    const first=pages[i]; let last=first
    while (i+1<pages.length && pages[i+1]===last+1) last=pages[++i]
    ranges.push(first===last?String(first):`${first}–${last}`)
  }
  return `${pages.length===1?'p.':'pp.'} ${ranges.join(', ')}`
}

/** The value a researcher's decision gives its field: an edit, or the readings chosen at a Value Disagreement;
 *  otherwise `model`, the model's own value by default. */
export function reviewedValue(value: {readonly modelValue: unknown; readonly correction?: {readonly decision: {readonly action: string; readonly value?: unknown; readonly choices?: unknown}} | null},
  model: unknown = value.modelValue): unknown {
  const decision = value.correction?.decision
  return decision?.action === 'EDITED' || decision?.choices ? decision.value : model
}
