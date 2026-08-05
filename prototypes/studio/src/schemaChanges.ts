import type { SchemaEditIssue, ProposedSchemaEdit } from '../shared/schemaEdit.contract'
import {
  enumerateFieldPaths,
  mkId,
  type SchemaNode,
} from '../shared/schemaNode'

export type Change = {
  id: string
  kind: 'added' | 'removed' | 'modified'
  before: SchemaNode | null
  after: SchemaNode | null
  parentId?: string | null
  outcome: 'applied' | 'unresolved' | 'conflict'
  reason?: string
  note?: string
}

export type DerivedProposal = {
  nodes: SchemaNode[]
  reviewNodes: SchemaNode[]
  changes: Change[]
  issues: SchemaEditIssue[]
}

export type ReplayOutcome = Change['outcome'] | 'rejected'

export type ReplayResult = {
  nodes: SchemaNode[]
  outcomes: ReadonlyMap<string, ReplayOutcome>
}

export function deriveSchemaProposal(
  original: readonly SchemaNode[],
  response: ProposedSchemaEdit,
): DerivedProposal {
  const keyById = new Map(enumerateFieldPaths(original).map(({ id, key }) => [id, key]))
  const changes: Change[] = []

  const transform = (level: readonly SchemaNode[]): SchemaNode[] => {
    const out: SchemaNode[] = []
    for (const node of level) {
      const before = cloneNode(node)
      const edit = response.fields[keyById.get(node.id) ?? '']
      if (edit?.removed) {
        changes.push({ id: node.id, kind: 'removed', before, after: null, outcome: 'applied' })
        continue
      }

      const children = node.children && (!edit || isContainer(edit.type)) ? transform(node.children) : node.children
      let after = children === undefined ? { ...node } : { ...node, children }
      let outcome: Change['outcome'] = 'applied'
      let reason: string | undefined
      let note: string | undefined
      if (edit) {
        after = { ...after, name: edit.name }
        const requestedContainer = isContainer(edit.type)
        const existingContainer = after.children !== undefined
        if (after.allowedValues && edit.type !== 'string') {
          after.type = 'string'
          outcome = 'conflict'
          reason = 'Allowed values pin this field to string; the requested type was not applied.'
        } else {
          after.type = edit.type
          if (requestedContainer !== existingContainer) {
            const losses = [
              after.description && 'description',
              after.allowedValues && 'allowed values',
              existingContainer && after.children?.length && 'nested fields',
            ].filter(Boolean)
            delete after.description
            delete after.allowedValues
            if (requestedContainer) after.children = []
            else delete after.children
            note = losses.length ? `Retyping across the container boundary removed ${losses.join(' and ')}.` : undefined
          }
        }
      }
      out.push(after)
      if (!sameOwnState(before, after) || reason) {
        changes.push({
          id: node.id,
          kind: 'modified',
          before,
          after: cloneNode(after),
          outcome,
          ...(reason && { reason }),
          ...(note && { note }),
        })
      }
    }
    return out
  }

  let nodes = transform(original)
  const issues = [...response.issues]
  const additions = response.additions
    .map((addition, index) => ({ addition, index, id: mkId() }))
    .sort((a, b) => a.addition.path.length - b.addition.path.length || a.index - b.index)

  for (const { addition, id } of additions) {
    const name = addition.path.at(-1)!
    const hasChildren = additions.some(({ addition: other }) =>
      other.path.length > addition.path.length &&
      addition.path.every((part, index) => other.path[index] === part))
    const node: SchemaNode = {
      id,
      name,
      type: addition.type,
      ...((addition.type === 'object' || (addition.type === 'array' && hasChildren)) ? { children: [] } : {}),
    }
    const parentPath = addition.path.slice(0, -1)
    const inserted = insertAdditionAtPath(nodes, parentPath, node)
    if (inserted === null) {
      const key = addition.path.join('.')
      issues.push({ kind: 'unknown-key', key })
      changes.push({
        id,
        kind: 'added',
        before: null,
        after: node,
        outcome: 'unresolved',
        reason: `Addition path ${key} did not resolve in the proposed schema.`,
      })
    } else {
      nodes = inserted.nodes
      changes.push({ id, kind: 'added', before: null, after: cloneNode(node), parentId: inserted.parentId, outcome: 'applied' })
    }
  }

  return { nodes, reviewNodes: mergeReviewNodes(original, nodes, new Map(changes.map((change) => [change.id, change]))), changes, issues }
}

export function replaySchemaChanges(
  original: readonly SchemaNode[],
  changes: readonly Change[],
  acceptedIds: ReadonlySet<string>,
): ReplayResult {
  const blockedIds = new Set<string>()
  // Validate the final accepted namespace so swaps stay atomic while collisions are rejected.
  while (true) {
    const replayed = replaySchemaChangesOnce(original, changes, acceptedIds, blockedIds)
    const duplicateIds = duplicateSiblingIds(replayed.nodes)
    const newlyBlocked = changes.filter((change) =>
      acceptedIds.has(change.id) &&
      !blockedIds.has(change.id) &&
      duplicateIds.has(change.id) &&
      changesFieldName(change),
    )
    if (newlyBlocked.length === 0) return replayed
    for (const change of newlyBlocked) blockedIds.add(change.id)
  }
}

