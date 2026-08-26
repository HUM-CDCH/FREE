import { enumerateFieldPaths, type SchemaNode } from 'extraction/schema'

export type SchemaDrag = {
  id: string
  parentId: string | null
  isGroup: boolean
}

export type SchemaDropTarget =
  | { type: 'slot'; parentId: string | null; index: number }
  | { type: 'group'; id: string }

export type SchemaDragMode = 'indent' | 'outdent' | 'normal'

const INDENT_THRESHOLD = 48
const VERTICAL_TOLERANCE = 20

export function schemaDragMode(dx: number, dy: number): SchemaDragMode {
  if (Math.abs(dx) <= INDENT_THRESHOLD || Math.abs(dy) >= VERTICAL_TOLERANCE)
    return 'normal'
  return dx > 0 ? 'indent' : 'outdent'
}

function deepClone(nodes: readonly SchemaNode[]): SchemaNode[] {
  return nodes.map((node) =>
    node.children
      ? { ...node, children: deepClone(node.children) }
      : { ...node },
  )
}

/** Remove one stable node id without mutating the supplied tree. */
export function removeSchemaNode(
  nodes: readonly SchemaNode[],
  id: string,
): [SchemaNode | null, SchemaNode[]] {
  const root = deepClone(nodes)
  function remove(level: SchemaNode[]): SchemaNode | null {
    for (let index = 0; index < level.length; index += 1) {
      if (level[index]!.id === id) return level.splice(index, 1)[0]!
      const children = level[index]!.children
      if (children) {
        const found = remove(children)
        if (found) return found
      }
    }
    return null
  }
  return [remove(root), root]
}

export function updateSchemaNode(
  nodes: readonly SchemaNode[],
  id: string,
  update: (node: SchemaNode) => SchemaNode,
): SchemaNode[] {
  return nodes.map((node) => {
    if (node.id === id) return update(node)
    return node.children === undefined
      ? node
      : { ...node, children: updateSchemaNode(node.children, id, update) }
  })
}

export function schemaAncestorIds(
  nodes: readonly SchemaNode[],
  targetIds: ReadonlySet<string>,
): Set<string> {
  const ancestors = new Set<string>()
  const visit = (level: readonly SchemaNode[], path: readonly string[]) => {
    for (const node of level) {
      if (targetIds.has(node.id)) {
        path.forEach((id) => ancestors.add(id))
        if (node.children !== undefined) ancestors.add(node.id)
      }
      if (node.children) visit(node.children, [...path, node.id])
    }
  }
  visit(nodes, [])
  return ancestors
}

function nodeWithChildren(node: SchemaNode, children: SchemaNode[]): SchemaNode {
  return {
    id: node.id,
    name: node.name,
    type:
      node.type === 'array'
        ? 'array'
        : node.children === undefined
          ? 'object'
          : node.type,
    children,
    ...(node.description && { description: node.description }),
  }
}

function insertIntoNode(
  nodes: SchemaNode[],
  targetId: string,
  moved: SchemaNode,
): SchemaNode[] {
  return nodes.map((node) => {
    if (node.id === targetId)
      return nodeWithChildren(node, [...(node.children ?? []), moved])
    return node.children
      ? { ...node, children: insertIntoNode(node.children, targetId, moved) }
      : node
  })
}

function insertAtSlot(
  nodes: SchemaNode[],
  parentId: string | null,
  index: number,
  moved: SchemaNode,
): SchemaNode[] {
  if (parentId === null) {
    const output = [...nodes]
    output.splice(Math.max(0, Math.min(index, output.length)), 0, moved)
    return output
  }
  return nodes.map((node) => {
    if (node.id === parentId) {
      const children = [...(node.children ?? [])]
      children.splice(Math.max(0, Math.min(index, children.length)), 0, moved)
      return nodeWithChildren(node, children)
    }
    return node.children
      ? {
          ...node,
          children: insertAtSlot(node.children, parentId, index, moved),
        }
      : node
  })
}

function sourceIndex(nodes: readonly SchemaNode[], drag: SchemaDrag): number {
  if (drag.parentId === null)
    return nodes.findIndex((node) => node.id === drag.id)
  function search(level: readonly SchemaNode[]): number {
    for (const node of level) {
      if (node.id === drag.parentId)
        return (node.children ?? []).findIndex((child) => child.id === drag.id)
      if (node.children) {
        const found = search(node.children)
        if (found !== -1) return found
      }
    }
    return -1
  }
  return search(nodes)
}

