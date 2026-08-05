import type { FieldEdit, ProposedSchemaEdit, SchemaAddition, SchemaEditIssue } from '../shared/schemaEdit.contract'
import {
  duplicateFieldKeys,
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
  dependsOn?: readonly string[]
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
  appliedCount: number
  hasChanges: boolean
}

export function toggleAcceptedSchemaChange(
  changes: readonly Change[],
  current: ReadonlySet<string>,
  id: string,
): Set<string> {
  const next = new Set(current)
  if (next.has(id)) {
    const rejected = new Set([id])
    let grew = true
    while (grew) {
      grew = false
      for (const change of changes) {
        if (change.dependsOn?.some((dependencyId) => rejected.has(dependencyId)) && !rejected.has(change.id)) {
          rejected.add(change.id)
          grew = true
        }
      }
    }
    for (const rejectedId of rejected) next.delete(rejectedId)
    return next
  }

  next.add(id)
  const pendingDependencies = [...(changes.find((change) => change.id === id)?.dependsOn ?? [])]
  while (pendingDependencies.length > 0) {
    const dependencyId = pendingDependencies.pop()!
    if (next.has(dependencyId)) continue
    next.add(dependencyId)
    pendingDependencies.push(...(changes.find((change) => change.id === dependencyId)?.dependsOn ?? []))
  }
  return next
}

