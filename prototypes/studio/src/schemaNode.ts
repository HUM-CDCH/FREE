import { isAllowedValues } from '../shared/allowedValues'
import { isRecord } from './template'

export type SchemaNode = {
  id: string
  name: string
  type: string
  allowedValues?: string[]
  description?: string
  children?: SchemaNode[]
}

let _uid = 1
export const mkId = () => `n${_uid++}`

export function templateToNodes(v: unknown): SchemaNode[] {
  if (!isRecord(v)) return []
  return Object.entries(v)
    .filter(([name]) => name !== '_description')
    .map(([name, child]) => {
      if (Array.isArray(child)) {
        const first = child[0]
        if (isRecord(first)) {
          const desc = typeof first['_description'] === 'string' ? first['_description'] : undefined
          return { id: mkId(), name, type: 'array', children: templateToNodes(first), ...(desc && { description: desc }) }
        }
        if (isAllowedValues(child)) {
          return { id: mkId(), name, type: 'string', allowedValues: child }
        }
        return { id: mkId(), name, type: String(first ?? 'string') }
      }
      if (isRecord(child)) {
        const desc = typeof child['_description'] === 'string' ? child['_description'] : undefined
        return { id: mkId(), name, type: 'object', children: templateToNodes(child), ...(desc && { description: desc }) }
      }
      return { id: mkId(), name, type: String(child) }
    })
}

export function nodesToTemplate(nodes: SchemaNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const n of nodes) {
    if (n.children !== undefined) {
      const children = nodesToTemplate(n.children)
      const group = n.description ? { _description: n.description, ...children } : children
      out[n.name] = n.type === 'array' ? [group] : group
    } else {
      // A closed set rides as its literal values; the panel only ever stores two
      // or more, which is what keeps it distinguishable from a scalar array.
      out[n.name] = n.allowedValues ?? n.type
    }
  }
  return out
}
