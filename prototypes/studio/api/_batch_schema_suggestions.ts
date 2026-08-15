import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import type { ProjectStore } from '../../../packages/db/src/project-store.js'
import {
  type SchemaDefinition,
  type SchemaNode,
  templateToSchemaDefinition,
} from '../shared/schemaNode.js'
import { ApiError } from './_http.js'
import { generateSchemaWithModel } from './_model.js'

type SourceSuggestionStore = Pick<
  ProjectStore,
  | 'beginSourceSchemaSuggestion'
  | 'completeSourceSchemaSuggestion'
  | 'failSourceSchemaSuggestion'
>

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
      throw new Error(`Schema suggestions cannot define reserved Evidence field ${node.name}.`)
    if (node.children) rejectReservedEvidenceNames(node.children)
  }
}

function rejectDuplicateNames(nodes: readonly SchemaNode[]): void {
  const names = new Set<string>()
  for (const node of nodes) {
    if (names.has(node.name))
      throw new Error(`Schema suggestions cannot repeat field name ${node.name}.`)
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

function pathExists(nodes: readonly SchemaNode[], path: readonly string[]): boolean {
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
  sourceDefinitions: readonly SchemaDefinition[],
  path: readonly string[] = [],
  coverage: FieldCoverage[] = [],
): FieldCoverage[] {
  for (const node of nodes) {
    const nodePath = [...path, node.name]
    const present = sourceDefinitions.filter((source) =>
      pathExists(source.schemaNodes, nodePath),
    ).length
    coverage.push({ nodeId: node.id, present, total: sourceDefinitions.length })
    if (node.children) coverageFor(node.children, sourceDefinitions, nodePath, coverage)
  }
  return coverage
}

/** A merge response is usable only when every returned field exists in every source. */
export function verifiedCommonSuggestion(
  mergedTemplate: unknown,
  sourceTemplates: readonly unknown[],
): { definition: SchemaDefinition; coverage: FieldCoverage[] } | null {
  const definition = modelSuggestedDefinition(mergedTemplate)
  if (definition.schemaNodes.length === 0) return null
  const sourceDefinitions = sourceTemplates.map(modelSuggestedDefinition)
  const coverage = coverageFor(definition.schemaNodes, sourceDefinitions)
  if (coverage.some((field) => field.present !== field.total))
    throw new ApiError(
      502,
      'invalid_model_output',
      'The merged Schema Suggestion includes fields absent from a selected Source Document.',
    )
  return { definition, coverage }
}

/** One durable lease owner performs generation; every other trigger observes it. */
export async function runSourceSchemaSuggestion(
  store: SourceSuggestionStore,
  projectContextId: string,
  sourceDocumentId: string,
  dependencies: {
    readMarkdown?: typeof canonicalPackageStore.read
    generate?: typeof generateSchemaWithModel
  } = {},
): Promise<void> {
  const started = await store.beginSourceSchemaSuggestion(
    projectContextId,
    sourceDocumentId,
  )
  if (!started || started.status !== 'work') return
  try {
    const artifact = await (dependencies.readMarkdown ?? canonicalPackageStore.read)(
      started.descriptor,
      'markdown',
    )
    const generated = await (dependencies.generate ?? generateSchemaWithModel)({
      document: {
        file: null,
        markdown: new TextDecoder().decode(artifact.bytes),
        pages: null,
      },
      instruction:
        'Suggest reusable extraction fields for this Source Document. Never include canonical Evidence fields: _evidence, snippets, pages, bboxes, occurrence IDs, or fuzzy matches.',
    })
    modelSuggestedDefinition(generated.template)
    await store.completeSourceSchemaSuggestion(
      started.schemaSuggestionId,
      generated.template,
      generated.raw,
    )
  } catch (error) {
    await store.failSourceSchemaSuggestion(started.schemaSuggestionId, error)
    throw error
  }
}
