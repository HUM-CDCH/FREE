import {
  NoObjectGeneratedError,
  Output,
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from 'ai'
import { z } from 'zod'
import type { DocumentInput } from './_document.js'
import { documentFileParts, type DocumentFilePart } from './_pdf.js'
import { schemaPrompt } from './_schema.js'
import {
  ApiError,
  asModelOperationError,
} from './_http.js'
import { applyAllowedValues } from 'extraction/allowed-values'
import { isRecord, schemaNodesToZod, templateToNodes } from 'extraction/schema'
import { parseExtractionResult, parseTemplate } from './_model_output.js'
import { readModelConfig } from './_model_config.js'
import { inspectHttpExchange, inspectTarget } from './_llm_inspector.js'
import {
  appendProviderResource,
  resolveCapabilityRoute,
  type ExecutionTarget,
  type GeneralExecutionTarget,
  type ModelAttribution,
  type ModelOperation,
  type NuExtractRawExecutionTarget,
  type RouteResolverDependencies,
} from './_provider.js'

export { parseInstruction, parseDocument } from './_document.js'
export { json, parseTemperature, type FormValue } from './_http.js'

const IMAGE_PLACEHOLDER = '<|vision_start|><|image_pad|><|vision_end|>'
const NON_THINKING_TEMPERATURE = 0.2
const EXTRACTION_SCOPE_GUARDRAIL =
  'Only extract fields defined in the Extraction Schema above. Do not invent, infer, or include any field, key, or record that is not present in the schema.'
export type ExtractModelInput = {
  readonly document: DocumentInput
  readonly template: unknown
  readonly instruction?: string
  readonly temperature?: number
  readonly signal?: AbortSignal
}

export type ModelGenerationMetadata = {
  readonly finishReason: string | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly durationMs: number
}

const generationMetadataByError = new WeakMap<object, ModelGenerationMetadata>()

export function modelGenerationMetadata(
  error: unknown,
): ModelGenerationMetadata | null {
  return typeof error === 'object' && error !== null
    ? generationMetadataByError.get(error) ?? null
    : null
}

type GeneratedText = {
  readonly response: string
  readonly metadata: ModelGenerationMetadata
}

export type SchemaModelInput = {
  readonly document: DocumentInput
  readonly instruction: string
  readonly temperature?: number
  readonly signal?: AbortSignal
}

type DocumentContentPart = DocumentFilePart | { readonly type: 'text'; readonly text: string }
type NuExtractMode = 'structured' | 'template-generation' | 'content' | 'markdown'
type ModelDependencies = RouteResolverDependencies & { fetch?: typeof fetch }

async function documentContentParts(document: DocumentInput): Promise<{
  readonly parts: readonly DocumentContentPart[]
  readonly pages: number | null
}> {
  if (document.markdown) {
    return {
      parts: [{ type: 'text', text: document.markdown }],
      pages: document.pages,
    }
  }
  if (!document.file) {
    throw new ApiError(400, 'invalid_request', "No document content: provide a 'file' or 'document_markdown'")
  }
  const fileParts = await documentFileParts(document.file)
  return { parts: fileParts.parts, pages: fileParts.pages }
}

async function operationTarget(
  operation: ModelOperation,
  temperature: number | undefined,
  target: ExecutionTarget | undefined,
  dependencies: ModelDependencies,
): Promise<ExecutionTarget> {
  const resolved = target ?? await resolveCapabilityRoute(operation, { temperature }, {
    ...dependencies,
    readConfig: dependencies.readConfig ?? (() => readModelConfig()),
  })
  return inspectTarget(operation, resolved)
}

export async function streamChatWithModel(
  messages: readonly UIMessage[],
  documentMarkdown: string,
  temperature?: number,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<Response> {
  const resolved = await operationTarget('chat', temperature, target, dependencies)
  if (resolved.profile !== 'general') {
    throw new ApiError(409, 'invalid_model_config', 'The Interaction Route must use general execution.')
  }
  try {
    const result = streamText({
      model: resolved.model,
      system:
        'You help humanities researchers inspect source documents in FREE. Use the canonical Source Document Markdown below as the document context.\n\n' +
        `SOURCE DOCUMENT MARKDOWN:\n${documentMarkdown}\nEND SOURCE DOCUMENT MARKDOWN`,
      messages: await convertToModelMessages([...messages]),
      ...(temperature === undefined ? {} : { temperature }),
    })
    return createUIMessageStreamResponse({
      stream: toUIMessageStream({
        stream: result.stream,
        onError: () => 'Chat failed.',
      }),
    })
  } catch (error) {
    throw asModelOperationError(error, 'Chat failed before streaming began.')
  }
}

/**
 * `templateToNodes` degrades a non-record template to zero nodes rather than
 * throwing, which would otherwise derive a spuriously empty `.strict()`
 * schema that rejects every field. Guard on the input actually being a
 * record so an unconvertible template shape falls back to unconstrained
 * generation instead of over-constraining it.
 */
function deriveExtractionSchema(template: unknown): z.ZodType | undefined {
  if (!isRecord(template)) return undefined
  try {
    return schemaNodesToZod(templateToNodes(template))
  } catch {
    return undefined
  }
}

export async function extractWithModel(
  { document, template, instruction, temperature, signal }: ExtractModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{
  readonly result: Record<string, unknown>
  readonly reasoning: null
  readonly pages: number | null
  readonly modelAttribution: ModelAttribution | null
  readonly metadata: ModelGenerationMetadata
}> {
  const resolved = await operationTarget('extraction', temperature, target, dependencies)
  const documentParts = await documentContentParts(document)
  const extractionTemplate = template ?? {}
  const callerInstruction = instruction?.trim()
  let generated: GeneratedText
  if (resolved.profile === 'general') {
    const request = [
      'Extract information from the Source Document using this Extraction Schema:',
      JSON.stringify(extractionTemplate, null, 2),
      ...(callerInstruction
        ? [`Additional extraction instruction:\n${callerInstruction}`]
        : []),
    ].join('\n\n')
    const schema = deriveExtractionSchema(extractionTemplate)
    generated = await generateWithGenericJsonPrompt(resolved, {
      instructions:
        'Produce a FREE Extraction Result. Follow the supplied Extraction Schema exactly. ' +
        'Return only one JSON object with no Markdown or commentary. ' +
        'Keep every repeated item inside its schema array; close the root object only after the final item. ' +
        EXTRACTION_SCOPE_GUARDRAIL,
      request,
      documentParts: documentParts.parts,
      temperature,
      signal,
      schema,
    })
  } else {
    generated = await generateWithNuExtractRawPrompt('extraction', resolved, {
      mode: 'structured',
      template: JSON.stringify(extractionTemplate, null, 2),
      instructions: callerInstruction
        ? `${EXTRACTION_SCOPE_GUARDRAIL}\n\n${callerInstruction}`
        : EXTRACTION_SCOPE_GUARDRAIL,
      documentParts: documentParts.parts,
      temperature,
      signal,
    }, dependencies.fetch)
  }

  let normalized: Record<string, unknown>
  try {
    const parsed = await parseExtractionResult(
      generated.response,
      extractionTemplate,
    )
    normalized = applyAllowedValues(parsed, extractionTemplate)
  } catch (error) {
    if (typeof error === 'object' && error !== null)
      generationMetadataByError.set(error, generated.metadata)
    throw error
  }

  return {
    result: normalized,
    reasoning: null,
    pages: documentParts.pages ?? document.pages,
    modelAttribution: resolved.attribution ?? null,
    metadata: generated.metadata,
  }
}

export async function generateSchemaWithModel(
  { document, instruction, temperature, signal }: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{
  readonly template: Record<string, unknown>
  readonly raw: string
  readonly pages: number | null
}> {
  const resolved = await operationTarget('schema-suggestion', temperature, target, dependencies)
  const documentParts = await documentContentParts(document)
  const guidance = schemaPrompt(instruction)
  const generated =
    resolved.profile === 'general'
      ? await generateWithGenericJsonPrompt(resolved, {
          instructions:
            'Propose a compact FREE Extraction Schema grounded in the supplied Source Document. ' +
            'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
          request: guidance,
          documentParts: documentParts.parts,
          temperature,
          signal,
        })
      : await generateWithNuExtractRawPrompt('schema-suggestion', resolved, {
          mode: 'template-generation',
          instructions: null,
          documentParts: [{ type: 'text', text: guidance }, ...documentParts.parts],
          temperature,
          signal,
        }, dependencies.fetch)
  const parsed = await parseTemplate(generated.response)
  if (
    typeof parsed._description !== 'string' ||
    parsed._description.trim().length === 0
  )
    throw new ApiError(
      502,
      'invalid_model_output',
      'The generated Extraction Schema has no root record description.',
    )
  return {
    template: parsed,
    raw: generated.response,
    pages: documentParts.pages ?? document.pages,
  }
}

async function generateWithGenericJsonPrompt(
  target: GeneralExecutionTarget,
  input: {
    readonly instructions: string
    readonly request: string
    readonly documentParts: readonly DocumentContentPart[]
    readonly temperature?: number
    readonly signal?: AbortSignal
    readonly schema?: z.ZodType
  },
): Promise<GeneratedText> {
  const startedAt = performance.now()
  // A derived schema constrains the model's key set at generation time
  // (native structured output or forced tool-calling, depending on the
  // provider); it supersedes the native/prompt `Output.json()` split, which
  // only guarantees valid JSON syntax, not a specific field set.
  const structuredOutput = input.schema
    ? Output.object({ schema: input.schema })
    : target.jsonOutput === 'native'
      ? Output.json()
      : undefined
  try {
    const generated = await generateText({
      model: target.model,
      ...(structuredOutput ? { output: structuredOutput } : {}),
      instructions: input.instructions,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${input.request}\n\nSOURCE DOCUMENT:\n` },
            ...input.documentParts,
            { type: 'text', text: '\nEND SOURCE DOCUMENT\n\nReturn the JSON object now.' },
          ],
        },
      ],
      reasoning: 'none',
      abortSignal: input.signal,
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    })
    return {
      response: generated.text,
      metadata: {
        finishReason: generated.finishReason ?? null,
        inputTokens: generated.usage?.inputTokens ?? null,
        outputTokens: generated.usage?.outputTokens ?? null,
        durationMs: Math.round(performance.now() - startedAt),
      },
    }
  } catch (error) {
    if (structuredOutput && NoObjectGeneratedError.isInstance(error) && error.text) {
      return {
        response: error.text,
        metadata: {
          finishReason: error.finishReason ?? null,
          inputTokens: error.usage?.inputTokens ?? null,
          outputTokens: error.usage?.outputTokens ?? null,
          durationMs: Math.round(performance.now() - startedAt),
        },
      }
    }
    throw asModelOperationError(error)
  }
}

async function generateWithNuExtractRawPrompt(
  operation: ModelOperation,
  target: NuExtractRawExecutionTarget,
  input: {
    readonly mode: NuExtractMode
    readonly template?: string
    readonly instructions: string | null
    readonly documentParts: readonly DocumentContentPart[]
    readonly temperature?: number
    readonly signal?: AbortSignal
  },
  requestFetch: typeof fetch = fetch,
): Promise<GeneratedText> {
  const startedAt = performance.now()
  const rendered = renderNuExtractPrompt(input)
  const url = appendProviderResource(target.baseUrl, 'api/generate')
  const requestBody = JSON.stringify({
    model: target.modelId,
    prompt: rendered.prompt,
    images: rendered.images.length > 0 ? rendered.images : undefined,
    raw: true,
    stream: false,
    options: {
      temperature: input.temperature ?? NON_THINKING_TEMPERATURE,
      num_ctx: 32768,
      num_predict: 8192,
    },
  })
  let response: Response
  try {
    response = await inspectHttpExchange(
      operation,
      target,
      { url, method: 'POST', body: JSON.parse(requestBody) },
      () => requestFetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(target.authorization === null ? {} : { authorization: target.authorization }),
        },
        body: requestBody,
        signal: input.signal,
      }),
    )
  } catch (error) {
    throw asModelOperationError(error, 'Ollama generation failed.')
  }

  const bodyText = await response.text()
  if (!response.ok) {
    throw new ApiError(502, 'model_operation_failed', 'Ollama generation failed.')
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch (cause) {
    throw new ApiError(502, 'invalid_model_output', 'Ollama returned an invalid generation response.', { cause })
  }
  const parsed = ollamaGenerateResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new ApiError(502, 'invalid_model_output', 'Ollama returned an invalid generation response.', {
      cause: parsed.error,
    })
  }
  return {
    response: parsed.data.response,
    metadata: {
      finishReason: parsed.data.done_reason ?? null,
      inputTokens: parsed.data.prompt_eval_count ?? null,
      outputTokens: parsed.data.eval_count ?? null,
      durationMs:
        parsed.data.total_duration === undefined
          ? Math.round(performance.now() - startedAt)
          : Math.round(parsed.data.total_duration / 1_000_000),
    },
  }
}

const ollamaGenerateResponseSchema = z.object({
  response: z.string(),
  done_reason: z.string().optional(),
  prompt_eval_count: z.number().int().nonnegative().optional(),
  eval_count: z.number().int().nonnegative().optional(),
  total_duration: z.number().int().nonnegative().optional(),
})

export function renderNuExtractPrompt({
  mode,
  template,
  instructions,
  documentParts,
}: {
  readonly mode: NuExtractMode
  readonly template?: string
  readonly instructions: string | null
  readonly documentParts: readonly DocumentContentPart[]
}): { readonly prompt: string; readonly images: readonly string[] } {
  const images: string[] = []
  let prompt = '<|im_start|>user\n'
  prompt += `【task】${mode.replaceAll('-', ' ')}\n`
  if (template) prompt += `【template_start】${template}【template_end】\n`
  if (mode === 'structured' && instructions) {
    prompt += `【instructions_start】${instructions}【instructions_end】\n`
  }
  prompt += '【document_start】\n'
  for (const part of documentParts) {
    if (part.type === 'text') {
      prompt += `${part.text.trim()}\n`
    } else {
      images.push(
        typeof part.data === 'string'
          ? (part.data.split(',', 2)[1] ?? part.data)
          : Buffer.from(part.data).toString('base64'),
      )
      prompt += `${IMAGE_PLACEHOLDER}\n`
    }
  }
  prompt += '【document_end】<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
  return { prompt, images }
}

export async function generateSchemaEditJson(
  prompt: string,
  temperature?: number,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{ text: string }> {
  const resolved = await operationTarget('schema-edit', temperature, target, dependencies)
  if (resolved.profile !== 'general') {
    throw new ApiError(409, 'invalid_model_config', 'The Interaction Route must use general execution.')
  }
  try {
    const result = await generateText({
      model: resolved.model,
      ...(resolved.jsonOutput === 'native' ? { output: Output.json() } : {}),
      reasoning: 'none',
      messages: [{ role: 'user', content: prompt }],
      ...(temperature === undefined ? {} : { temperature }),
    })
    if (result.finishReason === 'length') {
      throw new ApiError(502, 'invalid_model_output', 'Schema edit model output was truncated.')
    }
    return { text: result.text.replace(/```(?:json)?|```/g, '').trim() }
  } catch (error) {
    throw asModelOperationError(error)
  }
}
