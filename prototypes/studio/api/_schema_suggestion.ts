import type { DocumentInput } from './_document.js'
import { documentFileParts } from './_pdf.js'
import { EXCERPT_THRESHOLD, schemaPrompt, schemaSourceExcerpts } from './_schema.js'
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
import type { SchemaSource } from 'db'
import type { SourceCoverage } from '../shared/schemaSuggestionSource.contract.js'
import {
  parseBatchSuggestionDefinition,
  templateToSchemaDefinition,
  type SchemaDefinition,
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

/** Complete single-source suggestion: prepare source, resolve route, call model, interpret the schema. The result
 *  declares what of the source the model received (`sourceCoverage`); a file is sent whole. */
export function generateSchemaWithModel(...call: Parameters<typeof suggestSchema>): ReturnType<typeof suggestSchema> {
  return traceModelCall('schema-suggestion', () => suggestSchema(...call), (result) => result.template)
}

async function suggestSchema(
  caller: ModelCaller,
  { document, instruction, temperature, signal }: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{
  readonly template: Record<string, unknown>
  readonly raw: string
  readonly pages: number | null
  readonly sourceCoverage: SourceCoverage
}> {
  const resolved = await resolveModelTarget('schema-suggestion', temperature, target, caller, dependencies)
  const excerpts = document.markdown ? schemaSourceExcerpts(document.markdown, document.pageSpans) : null
  const documentParts = await documentContentParts({ ...document, markdown: excerpts ? excerpts.text : document.markdown })
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
  return {
    template: parsed,
    raw: generated.response,
    pages: documentParts.pages ?? document.pages,
    sourceCoverage: excerpts?.sourceCoverage ?? { complete: true },
  }
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
  source: SchemaSource,
  signal: AbortSignal,
  generate: typeof generateSchemaWithModel = generateSchemaWithModel,
): Promise<{ definition: SchemaDefinition; sourceCoverage: SourceCoverage }> {
  const generated = await generate(caller, {
    document: { file: null, markdown: source.markdown, pageSpans: source.pageSpans, pages: null },
    instruction: SOURCE_SUGGESTION_INSTRUCTION,
    signal,
  })
  return { definition: modelSuggestedDefinition(generated.template), sourceCoverage: generated.sourceCoverage }
}

/**
 * The merge's input: whole Source Document suggestions, in member order, while they fit the length a schema-suggestion
 * input is sent whole. A suggestion that does not fit is left out whole and named, never cut mid-structure.
 */
function mergeInput(sources: readonly { sourceDocumentId: string; definition: SchemaDefinition }[]): {
  markdown: string
  uncombined: string[]
} {
  const blocks: string[] = []
  const uncombined: string[] = []
  let length = 0
  for (const source of sources) {
    const block = `SOURCE DOCUMENT ${source.sourceDocumentId} SUGGESTION:\n${JSON.stringify(source.definition)}`
    const next = length + (blocks.length === 0 ? 0 : 2) + block.length
    if (next > EXCERPT_THRESHOLD) {
      uncombined.push(source.sourceDocumentId)
      continue
    }
    blocks.push(block)
    length = next
  }
  if (blocks.length === 0)
    throw new ApiError(422, 'merge_input_too_large',
      `No Source Document suggestion fits the ${EXCERPT_THRESHOLD.toLocaleString('en-US')}-character limit for combining common fields.`)
  return { markdown: blocks.join('\n\n'), uncombined }
}

/**
 * One model-assisted merge of the per-source suggestions, then validation. `uncombined` names the Source Documents
 * whose suggestions the merge did not read because the combined suggestions exceeded the limit; `definition` is null
 * when the merge found no common field.
 */
export async function suggestBatchCommon(
  caller: ModelCaller,
  sources: readonly { sourceDocumentId: string; definition: SchemaDefinition }[],
  signal: AbortSignal,
  generate: typeof generateSchemaWithModel = generateSchemaWithModel,
): Promise<{ definition: SchemaDefinition | null; uncombined: string[] }> {
  const { markdown, uncombined } = mergeInput(sources)
  const generated = await generate(caller, {
    document: { file: null, markdown, pages: null },
    instruction: MERGE_INSTRUCTION,
    signal,
  })
  const definition = modelSuggestedDefinition(generated.template)
  return { definition: definition.schemaNodes.length === 0 ? null : definition, uncombined }
}