export function deriveSchemaProposal(
  original: readonly SchemaNode[],
  response: ProposedSchemaEdit,
): DerivedProposal {
  const originalFields = enumerateFieldPaths(original)
  const keyById = new Map(originalFields.map(({ id, key }) => [id, key]))
  const originalById = new Map(originalFields.map(({ id, node }) => [id, node]))
  const changes: Change[] = []

  const transform = (level: readonly SchemaNode[], parentPath: readonly string[] = []): SchemaNode[] => {
    const out: SchemaNode[] = []
    for (const node of level) {
      const before = cloneNode(node)
      const edit = response.fields[keyById.get(node.id) ?? '']
      if (edit?.removed) {
        const losses = metadataLosses(before)
        changes.push({
          id: node.id,
          kind: 'removed',
          before,
          after: null,
          outcome: 'applied',
          ...(losses.length && { note: `Removing this field also removes ${losses.join(' and ')}.` }),
        })
        continue
      }

      const proposedPath = [...parentPath, edit?.name ?? node.name]
      const retainsChildren = !edit || edit.type === 'object' || (edit.type === 'array' && edit.itemType === null)
      const children = node.children && retainsChildren ? transform(node.children, proposedPath) : node.children
      let after: SchemaNode = node.children === undefined ? cloneNode(node) : { ...node, children: children ?? node.children }
      let outcome: Change['outcome'] = 'applied'
      let reason: string | undefined
      let note: string | undefined
      if (edit) {
        if (after.allowedValues && edit.type !== 'string') {
          after = { ...after, name: edit.name }
          outcome = 'conflict'
          reason = 'Allowed values pin this field to string; the requested type was not applied.'
        } else {
          const edited = changeNodeType(after, edit)
          after = edited.node
          note = edited.losses.length ? `Retyping across the container boundary removed ${edited.losses.join(' and ')}.` : undefined
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
    rejectDuplicateRenames(out, changes)
    return out
  }

  let nodes = transform(original)
  const issues = [...response.issues]
  const additions = response.additions
    .map((addition, index) => ({ addition, index, id: mkId() }))
    .sort((a, b) => a.addition.path.length - b.addition.path.length || a.index - b.index)

  for (const { addition, id } of additions) {
    const name = addition.path.at(-1)!
    const node = addedSchemaNode(id, name, addition)
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
      const parentChange = inserted.parentId
        ? changes.find((change) => change.id === inserted.parentId)
        : undefined
      const parentRequired = parentChange && (
        parentChange.kind === 'added' || originalById.get(parentChange.id)?.children === undefined
      )
      changes.push({
        id,
        kind: 'added',
        before: null,
        after: cloneNode(node),
        parentId: inserted.parentId,
        ...(parentRequired && { dependsOn: [parentChange.id] }),
        outcome: 'applied',
      })
    }
  }

  return { nodes, reviewNodes: mergeReviewNodes(original, nodes, new Map(changes.map((change) => [change.id, change]))), changes, issues }
}

export function replaySchemaChanges(
  original: readonly SchemaNode[],
  changes: readonly Change[],
  acceptedIds: ReadonlySet<string>,
): ReplayResult {
  let nodes = original.map(cloneNode)
  const outcomes = new Map<string, ReplayOutcome>()

  for (const change of changes) {
    if (!acceptedIds.has(change.id)) {
      outcomes.set(change.id, 'rejected')
      continue
    }
    if (change.outcome === 'unresolved') {
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

  const fields = enumerateFieldPaths(nodes)
  const duplicateKeys = new Set(duplicateFieldKeys(fields))
  if (duplicateKeys.size > 0) {
    const collidingIds = new Set(fields.filter(({ key }) => duplicateKeys.has(key)).map(({ id }) => id))
    const rejectedIds = changes
      .filter((change) => (
        acceptedIds.has(change.id) &&
        collidingIds.has(change.id) &&
        change.kind === 'modified' &&
        change.before?.name !== change.after?.name
      ))
      .map(({ id }) => id)
    if (rejectedIds.length > 0) {
      const rejected = new Set(rejectedIds)
      const adjustedChanges = changes.map((change): Change => {
        if (!rejected.has(change.id) || change.kind !== 'modified' || !change.before || !change.after) return change
        return {
          ...change,
          after: { ...cloneNode(change.after), name: change.before.name },
          outcome: 'conflict',
          reason: `Renaming this field to ${change.after.name} would duplicate a sibling field.`,
        }
      })
      const replayed = replaySchemaChanges(
        original,
        adjustedChanges,
        acceptedIds,
      )
      const resolvedOutcomes = new Map(replayed.outcomes)
      for (const id of rejectedIds) resolvedOutcomes.set(id, 'conflict')
      return makeReplayResult(replayed.nodes, resolvedOutcomes, changes)
    }
  }

  return makeReplayResult(nodes, outcomes, changes)
}

function makeReplayResult(
  nodes: SchemaNode[],
  outcomes: ReadonlyMap<string, ReplayOutcome>,
  changes: readonly Change[],
): ReplayResult {
  const resultById = new Map(enumerateFieldPaths(nodes).map(({ id, node }) => [id, node]))
  const appliedCount = changes.filter((change) => {
    const outcome = outcomes.get(change.id)
    if (outcome !== 'applied' && outcome !== 'conflict') return false
    if (change.kind === 'added') return resultById.has(change.id)
    if (change.kind === 'removed') return !resultById.has(change.id)
    const result = resultById.get(change.id)
    return !!change.before && !!result && !sameOwnState(change.before, result)
  }).length
  return { nodes, outcomes, appliedCount, hasChanges: appliedCount > 0 }
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
      const change = changes.get(oldNode.id)
      if (change?.kind === 'modified' && oldNode.children !== undefined && node.children === undefined) {
        out.push(cloneNode(oldNode))
        continue
      }
      out.push(node.children && oldNode.children
        ? { ...node, children: mergeReviewNodes(oldNode.children, node.children, changes) }
        : cloneNode(node))
    }
  }
  while (next < proposed.length) out.push(cloneNode(proposed[next++]))
  return out
}

function addedSchemaNode(id: string, name: string, addition: SchemaAddition): SchemaNode {
  if (addition.type === 'object') return { id, name, type: addition.type, children: [] }
  if (addition.type === 'array') {
    return addition.itemType === null
      ? { id, name, type: addition.type, children: [] }
      : { id, name, type: addition.type, itemType: addition.itemType }
  }
  return { id, name, type: addition.type }
}

function changeNodeType(
  node: SchemaNode,
  edit: FieldEdit,
): { node: SchemaNode; losses: string[] } {
  const existingContainer = node.children !== undefined
  const requestedContainer = edit.type === 'object' || (edit.type === 'array' && edit.itemType === null)
  const crossesContainerBoundary = requestedContainer !== existingContainer
  const losses = crossesContainerBoundary ? metadataLosses(node) : []
  const base = {
    id: node.id,
    name: edit.name,
    ...(!crossesContainerBoundary && node.description && { description: node.description }),
  }

  if (edit.type === 'object') {
    return { node: { ...base, type: edit.type, children: existingContainer ? node.children : [] }, losses }
  }
  if (edit.type === 'array') {
    if (edit.itemType === null) {
      return { node: { ...base, type: edit.type, children: existingContainer ? node.children : [] }, losses }
    }
    return { node: { ...base, type: edit.type, itemType: edit.itemType }, losses }
  }
  if (edit.type === 'string') {
    return {
      node: {
        ...base,
        type: edit.type,
        ...(node.type === 'string' && node.allowedValues && { allowedValues: node.allowedValues }),
      },
      losses,
    }
  }
  return {
    node: { ...base, type: edit.type },
    losses,
  }
}

function metadataLosses(node: SchemaNode): string[] {
  return [
    node.description && 'its description',
    node.allowedValues && 'its allowed values',
    node.children?.length && 'its nested fields',
  ].filter((loss): loss is string => typeof loss === 'string')
}

function rejectDuplicateRenames(nodes: SchemaNode[], changes: Change[]): void {
  while (true) {
    const duplicateNames = new Set(
      nodes
        .map((node) => node.name)
        .filter((name, index, names) => names.indexOf(name) !== index),
    )
    if (duplicateNames.size === 0) return

    let rejectedRename = false
    for (const node of nodes) {
      if (!duplicateNames.has(node.name)) continue
      const change = changes.find((candidate) => candidate.id === node.id && candidate.kind === 'modified')
      if (!change?.before || change.before.name === node.name) continue

      const rejectedName = node.name
      node.name = change.before.name
      change.after = cloneNode(node)
      change.outcome = 'conflict'
      change.reason = `Renaming this field to ${rejectedName} would duplicate a sibling field.`
      rejectedRename = true
    }
    if (!rejectedRename) return
  }
}

function cloneNode(node: SchemaNode): SchemaNode {
  return node.children ? { ...node, children: node.children.map(cloneNode) } : { ...node }
}

function sameOwnState(left: SchemaNode, right: SchemaNode): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.type === right.type &&
    left.itemType === right.itemType &&
    left.description === right.description &&
    JSON.stringify(left.allowedValues) === JSON.stringify(right.allowedValues) &&
    (left.children === undefined) === (right.children === undefined)
  )
}