function replaySchemaChangesOnce(
  original: readonly SchemaNode[],
  changes: readonly Change[],
  acceptedIds: ReadonlySet<string>,
  blockedIds: ReadonlySet<string>,
): ReplayResult {
  let nodes = original.map(cloneNode)
  const outcomes = new Map<string, ReplayOutcome>()

  for (const change of changes) {
    if (!acceptedIds.has(change.id)) {
      outcomes.set(change.id, 'rejected')
      continue
    }
    if (change.outcome === 'unresolved' || blockedIds.has(change.id)) {
      outcomes.set(change.id, 'unresolved')
      continue
    }

    if (change.kind === 'added') {
      const inserted = change.after && change.parentId !== undefined
        ? insertAdditionAtId(nodes, change.parentId, cloneNode(change.after))
        : null
      if (inserted === null) outcomes.set(change.id, 'unresolved')
      else {
        nodes = inserted
        outcomes.set(change.id, change.outcome)
      }
      continue
    }

    const replayed = replayExistingChange(nodes, change)
    nodes = replayed.nodes
    outcomes.set(change.id, replayed.found ? change.outcome : 'unresolved')
  }

  return { nodes, outcomes }
}

function duplicateSiblingIds(nodes: readonly SchemaNode[]): Set<string> {
  const duplicates = new Set<string>()
  const visit = (level: readonly SchemaNode[]) => {
    const byName = new Map<string, SchemaNode[]>()
    for (const node of level) {
      const matches = byName.get(node.name)
      if (matches) matches.push(node)
      else byName.set(node.name, [node])
      if (node.children) visit(node.children)
    }
    for (const matches of byName.values()) {
      if (matches.length > 1) for (const node of matches) duplicates.add(node.id)
    }
  }
  visit(nodes)
  return duplicates
}

function changesFieldName(change: Change): boolean {
  return change.kind === 'added' || (
    change.kind === 'modified' && change.before?.name !== change.after?.name
  )
}

function insertAdditionAtPath(
  nodes: readonly SchemaNode[],
  parentPath: readonly string[],
  addition: SchemaNode,
): { nodes: SchemaNode[]; parentId: string | null } | null {
  if (parentPath.length === 0) {
    if (nodes.some((node) => node.name === addition.name)) return null
    return { nodes: [...nodes, addition], parentId: null }
  }

  let matches = 0
  let parentId: string | null = null
  const visit = (level: readonly SchemaNode[], depth: number): SchemaNode[] => level.map((node) => {
    if (node.name !== parentPath[depth]) return node
    if (depth === parentPath.length - 1) {
      if (node.children === undefined || node.children.some((child) => child.name === addition.name)) return node
      matches++
      parentId = node.id
      return { ...node, children: [...node.children, addition] }
    }
    if (node.children === undefined) return node
    return { ...node, children: visit(node.children, depth + 1) }
  })
  const inserted = visit(nodes, 0)
  return matches === 1 ? { nodes: inserted, parentId } : null
}

function insertAdditionAtId(
  nodes: readonly SchemaNode[],
  parentId: string | null,
  addition: SchemaNode,
): SchemaNode[] | null {
  if (parentId === null) {
    return nodes.some((node) => node.name === addition.name) ? null : [...nodes, addition]
  }

  let matches = 0
  const visit = (level: readonly SchemaNode[]): SchemaNode[] => level.map((node) => {
    if (node.id === parentId) {
      if (node.children === undefined || node.children.some((child) => child.name === addition.name)) return node
      matches++
      return { ...node, children: [...node.children, addition] }
    }
    return node.children === undefined ? node : { ...node, children: visit(node.children) }
  })
  const inserted = visit(nodes)
  return matches === 1 ? inserted : null
}

function replayExistingChange(nodes: readonly SchemaNode[], change: Change): { nodes: SchemaNode[]; found: boolean } {
  let found = false
  const visit = (level: readonly SchemaNode[]): SchemaNode[] => {
    const out: SchemaNode[] = []
    for (const node of level) {
      if (node.id === change.id) {
        found = true
        if (change.kind === 'removed') continue
        const after = cloneNode(change.after!)
        if (node.children !== undefined && change.before?.children !== undefined && after.children !== undefined) {
          after.children = node.children.map(cloneNode)
        }
        out.push(after)
      } else {
        out.push(node.children === undefined ? node : { ...node, children: visit(node.children) })
      }
    }
    return out
  }
  return { nodes: visit(nodes), found }
}

function mergeReviewNodes(
  original: readonly SchemaNode[],
  proposed: readonly SchemaNode[],
  changes: ReadonlyMap<string, Change>,
): SchemaNode[] {
  const out: SchemaNode[] = []
  let next = 0
  for (const oldNode of original) {
    if (changes.get(oldNode.id)?.kind === 'removed') {
      out.push(cloneNode(oldNode))
      continue
    }
    while (next < proposed.length && proposed[next].id !== oldNode.id) out.push(cloneNode(proposed[next++]))
    if (next < proposed.length) {
      const node = proposed[next++]
      out.push(node.children && oldNode.children
        ? { ...node, children: mergeReviewNodes(oldNode.children, node.children, changes) }
        : cloneNode(node))
    }
  }
  while (next < proposed.length) out.push(cloneNode(proposed[next++]))
  return out
}

function isContainer(type: string): boolean {
  return type === 'object' || type === 'array'
}

function cloneNode(node: SchemaNode): SchemaNode {
  return node.children ? { ...node, children: node.children.map(cloneNode) } : { ...node }
}

function sameOwnState(left: SchemaNode, right: SchemaNode): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.type === right.type &&
    left.description === right.description &&
    JSON.stringify(left.allowedValues) === JSON.stringify(right.allowedValues) &&
    (left.children === undefined) === (right.children === undefined)
  )
}
