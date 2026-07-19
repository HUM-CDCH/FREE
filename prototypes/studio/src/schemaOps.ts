import { type SchemaNode, mkId } from './schemaNode'

export type SchemaOp =
  | { op: 'add'; name: string; type: string; parentName?: string }
  | { op: 'remove'; name: string; parentName?: string }
  | { op: 'patch'; name: string; newName?: string; type?: string; parentName?: string }

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
  type: string,
  parentName?: string,
): SchemaNode[] {
  const newNode: SchemaNode = { id: mkId(), name, type }

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
  type?: string,
  parentName?: string,
): SchemaNode[] {
  return mapNodes(nodes, (n, actualParent) => {
    if (!matches(n, name, parentName, actualParent)) return n
    return {
      ...n,
      ...(newName !== undefined ? { name: newName } : {}),
      ...(type !== undefined ? { type } : {}),
    }
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
