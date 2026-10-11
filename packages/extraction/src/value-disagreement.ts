import { schemaPathNames, type SchemaNode } from './schema.js'
import { segmentPage } from './parsed-document.js'

/** A disagreeing place's dotted field names inside its value; '' is the value itself. */
export const partName = (node: SchemaNode, path: readonly string[]): string => schemaPathNames(node,path)?.join('.') ?? ''

/** Where an alternative was read: its pages, as "p. 3" or "pp. 3–4, 9". */
export function originPages(origins: readonly {primary: readonly {segment: string}[]; overlap: readonly {segment: string}[]}[]): string | null {
  const pages = [...new Set(origins.flatMap(origin => [...origin.primary,...origin.overlap])
    .map(range => segmentPage(range.segment)).filter((page): page is number => page !== null))].sort((a,b)=>a-b)
  if (!pages.length) return null
  const ranges: string[] = []
  for (let i=0; i<pages.length; i++) {
    const first=pages[i]; let last=first
    while (i+1<pages.length && pages[i+1]===last+1) last=pages[++i]
    ranges.push(first===last?String(first):`${first}–${last}`)
  }
  return `${pages.length===1?'p.':'pp.'} ${ranges.join(', ')}`
}
