import type { DocumentInput } from './_document.js'
import { documentFileParts } from './_pdf.js'
import { schemaPrompt, schemaSourceExcerpts } from './_schema.js'
import { ApiError } from './_http.js'
import { parseTemplate } from './_model_output.js'
import { traceModelCall } from '../server/tracing.js'
import {
  executeSchemaSuggestion,
  resolveModelTarget,
  type DocumentContentPart,
  type ModelCaller,
  type ModelDependencies,
} from './_model_execution.js'
import type { ExecutionTarget } from './_provider.js'
import {
  parseBatchSuggestionDefinition,
  templateToSchemaDefinition,
  type SchemaDefinition,
  type SchemaNode,
} from 'extraction/schema'

export type SchemaModelInput = {
  readonly document: DocumentInput
  readonly instruction: string
  readonly temperature?: number
  readonly signal?: AbortSignal
}

async function documentContentParts(document: DocumentInput): Promise<{
  readonly parts: readonly DocumentContentPart[]
  readonly pages: number | null
}> {
  if (document.markdown) {
    return { parts: [{ type: 'text', text: document.markdown }], pages: document.pages }
  }
  if (!document.file) {
    throw new ApiError(400, 'invalid_request', "No document content: provide a 'file' or 'document_markdown'")
  }
  const fileParts = await documentFileParts(document.file)
  return { parts: fileParts.parts, pages: fileParts.pages }
}

/** Complete single-source suggestion: prepare source, resolve route, call model, interpret the schema. */
export function generateSchemaWithModel(...call: Parameters<typeof suggestSchema>): ReturnType<typeof suggestSchema> {
  return traceModelCall('schema-suggestion', () => suggestSchema(...call), (result) => result.template)
}

async function suggestSchema(
  caller: ModelCaller,
  { document, instruction, temperature, signal }: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{ readonly template: Record<string, unknown>; readonly raw: string; readonly pages: number | null }> {
  const resolved = await resolveModelTarget('schema-suggestion', temperature, target, caller, dependencies)
  const documentParts = await documentContentParts({
    ...document,
    markdown: document.markdown ? schemaSourceExcerpts(document.markdown) : document.markdown,
  })
  const generated = await executeSchemaSuggestion(resolved, {
    instructions:
      'Propose a compact extraction schema grounded in the supplied source document. ' +
      'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
    guidance: schemaPrompt(instruction),
    documentParts: documentParts.parts,
    temperature,
    signal,
  }, dependencies.fetch)
  const parsed = await parseTemplate(generated.response)
  if (typeof parsed._description !== 'string' || parsed._description.trim().length === 0)
    throw new ApiError(502, 'invalid_model_output', 'The generated Extraction Schema has no root record description.')
  return { template: parsed, raw: generated.response, pages: documentParts.pages ?? document.pages }
}

const SOURCE_SUGGESTION_INSTRUCTION =
  'Suggest reusable extraction fields for this Source Document. FREE records Evidence and its locations itself, so suggest only fields that describe the content of the researcher\'s records.'
const MERGE_INSTRUCTION =
  'Return one compact Extraction Schema containing only fields present in every supplied Source Document suggestion. Do not include extracted values, alternatives or merge notes; FREE records Evidence and its locations itself, so keep only fields that describe the content of the researcher\'s records.'

function modelSuggestedDefinition(template: unknown): SchemaDefinition {
  try {
    return parseBatchSuggestionDefinition(templateToSchemaDefinition(template))
  } catch (error) {
    throw new ApiError(502, 'invalid_model_output',
      error instanceof Error ? error.message : 'The model returned an invalid Schema Suggestion.')
  }
}

/** Per-source batch call; unlike single generation, the result must be an editable batch definition. */
export async function suggestBatchSource(
  caller: ModelCaller,
  markdown: string,
  signal: AbortSignal,
  generate: typeof generateSchemaWithModel = generateSchemaWithModel,
): Promise<SchemaDefinition> {
  const generated = await generate(caller, {
    document: { file: null, markdown, pages: null },
    instruction: SOURCE_SUGGESTION_INSTRUCTION,
    signal,
  })
  return modelSuggestedDefinition(generated.template)
}

export type FieldCoverage = { nodeId: string; present: number; total: number }

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
  sources: readonly SchemaDefinition[],
  path: readonly string[] = [],
  coverage: FieldCoverage[] = [],
): FieldCoverage[] {
  for (const node of nodes) {
    const nodePath = [...path, node.name]
    coverage.push({
      nodeId: node.id,
      present: sources.filter((source) => pathExists(source.schemaNodes, nodePath)).length,
      total: sources.length,
    })
    if (node.children) coverageFor(node.children, sources, nodePath, coverage)
  }
  return coverage
}

/** One model-assisted merge, then validation and coverage reporting (not coverage enforcement). */
export async function suggestBatchCommon(
  caller: ModelCaller,
  sources: readonly { sourceDocumentId: string; definition: SchemaDefinition }[],
  signal: AbortSignal,
  generate: typeof generateSchemaWithModel = generateSchemaWithModel,
): Promise<{ definition: SchemaDefinition; coverage: FieldCoverage[] } | null> {
  const generated = await generate(caller, {
    document: {
      file: null,
      markdown: sources
        .map((source) => `SOURCE DOCUMENT ${source.sourceDocumentId} SUGGESTION:\n${JSON.stringify(source.definition)}`)
        .join('\n\n'),
      pages: null,
    },
    instruction: MERGE_INSTRUCTION,
    signal,
  })
  const definition = modelSuggestedDefinition(generated.template)
  if (definition.schemaNodes.length === 0) return null
  return { definition, coverage: coverageFor(definition.schemaNodes, sources.map((source) => source.definition)) }
}
