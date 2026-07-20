import { type SchemaNode, mkId } from './schemaNode'

export const SCHEMA_FIELD_TYPES = ['verbatim-string', 'string', 'date', 'number', 'integer', 'boolean', 'object', 'array'] as const
export type SchemaFieldType = (typeof SCHEMA_FIELD_TYPES)[number]

export type SchemaOp =
  | { op: 'add'; name: string; type: SchemaFieldType; parentName?: string }
  | { op: 'remove'; name: string; parentName?: string }
  | { op: 'patch'; name: string; newName?: string; type?: SchemaFieldType; parentName?: string }

export function isSchemaOp(value: unknown): value is SchemaOp {
  if (typeof value !== 'object' || value === null) return false
  const op = value as Record<string, unknown>
  if (!['add', 'remove', 'patch'].includes(String(op.op)) || typeof op.name !== 'string' || !op.name.trim()) return false
  if (op.parentName !== undefined && typeof op.parentName !== 'string') return false
  if (op.op === 'remove') return op.type === undefined && op.newName === undefined
  if (op.op === 'add') return typeof op.type === 'string' && SCHEMA_FIELD_TYPES.includes(op.type as SchemaFieldType) && op.newName === undefined
  return (op.newName === undefined || typeof op.newName === 'string') &&
    (op.type === undefined || SCHEMA_FIELD_TYPES.includes(op.type as SchemaFieldType)) &&
    (op.newName !== undefined || op.type !== undefined)
}

export function parseSchemaOps(value: unknown): SchemaOp[] {
  if (!Array.isArray(value) || !value.every(isSchemaOp)) throw new Error('Edit schema model returned malformed operations.')
  return value
}

function mapNodes(
  nodes: SchemaNode[],
  fn: (node: SchemaNode, parentName: string | undefined) => SchemaNode | null,
  parentName?: string,
): SchemaNode[] {
  const out: SchemaNode[] = []
  for (const n of nodes) {
    const result = fn(n, parentName)
    if (result === null) continue
    if (result.children !== undefined) {
      out.push({ ...result, children: mapNodes(result.children, fn, result.name) })
    } else {
      out.push(result)
    }
  }
  return out
}

function matches(node: SchemaNode, name: string, parentName: string | undefined, actualParent: string | undefined): boolean {
  if (node.name !== name) return false
  if (parentName !== undefined && parentName !== actualParent) return false
  return true
}

export function addSchemaNode(
  nodes: SchemaNode[],
  name: string,
  type: SchemaFieldType,
  parentName?: string,
): SchemaNode[] {
  const newNode: SchemaNode = { id: mkId(), name, type, ...((type === 'object' || type === 'array') ? { children: [] } : {}) }

  if (!parentName) {
    return [...nodes, newNode]
  }

  let added = false
  const result = mapNodes(nodes, (n) => {
    if (n.name === parentName && (n.type === 'object' || n.type === 'array')) {
      added = true
      return { ...n, children: [...(n.children ?? []), newNode] }
    }
    return n
  })

  return added ? result : [...nodes, newNode]
}

export function removeSchemaNode(
  nodes: SchemaNode[],
  name: string,
  parentName?: string,
): SchemaNode[] {
  return mapNodes(nodes, (n, actualParent) => {
    if (matches(n, name, parentName, actualParent)) return null
    return n
  })
}

export function patchSchemaNode(
  nodes: SchemaNode[],
  name: string,
  newName?: string,
  type?: SchemaFieldType,
  parentName?: string,
): SchemaNode[] {
  return mapNodes(nodes, (n, actualParent) => {
    if (!matches(n, name, parentName, actualParent)) return n
    const next: SchemaNode = {
      ...n,
      ...(newName !== undefined ? { name: newName } : {}),
      ...(type !== undefined ? { type } : {}),
    }
    if (type === 'object' || type === 'array') next.children ??= []
    else if (type !== undefined) {
      delete next.children
      delete next.description
    }
    return next
  })
}

export function applyOps(nodes: SchemaNode[], ops: SchemaOp[]): SchemaNode[] {
  let result = nodes
  for (const op of ops) {
    if (op.op === 'add') {
      result = addSchemaNode(result, op.name, op.type, op.parentName)
    } else if (op.op === 'remove') {
      result = removeSchemaNode(result, op.name, op.parentName)
    } else if (op.op === 'patch') {
      result = patchSchemaNode(result, op.name, op.newName, op.type, op.parentName)
    }
  }
  return result
}
