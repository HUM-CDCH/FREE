import type { DocumentInput } from './_document.js'
import { documentFileParts } from './_pdf.js'
import { EXCERPT_THRESHOLD, schemaAnswerClause, schemaPrompt, schemaSourceExcerpts } from './_schema.js'
import { ApiError } from './_http.js'
import { parseTemplate, parseUnknownJson } from './_model_output.js'
import { traceModelCall } from '../server/tracing.js'
import { parseSchemaEditOutput, schemaEditPrompt } from './_schema_edit_output.js'
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
  /** An edit may carry scalar note changes beside its compact template, in the same model reply. */
  readonly edit?: true
  /** The Markdown is one window of the source (see `schemaSourceWindows`): send it as it is, never excerpted. */
  readonly window?: boolean
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

type SchemaSuggested = {
  readonly template: Record<string, unknown>
  readonly fieldDescriptions?: unknown
  readonly raw: string
  readonly pages: number | null
  readonly sourceCoverage: SourceCoverage
}

/** A chat message a Schema Suggestion request may answer instead of suggesting a schema (`respondToSchemaEdit`). */
export type SchemaChatMessage = Readonly<{ message: string }>

async function suggestSchema(
  caller: ModelCaller,
  input: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<SchemaSuggested> {
  const resolved = await resolveModelTarget('schema-suggestion', input.temperature, target, caller, dependencies)
  return suggestOrAnswer(resolved, input, null, dependencies) as Promise<SchemaSuggested>
}

/**
 * One Schema Suggestion request on a resolved route. With `chat`, the model may answer the message as a question
 * instead, returning `{"answer": …}`; NuExtract only generates templates, so a NuExtract route never answers.
 */
export async function suggestOrAnswer(
  resolved: ExecutionTarget,
  { document, instruction, edit, window, temperature, signal }: SchemaModelInput,
  chat: SchemaChatMessage | null,
  dependencies: ModelDependencies = {},
): Promise<SchemaSuggested | { readonly answer: string }> {
  const answerable = chat !== null && resolved.profile === 'general'
  const excerpts = document.markdown && !window ? schemaSourceExcerpts(document.markdown, document.pageSpans) : null
  const documentParts = await documentContentParts({ ...document, markdown: excerpts ? excerpts.text : document.markdown })
  const guidance = edit ? schemaEditPrompt(instruction) : schemaPrompt(instruction)
  const generated = await executeSchemaSuggestion(resolved, {
    instructions: edit
      ? 'Revise the researcher\'s extraction schema' + (answerable ? ' or answer their question' : '') + '. ' +
        'Return only one JSON object, with no Markdown or commentary. ' +
        (answerable ? 'For a question, return only {"answer":"<your answer>"}. Otherwise, ' : '') +
        'return the complete compact schema in "template" and scalar field note edits in "fieldDescriptions", with no extracted values.'
      : answerable
      ? 'Propose a compact extraction schema grounded in the supplied source document, or answer the researcher\'s question about it. ' +
        'Return only one JSON object, with no Markdown or commentary.'
      : 'Propose a compact extraction schema grounded in the supplied source document. ' +
        'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
    guidance: answerable ? `${guidance}\n\n${schemaAnswerClause(chat.message)}` : guidance,
    documentParts: documentParts.parts,
    temperature,
    signal,
  }, dependencies.fetch)
  if (answerable) {
    const answer = await answerOf(generated.response)
    if (answer !== null) return { answer }
  }
  const output = edit ? await parseSchemaEditOutput(generated.response) : { template: await parseTemplate(generated.response) }
  const parsed = output.template
  if (typeof parsed._description !== 'string' || parsed._description.trim().length === 0)
    throw new ApiError(502, 'invalid_model_output', 'The generated Extraction Schema has no root record description.')
  return {
    ...output,
    raw: generated.response,
    pages: documentParts.pages ?? document.pages,
    sourceCoverage: excerpts?.sourceCoverage ?? { complete: true },
  }
}

/** The answer of a reply that is exactly `{"answer": "<text>"}`; null for any other reply. */
export async function answerOf(response: string): Promise<string | null> {
  let parsed: unknown
  try {
    parsed = await parseUnknownJson(response, 'Model returned invalid JSON.')
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed)
  const answer = (parsed as Record<string, unknown>).answer
  return keys.length === 1 && typeof answer === 'string' && answer.trim() ? answer.trim() : null
}

const SOURCE_SUGGESTION_INSTRUCTION =
  'Suggest reusable extraction fields for this Source Document. FREE records Evidence and its locations itself, so suggest only fields that describe the content of the researcher\'s records.'
const MERGE_INSTRUCTION =
  'Return one compact Extraction Schema containing only fields present in every supplied Source Document suggestion. Do not include extracted values, alternatives or merge notes; FREE records Evidence and its locations itself, so keep only fields that describe the content of the researcher\'s records.'

const UNION_INSTRUCTION =
  'Return one compact Extraction Schema for one Source Document from the supplied schemas, each suggested from one part of it: keep every field found in any of them, folding fields that name the same thing into one field of one supported shape, and write one _description that defines a complete root record of the whole document. Do not include extracted values, alternatives or merge notes; FREE records Evidence and its locations itself, so keep only fields that describe the content of the researcher\'s records.'

/**
 * One request of `reduceSchemas`: combine labelled schemas already within one request's length into one template —
 * the `union` of one Source Document's window suggestions, or the `intersection` (common fields) of several documents'.
 */
export async function combineSchemas(
  caller: ModelCaller,
  mode: 'union' | 'intersection',
  text: string,
  signal: AbortSignal,
  generate: typeof generateSchemaWithModel = generateSchemaWithModel,
  temperature?: number,
): Promise<Record<string, unknown>> {
  const generated = await generate(caller, {
    document: { file: null, markdown: text, pages: null },
    instruction: mode === 'union' ? UNION_INSTRUCTION : MERGE_INSTRUCTION,
    window: true,
    ...(temperature === undefined ? {} : { temperature }),
    signal,
  })
  return generated.template
}

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
  window = false,
): Promise<{ definition: SchemaDefinition; sourceCoverage: SourceCoverage }> {
  const generated = await generate(caller, {
    document: { file: null, markdown: source.markdown, pageSpans: source.pageSpans, pages: null },
    instruction: SOURCE_SUGGESTION_INSTRUCTION,
    window,
    signal,
  })
  return { definition: modelSuggestedDefinition(generated.template), sourceCoverage: generated.sourceCoverage }
}

/** `combineSchemas` for batch definitions: the combination must be an editable batch definition too. */
export async function combineBatchSchemas(
  caller: ModelCaller,
  mode: 'union' | 'intersection',
  text: string,
  signal: AbortSignal,
  generate: typeof generateSchemaWithModel = generateSchemaWithModel,
): Promise<SchemaDefinition> {
  return modelSuggestedDefinition(await combineSchemas(caller, mode, text, signal, generate))
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
