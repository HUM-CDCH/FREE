import { isAllowedValues, isScalarFieldType, type ScalarFieldType } from './allowedValues.js'

type SchemaNodeBase = {
  id: string
  name: string
  description?: string
}

export type SchemaNode =
  | (SchemaNodeBase & { type: 'string'; allowedValues?: string[]; itemType?: never; children?: never })
  | (SchemaNodeBase & { type: Exclude<ScalarFieldType, 'string'>; allowedValues?: never; itemType?: never; children?: never })
  | (SchemaNodeBase & { type: 'array'; itemType: ScalarFieldType; allowedValues?: never; children?: never })
  | (SchemaNodeBase & { type: 'object' | 'array'; children: SchemaNode[]; allowedValues?: never; itemType?: never })

export type EnumeratedField = {
  id: string
  key: string
  path: readonly string[]
  node: SchemaNode
}

export type SchemaMetadataCount = {
  descriptions: number
  allowedValues: number
}

let uid = 1
export const mkId = () => `n${uid++}`

export function templateToNodes(value: unknown): SchemaNode[] {
  if (!isRecord(value)) return []
  return Object.entries(value)
    .filter(([name]) => name !== '_description')
    .map(([name, child]) => {
      if (Array.isArray(child)) {
        const first = child[0]
        if (isRecord(first)) {
          const description = typeof first._description === 'string' ? first._description : undefined
          return { id: mkId(), name, type: 'array', children: templateToNodes(first), ...(description && { description }) }
        }
        if (isAllowedValues(child)) {
          return { id: mkId(), name, type: 'string', allowedValues: child }
        }
        return { id: mkId(), name, type: 'array', itemType: isScalarFieldType(first) ? first : 'string' }
      }
      if (isRecord(child)) {
        const description = typeof child._description === 'string' ? child._description : undefined
        return { id: mkId(), name, type: 'object', children: templateToNodes(child), ...(description && { description }) }
      }
      return { id: mkId(), name, type: isScalarFieldType(child) ? child : 'string' }
    })
}

export function nodesToTemplate(nodes: readonly SchemaNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const node of nodes) {
    if (Object.hasOwn(out, node.name)) throw new Error(`Duplicate field name: ${node.name}`)
    if (node.children !== undefined) {
      const children = nodesToTemplate(node.children)
      const group = node.description ? { _description: node.description, ...children } : children
      out[node.name] = node.type === 'array' ? [group] : group
    } else if (node.allowedValues) {
      out[node.name] = node.allowedValues
    } else {
      out[node.name] = node.type === 'array' ? [node.itemType] : node.type
    }
  }
  return out
}

export function enumerateFieldPaths(nodes: readonly SchemaNode[]): EnumeratedField[] {
  const fields: EnumeratedField[] = []
  const visit = (level: readonly SchemaNode[], parentPath: readonly string[]) => {
    for (const node of level) {
      const path = [...parentPath, node.name]
      fields.push({ id: node.id, key: path.join('.'), path, node })
      if (node.children) visit(node.children, path)
    }
  }
  visit(nodes, [])
  return fields
}

export function duplicateFieldKeys(fields: readonly EnumeratedField[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const field of fields) {
    if (seen.has(field.key)) duplicates.add(field.key)
    seen.add(field.key)
  }
  return [...duplicates]
}

export function countSchemaMetadata(nodes: readonly SchemaNode[]): SchemaMetadataCount {
  let descriptions = 0
  let allowedValues = 0
  for (const { node } of enumerateFieldPaths(nodes)) {
    if (node.description) descriptions++
    if (node.allowedValues) allowedValues++
  }
  return { descriptions, allowedValues }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