function siblingsOf(
  nodes: readonly SchemaNode[],
  parentId: string | null,
): readonly SchemaNode[] {
  if (parentId === null) return nodes
  const search = (level: readonly SchemaNode[]): readonly SchemaNode[] | null => {
    for (const node of level) {
      if (node.id === parentId) return node.children ?? []
      if (node.children) {
        const found = search(node.children)
        if (found) return found
      }
    }
    return null
  }
  return search(nodes) ?? nodes
}

function parentIdOf(nodes: readonly SchemaNode[], childId: string): string | null {
  const search = (level: readonly SchemaNode[]): string | null | undefined => {
    for (const node of level) {
      if (!node.children) continue
      if (node.children.some((child) => child.id === childId)) return node.id
      const found = search(node.children)
      if (found !== undefined) return found
    }
    return undefined
  }
  return search(nodes) ?? null
}

function sameNodeIds(
  left: readonly SchemaNode[],
  right: readonly SchemaNode[],
): boolean {
  const ids = (nodes: readonly SchemaNode[]) =>
    enumerateFieldPaths(nodes)
      .map(({ id }) => id)
      .sort()
  const leftIds = ids(left)
  const rightIds = ids(right)
  return (
    leftIds.length === rightIds.length &&
    leftIds.every((id, index) => id === rightIds[index])
  )
}

/**
 * Resolve one completed drag gesture. Null means no valid move; every returned
 * tree preserves the exact stable-id set of the input.
 */
export function moveSchemaNodes(
  nodes: readonly SchemaNode[],
  drag: SchemaDrag,
  target: SchemaDropTarget | null,
  dx: number,
  dy: number,
): SchemaNode[] | null {
  const mode = schemaDragMode(dx, dy)
  let output: SchemaNode[] | null = null

  if (mode === 'indent') {
    const siblings = siblingsOf(nodes, drag.parentId)
    const index = siblings.findIndex((node) => node.id === drag.id)
    if (index > 0) {
      const previous = siblings[index - 1]!
      const [moved, without] = removeSchemaNode(nodes, drag.id)
      if (!moved) return null
      const insertIndex =
        target?.type === 'slot' && target.parentId === previous.id
          ? target.index
          : (previous.children ?? []).length
      output = insertAtSlot(without, previous.id, insertIndex, moved)
    } else if (drag.parentId === null && index === 0) {
      const node = nodes[0]
      if (!node?.children?.length) return null
      const leaf: SchemaNode = {
        id: node.id,
        name: node.name,
        type: 'verbatim-string',
      }
      output = [leaf, ...node.children, ...nodes.slice(1)]
    }
  } else if (mode === 'outdent' && drag.parentId !== null) {
    const [moved, without] = removeSchemaNode(nodes, drag.id)
    if (!moved) return null
    const grandparentId = without.some((node) => node.id === drag.parentId)
      ? null
      : parentIdOf(without, drag.parentId)
    if (target?.type === 'slot' && target.parentId === grandparentId) {
      output = insertAtSlot(without, grandparentId, target.index, moved)
    } else {
      const grandparentSiblings = siblingsOf(without, grandparentId)
      const parentIndex = grandparentSiblings.findIndex(
        (node) => node.id === drag.parentId,
      )
      output = insertAtSlot(
        without,
        grandparentId,
        Math.max(0, parentIndex + 1),
        moved,
      )
    }
  } else if (mode === 'normal' && target?.type === 'group') {
    if (drag.isGroup) return null
    const [moved, without] = removeSchemaNode(nodes, drag.id)
    if (!moved) return null
    output = insertIntoNode(without, target.id, moved)
  } else if (mode === 'normal' && target?.type === 'slot') {
    const index = sourceIndex(nodes, drag)
    const [moved, without] = removeSchemaNode(nodes, drag.id)
    if (!moved) return null
    const insertion =
      drag.parentId === target.parentId && index < target.index
        ? target.index - 1
        : target.index
    output = insertAtSlot(without, target.parentId, insertion, moved)
  }

  return output && sameNodeIds(nodes, output) ? output : null
}
