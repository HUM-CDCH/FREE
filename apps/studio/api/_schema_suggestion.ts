import type { DocumentInput } from './_document.js'
import { documentFileParts } from './_pdf.js'
import { schemaPrompt, schemaSourceExcerpts } from './_schema.js'
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

async function suggestSchema(
  caller: ModelCaller,
  input: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<SchemaSuggested> {
  const resolved = await resolveModelTarget('schema-suggestion', input.temperature, target, caller, dependencies)
  return suggestOnRoute(resolved, input, dependencies)
}

/** One Schema Suggestion request on a resolved route: a new schema, or with `edit` the revised one. A chat message's
 *  intent is read before it (`classifyChatMessage`), so this request only ever returns a schema. */
export async function suggestOnRoute(
  resolved: ExecutionTarget,
  { document, instruction, edit, window, temperature, signal }: SchemaModelInput,
  dependencies: ModelDependencies = {},
): Promise<SchemaSuggested> {
  const excerpts = document.markdown && !window ? schemaSourceExcerpts(document.markdown, document.pageSpans) : null
  const documentParts = await documentContentParts({ ...document, markdown: excerpts ? excerpts.text : document.markdown })
  const generated = await executeSchemaSuggestion(resolved, {
    instructions: edit
      ? 'Revise the researcher\'s extraction schema. Return only one JSON object, with no Markdown or commentary: the complete compact schema in "template" and scalar field note edits in "fieldDescriptions", with no extracted values.'
      : 'Propose a compact extraction schema grounded in the supplied source document. ' +
        'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
    guidance: edit ? schemaEditPrompt(instruction) : schemaPrompt(instruction),
    documentParts: documentParts.parts,
    temperature,
    signal,
  }, dependencies.fetch)
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

/** The answer of a reply that is only `{"answer": "<text>"}`, its null members aside (models often name the replies they
 *  did not give as null); null for any other reply. */
export async function answerOf(response: string): Promise<string | null> {
  let parsed: unknown
  try {
    parsed = await parseUnknownJson(response, 'Model returned invalid JSON.')
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const reply = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== null))
  if (Object.keys(reply).length !== 1 || typeof reply.answer !== 'string') return null
  return reply.answer.trim() || null
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
