import {
  NoObjectGeneratedError,
  Output,
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  streamText,
  toUIMessageStream,
} from 'ai'
import type { UIMessage } from 'ai'
import { z } from 'zod'
import type { Annotation, AnnotationMode, DocumentInput } from './_document.js'
import { documentFileParts, type DocumentFilePart } from './_pdf.js'
import { schemaPrompt } from './_schema.js'
import {
  ApiError,
  asModelOperationError,
  boundedUpstreamDetail,
} from './_http.js'
import { applyAllowedValues } from '../shared/allowedValues.js'
import { splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template.js'
import { parseExtractionResult, parseTemplate, parseUnknownJson } from './_model_output.js'
import { readModelConfig } from './_model_config.js'
import { inspectHttpExchange, inspectTarget } from './_llm_inspector.js'
import {
  appendProviderResource,
  resolveCapabilityRoute,
  type ExecutionTarget,
  type GeneralExecutionTarget,
  type ModelOperation,
  type NuExtractRawExecutionTarget,
  type RouteResolverDependencies,
} from './_provider.js'

export { parseAnnotationMode, parseAnnotations, parseDocument } from './_document.js'
export { json, parseTemperature, type FormValue } from './_http.js'

const IMAGE_PLACEHOLDER = '<|vision_start|><|image_pad|><|vision_end|>'
const NON_THINKING_TEMPERATURE = 0.2
const EVIDENCE_FIELD_INSTRUCTION =
  'Each object in the template carries an "_evidence" object keyed by that same object\'s field names. ' +
  'For every key listed there, set "snippet" to a short verbatim excerpt from the document containing that field\'s value, ' +
  'and set "page" to the 1-based index of the page or image where it appears. ' +
  'Do not add "_evidence" keys the template does not list, and do not nest values inside "_evidence".'

export type ExtractModelInput = {
  readonly document: DocumentInput
  readonly template: unknown
  readonly instruction?: string
  readonly temperature?: number
}

export type SchemaModelInput = {
  readonly document: DocumentInput
  readonly annotations: readonly Annotation[]
  readonly annotationsMode: AnnotationMode
  readonly temperature?: number
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

export async function extractWithModel(
  { document, template, instruction, temperature }: ExtractModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{
  readonly result: Record<string, unknown>
  readonly evidence: Record<string, unknown> | null
  readonly raw: string
  readonly reasoning: null
  readonly pages: number | null
}> {
  const resolved = await operationTarget('extraction', temperature, target, dependencies)
  const documentParts = await documentContentParts(document)
  const extractionTemplate = template ?? {}
  const evidenceTemplate = wrapTemplateWithEvidence(extractionTemplate)
  const callerInstruction = instruction?.trim()
  const instructions = callerInstruction
    ? `${EVIDENCE_FIELD_INSTRUCTION}\n\n${callerInstruction}`
    : EVIDENCE_FIELD_INSTRUCTION
  let generated: { readonly response: string; readonly doneReason?: string | null }
  let parsed: Record<string, unknown>
  let resultTemplate = evidenceTemplate
  let expectsEvidence = true
  if (resolved.profile === 'general') {
    const request = [
      'Extract information from the Source Document using this Extraction Schema:',
      JSON.stringify(evidenceTemplate, null, 2),
      `Additional extraction instruction:\n${instructions}`,
    ].join('\n\n')
    generated = await generateWithGenericJsonPrompt(resolved, {
      instructions:
        'Produce a source-grounded FREE Extraction Result. Follow the supplied Extraction Schema exactly. ' +
        'Each schema leaf is an evidence object with value, an exact source snippet, and a page number when available. ' +
        'Return only one JSON object with no Markdown or commentary.',
      request,
      documentParts: documentParts.parts,
      temperature,
    })
    parsed = await parseExtractionResult(generated.response, evidenceTemplate)
  } else {
    generated = await generateWithNuExtractRawPrompt('extraction', resolved, {
      mode: 'structured',
      template: JSON.stringify(evidenceTemplate, null, 2),
      instructions,
      documentParts: documentParts.parts,
      temperature,
    }, dependencies.fetch)
    try {
      if (generated.doneReason === 'length') {
        throw new ApiError(502, 'invalid_model_output', 'Model stopped before completing the Extraction Result.')
      }
      parsed = await parseExtractionResult(generated.response, evidenceTemplate)
    } catch (error) {
      if (!(error instanceof ApiError && error.code === 'invalid_model_output')) throw error
      generated = await generateWithNuExtractRawPrompt('extraction', resolved, {
        mode: 'structured',
        template: JSON.stringify(extractionTemplate, null, 2),
        instructions: callerInstruction || null,
        documentParts: documentParts.parts,
        temperature,
      }, dependencies.fetch)
      if (generated.doneReason === 'length') {
        throw new ApiError(502, 'invalid_model_output', 'Model stopped before completing the Extraction Result.')
      }
      parsed = await parseExtractionResult(generated.response, extractionTemplate)
      resultTemplate = extractionTemplate
      expectsEvidence = false
    }
  }
  // Before the split, so a one-item array answer is unwrapped while the evidence
  // leaf still mirrors it — `buildHighlights` only follows a string value.
  const normalized = applyAllowedValues(parsed, resultTemplate)
  const split = expectsEvidence
    ? splitEvidenceResult(normalized)
    : { result: normalized, evidence: null }

  return {
    result: split.result,
    evidence: split.evidence,
    raw: generated.response,
    reasoning: null,
    pages: documentParts.pages ?? document.pages,
  }
}

export async function generateSchemaWithModel(
  { document, annotations, annotationsMode, temperature }: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{
  readonly template: Record<string, unknown>
  readonly raw: string
  readonly pages: number | null
}> {
  const resolved = await operationTarget('schema-suggestion', temperature, target, dependencies)
  const documentParts = await documentContentParts(document)
  const guidance = schemaPrompt(annotations, annotationsMode)
  const generated =
    resolved.profile === 'general'
      ? await generateWithGenericJsonPrompt(resolved, {
          instructions:
            'Propose a compact FREE Extraction Schema grounded in the supplied Source Document. ' +
            'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
          request: guidance,
          documentParts: documentParts.parts,
          temperature,
        })
      : await generateWithNuExtractRawPrompt('schema-suggestion', resolved, {
          mode: 'template-generation',
          instructions: null,
          documentParts: [{ type: 'text', text: guidance }, ...documentParts.parts],
          temperature,
        }, dependencies.fetch)
  const parsed = await parseTemplate(generated.response)
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
  },
): Promise<{ readonly response: string }> {
  try {
    const generated = await generateText({
      model: target.model,
      ...(target.jsonOutput === 'native' ? { output: Output.json() } : {}),
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
      ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    })
    return { response: generated.text }
  } catch (error) {
    if (target.jsonOutput === 'native' && NoObjectGeneratedError.isInstance(error) && error.message) {
      return { response: error.message }
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
  },
  requestFetch: typeof fetch = fetch,
): Promise<{ readonly response: string; readonly doneReason: string | null }> {
  const rendered = renderNuExtractPrompt(input)
  const url = appendProviderResource(target.baseUrl, 'api/generate')
  const requestBody = JSON.stringify({
    model: target.modelId,
    prompt: rendered.prompt,
    images: rendered.images.length > 0 ? rendered.images : undefined,
    raw: true,
    stream: false,
    options: { temperature: input.temperature ?? NON_THINKING_TEMPERATURE },
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
      }),
    )
  } catch (error) {
    throw asModelOperationError(error, 'Ollama generation failed.')
  }

  const bodyText = await response.text()
  if (!response.ok) {
    throw new ApiError(502, 'model_operation_failed', 'Ollama generation failed.', {
      details: { upstream: boundedUpstreamDetail(response.status, bodyText) },
    })
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
  return { response: parsed.data.response, doneReason: parsed.data.done_reason ?? null }
}

const ollamaGenerateResponseSchema = z.object({
  response: z.string(),
  done_reason: z.string().optional(),
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

export type EditSchemaOp =
  | { op: 'add'; name: string; type: string; parentName?: string }
  | { op: 'remove'; name: string; parentName?: string }
  | { op: 'patch'; name: string; newName?: string; type?: string; parentName?: string }

const editSchemaOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), name: z.string(), type: z.string(), parentName: z.string().optional() }),
  z.object({ op: z.literal('remove'), name: z.string(), parentName: z.string().optional() }),
  z.object({
    op: z.literal('patch'),
    name: z.string(),
    newName: z.string().optional(),
    type: z.string().optional(),
    parentName: z.string().optional(),
  }),
])

