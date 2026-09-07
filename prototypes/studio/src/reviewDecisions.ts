import type { SchemaNode } from 'extraction/schema'
import type {
  ReviewDecision,
  ReviewDecisionInput,
} from '../shared/extraction.contract'

type Decision = ReviewDecision | ReviewDecisionInput

/** Display ordering only: preserve values, unknown fields and array positions. */
export function orderResultFields(value: unknown, nodes: readonly SchemaNode[]): unknown {
  if (Array.isArray(value)) return value.map((item) => orderResultFields(item, nodes))
  if (value === null || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const byName = new Map(nodes.map((node) => [node.name, node]))
  const names = [...nodes.map((node) => node.name).filter((name) => Object.hasOwn(record, name)),
    ...Object.keys(record).filter((name) => !byName.has(name))]
  return Object.fromEntries(names.map((name) => {
    const children = byName.get(name)?.children
    return [name, children ? orderResultFields(record[name], children) : record[name]]
  }))
}

export function resultPathKey(path: readonly (string | number)[]): string {
  return JSON.stringify(path)
}

export function applyReviewDecisions(
  result: unknown,
  decisions: readonly Decision[],
): unknown {
  const copy = structuredClone(result)
  for (const decision of decisions) {
    if (decision.action === 'APPROVED') continue
    setAtPath(
      copy,
      decision.resultPath,
      decision.action === 'EDITED' ? decision.reviewedValue : null,
    )
  }
  return copy
}

export function schemaNodeAtResultPath(
  nodes: readonly SchemaNode[],
  resultPath: readonly (string | number)[],
): SchemaNode | null {
  const path = resultPath
    .map(String)
    .filter((segment, index) => !(index === 0 && segment === 'records'))
    .filter((segment) => !/^\d+$/.test(segment))
  let level = nodes
  let current: SchemaNode | null = null
  for (const segment of path) {
    current = level.find((node) => node.name === segment) ?? null
    if (!current) return null
    level = current.children ?? []
  }
  return current
}

export function parseReviewedValue(
  node: SchemaNode | null,
  raw: string,
): { value: string | number | boolean; error: string | null } {
  if (!node)
    return { value: raw, error: 'The pinned schema does not define this value.' }
  if (node.allowedValues && !node.allowedValues.includes(raw))
    return { value: raw, error: 'Choose a value allowed by the pinned schema.' }
  // A decision on one array item resolves to the array node, so edit against
  // its item type. Same rule as `reviewDecisionMatchesSchema` on the server.
  switch (node.type === 'array' && node.itemType ? node.itemType : node.type) {
    case 'boolean':
      if (raw === 'true') return { value: true, error: null }
      if (raw === 'false') return { value: false, error: null }
      return { value: raw, error: 'Choose true or false.' }
    case 'integer': {
      const value = Number(raw)
      return Number.isInteger(value) && raw.trim() !== ''
        ? { value, error: null }
        : { value: raw, error: 'Enter a whole number.' }
    }
    case 'number': {
      const value = Number(raw)
      return Number.isFinite(value) && raw.trim() !== ''
        ? { value, error: null }
        : { value: raw, error: 'Enter a number.' }
    }
    case 'date':
    case 'string':
    case 'verbatim-string':
      return raw.trim() === ''
        ? { value: raw, error: 'Enter a value.' }
        : { value: raw, error: null }
    default:
      return { value: raw, error: 'Only scalar values can be edited.' }
  }
}

function setAtPath(
  root: unknown,
  path: readonly (string | number)[],
  value: unknown,
) {
  if (path.length === 0) return
  let parent = root
  for (const segment of path.slice(0, -1)) {
    if (parent === null || typeof parent !== 'object') return
    parent = (parent as Record<string | number, unknown>)[segment]
  }
  if (parent !== null && typeof parent === 'object')
    (parent as Record<string | number, unknown>)[path[path.length - 1]] = value
}
