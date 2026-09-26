import {
  parseBatchSuggestionDefinition,
  type SchemaDefinition,
  type SchemaNode,
  templateToSchemaDefinition,
} from 'extraction/schema'
import { ApiError } from './_http.js'

function invalidModelOutput(error: unknown): never {
  throw new ApiError(
    502,
    'invalid_model_output',
    error instanceof Error
      ? error.message
      : 'The model returned an invalid Schema Suggestion.',
  )
}

export function sourceSuggestionFailure(error: unknown): {
  code:
    | 'invalid_model_config'
    | 'model_operation_failed'
    | 'invalid_model_output'
    | 'model_key_required'
    | 'unexpected_failure'
} {
  if (
    error instanceof ApiError &&
    (error.code === 'invalid_model_config' ||
      error.code === 'model_operation_failed' ||
      error.code === 'invalid_model_output' ||
      error.code === 'model_key_required')
  )
    return { code: error.code }
  return { code: 'unexpected_failure' }
}

/** Reject, never strip, fields that are owned by canonical parser Evidence. */
export function modelSuggestedDefinition(template: unknown): SchemaDefinition {
  try {
    return parseBatchSuggestionDefinition(templateToSchemaDefinition(template))
  } catch (error) {
    return invalidModelOutput(error)
  }
}

/** The researcher may edit names, but cannot create duplicate or Evidence fields. */
export function validateEditableSuggestion(
  definition: SchemaDefinition,
): SchemaDefinition {
  try {
    return parseBatchSuggestionDefinition(definition)
  } catch (error) {
    throw new ApiError(
      422,
      'invalid_request',
      error instanceof Error ? error.message : 'Common fields are invalid.',
    )
  }
}

export type FieldCoverage = {
  nodeId: string
  present: number
  total: number
}

function pathExists(nodes: readonly SchemaNode[], path: readonly string[]) {
  let level = nodes
  for (const name of path) {
    const node = level.find((candidate) => candidate.name === name)
    if (!node) return false
    level = node.children ?? []
  }
  return true
}

function coverageFor(
  nodes: readonly SchemaNode[],
  sources: readonly SchemaDefinition[],
  path: readonly string[] = [],
  coverage: FieldCoverage[] = [],
): FieldCoverage[] {
  for (const node of nodes) {
    const nodePath = [...path, node.name]
    coverage.push({
      nodeId: node.id,
      present: sources.filter((source) =>
        pathExists(source.schemaNodes, nodePath),
      ).length,
      total: sources.length,
    })
    if (node.children) coverageFor(node.children, sources, nodePath, coverage)
  }
  return coverage
}

/** Validate the merged schema and report, but do not enforce, source coverage. */
export function verifiedCommonSuggestion(
  mergedTemplate: unknown,
  sourceDefinitions: readonly SchemaDefinition[],
): { definition: SchemaDefinition; coverage: FieldCoverage[] } | null {
  const definition = modelSuggestedDefinition(mergedTemplate)
  if (definition.schemaNodes.length === 0) return null
  const coverage = coverageFor(definition.schemaNodes, sourceDefinitions)
  return { definition, coverage }
}