export async function editSchemaWithModel(
  currentTemplate: unknown,
  instruction: string,
  documentMarkdown: string | null,
  temperature?: number,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<EditSchemaOp[]> {
  const resolved = await operationTarget('schema-edit', temperature, target, dependencies)
  if (resolved.profile !== 'general') {
    throw new ApiError(409, 'invalid_model_config', 'The Interaction Route must use general execution.')
  }
  const sourceContext =
    documentMarkdown === null
      ? ''
      : `\n\nSource Document Markdown:\n${documentMarkdown}\nEnd Source Document Markdown`
  const prompt = `You are a schema editing assistant for humanities researchers.

Current extraction schema (JSON):
${JSON.stringify(currentTemplate, null, 2)}${sourceContext}

Researcher instruction: "${instruction}"

Return ONLY a JSON array of operations. No explanation, no markdown fences, no extra text.
Each operation must be one of:
  {"op":"add","name":"fieldName","type":"string|number|boolean|object|array","parentName":"optionalParent"}
  {"op":"remove","name":"fieldName","parentName":"optionalParent"}
  {"op":"patch","name":"fieldName","newName":"optionalNewName","type":"optionalNewType","parentName":"optionalParent"}

Rules:
- Only change what the researcher explicitly asked for
- Use parentName when the same field name exists at multiple nesting levels
- Omit parentName when the field is uniquely named
- Return [] if no changes are needed`

  let text: string
  try {
    const result = await generateText({
      model: resolved.model,
      messages: [{ role: 'user', content: prompt }],
      ...(temperature === undefined ? {} : { temperature }),
    })
    text = result.text.replace(/```(?:json)?|```/g, '').trim()
  } catch (error) {
    throw asModelOperationError(error)
  }
  const parsed = await parseUnknownJson(text, 'Edit schema model returned invalid JSON.')
  if (!Array.isArray(parsed)) return []

  const ops: EditSchemaOp[] = []
  for (const item of parsed) {
    const validated = editSchemaOpSchema.safeParse(item)
    if (validated.success) ops.push(validated.data)
  }
  return ops
}
