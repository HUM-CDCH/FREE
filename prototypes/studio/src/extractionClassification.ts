import type { SchemaNode } from 'extraction/schema'
import {
  isPopulatedResultScalar,
  resultPathKey,
  type ResultPath,
} from '../shared/groundedExtraction'
import { isInternalFieldName } from './fieldCoverage'

export type ExtractionFieldCounts = {
  grounded: number
  ungroundedWithValue: number
  missing: number
}

const EMPTY_COUNTS: ExtractionFieldCounts = { grounded: 0, ungroundedWithValue: 0, missing: 0 }

function addCounts(a: ExtractionFieldCounts, b: ExtractionFieldCounts): ExtractionFieldCounts {
  return {
    grounded: a.grounded + b.grounded,
    ungroundedWithValue: a.ungroundedWithValue + b.ungroundedWithValue,
    missing: a.missing + b.missing,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Builds the grounded-path lookup set `classifyExtractionFields` expects,
 *  from an extraction's `diagnostics.grounding.groundedPaths`. */
export function groundedPathKeySet(groundedPaths: readonly ResultPath[]): ReadonlySet<string> {
  return new Set(groundedPaths.map(resultPathKey))
}

/**
 * Classifies every leaf field occurrence of `schemaNodes` against an
 * extraction's `result` (the `{ records: [...] }` payload `diagnostics`
 * paths are relative to) into grounded / ungroundedWithValue / missing, in
 * one pass over schema + result together. The three counts always sum to
 * the number of leaf occurrences visited (array-of-object groups expand
 * into one visit per actual item) — this is never derived by combining
 * `resultStats.ts`'s and `grounding.ts`'s independently-computed counts,
 * which disagree on edge cases like empty arrays (see design.md D1 in
 * openspec/changes/extraction-review-metrics-and-sampling).
 */
export function classifyExtractionFields(
  schemaNodes: readonly SchemaNode[] | null,
  result: unknown,
  groundedPathKeys: ReadonlySet<string>,
): ExtractionFieldCounts {
  if (!schemaNodes || schemaNodes.length === 0) return EMPTY_COUNTS
  const records = isRecord(result) && Array.isArray(result.records) ? result.records : []
  let counts = EMPTY_COUNTS
  records.forEach((record, recordIndex) => {
    counts = addCounts(counts, visitNodes(schemaNodes, record, ['records', recordIndex], groundedPathKeys))
  })
  return counts
}

function visitNodes(
  nodes: readonly SchemaNode[],
  parentValue: unknown,
  parentPath: ResultPath,
  groundedPathKeys: ReadonlySet<string>,
): ExtractionFieldCounts {
  const record = isRecord(parentValue) ? parentValue : null
  let counts = EMPTY_COUNTS
  for (const node of nodes) {
    if (isInternalFieldName(node.name)) continue
    const path: ResultPath = [...parentPath, node.name]
    const value = record ? record[node.name] : undefined
    counts = addCounts(
      counts,
      node.children
        ? node.type === 'array'
          ? visitRepeatedGroup(node.children, value, path, groundedPathKeys)
          : visitNodes(node.children, value, path, groundedPathKeys)
        : classifyLeaf(node, value, path, groundedPathKeys),
    )
  }
  return counts
}

/** An array-of-objects group: one visit per actual item, expanding the path
 *  with its index — matching how grounding claims are generated. An absent
 *  or empty array still counts each descendant leaf as missing exactly
 *  once, via a single placeholder visit over an empty record. */
function visitRepeatedGroup(
  children: readonly SchemaNode[],
  value: unknown,
  path: ResultPath,
  groundedPathKeys: ReadonlySet<string>,
): ExtractionFieldCounts {
  if (Array.isArray(value) && value.length > 0) {
    let counts = EMPTY_COUNTS
    value.forEach((item, index) => {
      counts = addCounts(counts, visitNodes(children, item, [...path, index], groundedPathKeys))
    })
    return counts
  }
  return visitNodes(children, undefined, [...path, 0], groundedPathKeys)
}

function classifyLeaf(
  node: SchemaNode,
  value: unknown,
  path: ResultPath,
  groundedPathKeys: ReadonlySet<string>,
): ExtractionFieldCounts {
  if (node.type === 'array') {
    if (Array.isArray(value) && value.length > 0) {
      let counts = EMPTY_COUNTS
      value.forEach((item, index) => {
        counts = addCounts(counts, classifyScalar(item, [...path, index], groundedPathKeys))
      })
      return counts
    }
    return { grounded: 0, ungroundedWithValue: 0, missing: 1 }
  }
  return classifyScalar(value, path, groundedPathKeys)
}

function classifyScalar(
  value: unknown,
  path: ResultPath,
  groundedPathKeys: ReadonlySet<string>,
): ExtractionFieldCounts {
  if (!isPopulatedResultScalar(value)) return { grounded: 0, ungroundedWithValue: 0, missing: 1 }
  return groundedPathKeys.has(resultPathKey(path))
    ? { grounded: 1, ungroundedWithValue: 0, missing: 0 }
    : { grounded: 0, ungroundedWithValue: 1, missing: 0 }
}
