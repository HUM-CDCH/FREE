import {
  type SchemaDefinition,
  type SchemaNode,
  templateToSchemaDefinition,
} from '../shared/schemaNode.js'
import { ApiError } from './_http.js'

const reservedEvidenceNames = new Set([
  'evidence',
  'snippet',
  'snippets',
  'page',
  'pages',
  'bbox',
  'bboxes',
  'occurrenceid',
  'occurrenceids',
  'fuzzymatch',
  'fuzzymatches',
])

function normalizedFieldName(name: string): string {
  return name.replace(/[^a-z0-9]/gi, '').toLowerCase()
}

function rejectReservedEvidenceNames(nodes: readonly SchemaNode[]): void {
  for (const node of nodes) {
    if (reservedEvidenceNames.has(normalizedFieldName(node.name)))
      throw new Error(
        `Schema suggestions cannot define reserved Evidence field ${node.name}.`,
      )
    if (node.children) rejectReservedEvidenceNames(node.children)
  }
}

function rejectDuplicateNames(nodes: readonly SchemaNode[]): void {
  const names = new Set<string>()
  for (const node of nodes) {
    if (names.has(node.name))
      throw new Error(
        `Schema suggestions cannot repeat field name ${node.name}.`,
      )
    names.add(node.name)
    if (node.children) rejectDuplicateNames(node.children)
  }
}

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
    | 'unexpected_failure'
} {
  if (
    error instanceof ApiError &&
    (error.code === 'invalid_model_config' ||
      error.code === 'model_operation_failed' ||
      error.code === 'invalid_model_output')
  )
    return { code: error.code }
  return { code: 'unexpected_failure' }
}

/** Reject, never strip, fields that are owned by canonical parser Evidence. */
export function modelSuggestedDefinition(template: unknown): SchemaDefinition {
  try {
    const definition = templateToSchemaDefinition(template)
    rejectReservedEvidenceNames(definition.schemaNodes)
    rejectDuplicateNames(definition.schemaNodes)
    return definition
  } catch (error) {
    return invalidModelOutput(error)
  }
}

/** The researcher may edit names, but cannot create duplicate or Evidence fields. */
export function validateEditableSuggestion(
  definition: SchemaDefinition,
): SchemaDefinition {
  try {
    rejectReservedEvidenceNames(definition.schemaNodes)
    rejectDuplicateNames(definition.schemaNodes)
    return definition
  } catch (error) {
    throw new ApiError(
      422,
      'invalid_request',
      error instanceof Error ? error.message : 'Common fields are invalid.',
    )
  }
}

type FieldCoverage = {
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
