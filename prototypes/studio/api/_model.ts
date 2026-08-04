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
import { ApiError, asModelOperationError, boundedUpstreamDetail } from './_http.js'
import { attachEvidenceSourceScope, splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template.js'
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
import {
  findPrimaryArrayKey,
  getExtractionStrategy,
  isEmptyResult,
  offsetPageNumbers,
  pageForOffset,
  pageRangeForOffsets,
  sectionContainsTable,
  splitMarkdownByHeadings,
  type ExtractionStrategy,
  type MarkdownSection,
} from './_catalog_sections.js'

export { parseAnnotationMode, parseAnnotations, parseDocument } from './_document.js'
export { json, parseTemperature, type FormValue } from './_http.js'
export type { ExtractionStrategy } from './_catalog_sections.js'

const IMAGE_PLACEHOLDER = '<|vision_start|><|image_pad|><|vision_end|>'
const NON_THINKING_TEMPERATURE = 0.2
// Sections run concurrently rather than the historical Catalog pipeline's
// sequential per-record loop, capped since a local Ollama instance mostly
// serializes GPU work anyway.
const MAX_CONCURRENT_SECTION_CALLS = 7

const EVIDENCE_FIELD_INSTRUCTION =
  'Each object in the template carries an "_evidence" object keyed by that same object\'s field names. ' +
  'For every key listed there, set "snippet" to a short verbatim excerpt from the document containing that field\'s value, ' +
  'and set "page" to the 1-based index of the page or image where it appears. ' +
  'Do not add "_evidence" keys the template does not list, and do not nest values inside "_evidence". ' +
  'A "_description" next to a field in the template is a mandatory researcher-authored rule for that field and everything nested under it. Follow it exactly, even where it narrows or overrides what the field\'s name alone would suggest. ' +
  'Use the field names given in the template exactly as spelled, character for character, in your output.'

const TABLE_EVIDENCE_FIELD_INSTRUCTION =
  'The Source Document contains one or more tables. For every evidence field, always include "row_header" and "column_header". ' +
  'When the value comes from a table cell, set "row_header" to that row\'s identifying label and "column_header" to that column\'s header text. ' +
  'When the value does not come from a table cell, set "row_header" and "column_header" to empty strings.'

export type ExtractModelInput = {
  readonly document: DocumentInput
  readonly template: unknown
  readonly instruction?: string
  readonly temperature?: number
  readonly hasTables?: boolean
}

export type SchemaModelInput = {
  readonly document: DocumentInput
  readonly annotations: readonly Annotation[]
  readonly annotationsMode: AnnotationMode
  readonly strategy?: ExtractionStrategy
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
  { document, template, instruction, temperature, hasTables }: ExtractModelInput,
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
  const callerInstruction = instruction?.trim()
  // Table-awareness is decided per-section below. The base instruction stays
  // table-neutral so each catalog section can add table evidence only when its
  // own body actually contains a table.
  const baseInstructions = callerInstruction
    ? `${EVIDENCE_FIELD_INSTRUCTION}\n\n${callerInstruction}`
    : EVIDENCE_FIELD_INSTRUCTION

  const strategy = getExtractionStrategy(template)
  const arrayKey = strategy === 'catalog' && document.markdown ? findPrimaryArrayKey(template) : null
  const sections = arrayKey && document.markdown ? splitMarkdownByHeadings(document.markdown) : []

  if (arrayKey && sections.length >= 2) {
    const markdown = document.markdown
    if (!markdown) {
      throw new ApiError(400, 'invalid_request', 'Catalog section extraction requires document Markdown.')
    }
    const templateRecord = template as Record<string, unknown>
    const itemTemplate = (templateRecord[arrayKey] as readonly unknown[])[0] as Record<string, unknown>
    const templateDescription =
      typeof templateRecord._description === 'string' ? templateRecord._description : null
    const sectioned = await runSectionedExtraction({
      arrayKey,
      itemTemplate,
      sections,
      fullMarkdown: markdown,
      baseInstructions: templateDescription ? `${templateDescription}\n\n${baseInstructions}` : baseInstructions,
      target: resolved,
      dependencies,
      temperature,
    })
    return {
      result: sectioned.result,
      evidence: sectioned.evidence,
      raw: sectioned.raw,
      reasoning: null,
      pages: documentParts.pages ?? document.pages,
    }
  }

  const evidenceFieldInstruction = hasTables
    ? `${EVIDENCE_FIELD_INSTRUCTION}\n\n${TABLE_EVIDENCE_FIELD_INSTRUCTION}`
    : EVIDENCE_FIELD_INSTRUCTION
  const instructions = callerInstruction
    ? `${evidenceFieldInstruction}\n\n${callerInstruction}`
    : evidenceFieldInstruction
  const evidenceTemplate = wrapTemplateWithEvidence(template ?? {}, hasTables ?? false)
  const generated = await runExtractionCall({
    evidenceTemplate,
    instructions,
    documentParts: documentParts.parts,
    target: resolved,
    dependencies,
    temperature,
  })
  const parsed = await parseExtractionResult(generated.response, evidenceTemplate)
  const split = splitEvidenceResult(parsed)
  const evidence =
    split.evidence && document.markdown
      ? attachEvidenceSourceScope(split.evidence, {
          segment_id: 'article:0',
          markdown_start: 0,
          markdown_end: document.markdown.length,
          start_page: pageRangeForOffsets(document.markdown, 0, document.markdown.length).startPage,
          end_page: pageRangeForOffsets(document.markdown, 0, document.markdown.length).endPage,
        }) as Record<string, unknown>
      : split.evidence

  return {
    result: split.result,
    evidence,
    raw: generated.response,
    reasoning: null,
    pages: documentParts.pages ?? document.pages,
  }
}

async function runExtractionCall({
  evidenceTemplate,
  instructions,
  documentParts,
  target,
  dependencies,
  temperature,
}: {
  readonly evidenceTemplate: unknown
  readonly instructions: string
  readonly documentParts: readonly DocumentContentPart[]
  readonly target: ExecutionTarget
  readonly dependencies: ModelDependencies
  readonly temperature?: number
}): Promise<{ readonly response: string }> {
  if (target.profile === 'general') {
    const request = [
      'Extract information from the Source Document using this Extraction Schema:',
      JSON.stringify(evidenceTemplate, null, 2),
      instructions ? `Additional extraction instruction:\n${instructions}` : null,
    ]
      .filter((value) => value !== null)
      .join('\n\n')
    return generateWithGenericJsonPrompt(target, {
      instructions:
        'Produce a source-grounded FREE Extraction Result. Follow the supplied Extraction Schema exactly. ' +
        'Return extracted values in the schema fields and put evidence snippets/pages only in the "_evidence" objects. ' +
        'Return only one JSON object with no Markdown or commentary.',
      request,
      documentParts,
      temperature,
    })
  }

  return generateWithNuExtractRawPrompt('extraction', target, {
    mode: 'structured',
    template: JSON.stringify(evidenceTemplate, null, 2),
    instructions,
    documentParts,
    temperature,
  }, dependencies.fetch)
}

async function runSectionedExtraction({
  arrayKey,
  itemTemplate,
  sections,
  fullMarkdown,
  baseInstructions,
  target,
  dependencies,
  temperature,
}: {
  readonly arrayKey: string
  readonly itemTemplate: Record<string, unknown>
  readonly sections: readonly MarkdownSection[]
  readonly fullMarkdown: string
  readonly baseInstructions: string
  readonly target: ExecutionTarget
  readonly dependencies: ModelDependencies
  readonly temperature?: number
}): Promise<{
  readonly result: Record<string, unknown>
  readonly evidence: Record<string, unknown> | null
  readonly raw: string
}> {
  const perSection = await runWithConcurrencyLimit(
    sections.map((section, sectionIndex) => async () => {
      const sectionHasTables = sectionContainsTable(section.body)
      const itemEvidenceTemplate = wrapTemplateWithEvidence(itemTemplate, sectionHasTables)
      const sectionInstructions = sectionHasTables
        ? `${baseInstructions}\n\n${TABLE_EVIDENCE_FIELD_INSTRUCTION}`
        : baseInstructions
      const generated = await runExtractionCall({
        evidenceTemplate: itemEvidenceTemplate,
        instructions: sectionInstructions,
        documentParts: [{ type: 'text', text: section.body }],
        target,
        dependencies,
        temperature,
      })
      const parsed = await parseExtractionResult(generated.response, itemEvidenceTemplate)
      const split = splitEvidenceResult(parsed)
      const pageOffset = pageForOffset(fullMarkdown, section.startOffset) - 1
      const pageRange = pageRangeForOffsets(fullMarkdown, section.startOffset, section.endOffset)
      return {
        result: split.result,
        evidence: split.evidence
          ? (attachEvidenceSourceScope(
              offsetPageNumbers(split.evidence, pageOffset),
              {
                segment_id: `catalog:${sectionIndex}`,
                markdown_start: section.startOffset,
                markdown_end: section.endOffset,
                start_page: pageRange.startPage,
                end_page: pageRange.endPage,
              },
            ) as Record<string, unknown>)
          : null,
        raw: generated.response,
      }
    }),
    MAX_CONCURRENT_SECTION_CALLS,
  )

  const kept = perSection.filter((item) => !isEmptyResult(item.result))
  const hasAnyEvidence = kept.some((item) => item.evidence !== null)

  return {
    result: { [arrayKey]: kept.map((item) => item.result) },
    evidence: hasAnyEvidence ? { [arrayKey]: kept.map((item) => item.evidence) } : null,
    raw: perSection.map((item) => item.raw).join('\n\n'),
  }
}

// In "fields" mode the annotations ARE the document the model gets to see.
function annotationOnlyParts(annotations: readonly Annotation[]): readonly DocumentContentPart[] {
  return annotations.map((annotation) => ({
    type: 'text',
    text: `Page ${annotation.pageNumber}: ${annotation.text}`,
  }))
}

export async function generateSchemaWithModel(
  { document, annotations, annotationsMode, strategy, temperature }: SchemaModelInput,
  target?: ExecutionTarget,
  dependencies: ModelDependencies = {},
): Promise<{
  readonly template: Record<string, unknown>
  readonly raw: string
  readonly pages: number | null
}> {
  const resolved = await operationTarget('schema-suggestion', temperature, target, dependencies)
  const documentParts = await documentContentParts(document)
  const guidance = schemaPrompt(annotations, annotationsMode, strategy)
  const schemaDocumentParts: readonly DocumentContentPart[] =
    annotationsMode === 'fields' && annotations.length > 0
      ? annotationOnlyParts(annotations)
      : documentParts.parts
  const generated =
    resolved.profile === 'general'
      ? await generateWithGenericJsonPrompt(resolved, {
          instructions:
            'Propose a compact FREE Extraction Schema grounded in the supplied Source Document. ' +
            'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
          request: guidance,
          documentParts: schemaDocumentParts,
          temperature,
        })
      : await generateWithNuExtractRawPrompt('schema-suggestion', resolved, {
          mode: 'template-generation',
          instructions: null,
          documentParts: [{ type: 'text', text: guidance }, ...schemaDocumentParts],
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
    const maybeText = typeof error === 'object' && error !== null ? (error as { text?: unknown }).text : undefined
    if (target.jsonOutput === 'native' && NoObjectGeneratedError.isInstance(error) && typeof maybeText === 'string') {
      return { response: maybeText }
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
): Promise<{ readonly response: string }> {
  const rendered = renderNuExtractPrompt(input)
  const url = appendProviderResource(target.baseUrl, 'api/generate')
  const requestBody = JSON.stringify({
    model: target.modelId,
    prompt: rendered.prompt,
    images: rendered.images.length > 0 ? rendered.images : undefined,
    raw: true,
    stream: false,
    options: { temperature: input.temperature ?? NON_THINKING_TEMPERATURE, num_ctx: 131072 },
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
  return { response: parsed.data.response }
}

const ollamaGenerateResponseSchema = z.object({ response: z.string() })

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

type FlatField = { readonly path: string; readonly type: string }

function flattenTemplateFields(value: unknown, path: readonly string[] = []): FlatField[] {
  if (path.length === 0) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        flattenTemplateFields(child, [key]),
      )
    }
    return []
  }

  if (Array.isArray(value)) {
    const first = value[0]
    const children =
      first !== null && typeof first === 'object' && !Array.isArray(first)
        ? Object.entries(first as Record<string, unknown>).flatMap(([key, child]) =>
            flattenTemplateFields(child, [...path, key]),
          )
        : []
    return [{ path: path.join('.'), type: 'array' }, ...children]
  }

  if (value !== null && typeof value === 'object') {
    return [
      { path: path.join('.'), type: 'object' },
      ...Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
        flattenTemplateFields(child, [...path, key]),
      ),
    ]
  }

  return [{ path: path.join('.'), type: String(value) }]
}

async function runWithConcurrencyLimit<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next++
      if (i >= tasks.length) return
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker))
  return results
}

const MAX_CONCURRENT_FIELD_CALLS = 6
const FIELD_EDIT_ATTEMPTS = 2

type FieldEditResult = { name: string; type: string; removed: boolean }

const fieldEditResultSchema = z.object({
  name: z.string(),
  type: z.string(),
  removed: z.boolean(),
})

function fieldName(path: string): string {
  return path.split('.').at(-1) ?? path
}

function fieldParentName(path: string): string | undefined {
  const segments = path.split('.')
  return segments.length > 1 ? segments.at(-2) : undefined
}

async function editOneField(
  field: FlatField,
  instruction: string,
  target: GeneralExecutionTarget,
  temperature?: number,
): Promise<FieldEditResult> {
  const prompt = `You are a schema editing assistant for humanities researchers.

Researcher instruction: "${instruction}"

Field: "${field.path}" - current name "${fieldName(field.path)}", current type "${field.type}".

Decide this field's result after applying the instruction. When researcher asks to delete or add a field, make sure the field name follows the instruction exactly. If the instruction is irrelevant to this field, echo its current name and current type unchanged and set "removed" to false. If the instruction says to delete this field, set "removed" to true.`

  let lastError: unknown
  for (let attempt = 0; attempt < FIELD_EDIT_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model: target.model,
        output: Output.object({ schema: fieldEditResultSchema }),
        messages: [{ role: 'user', content: prompt }],
        ...(temperature === undefined ? {} : { temperature }),
      })
      const validated = fieldEditResultSchema.safeParse(result.output)
      if (validated.success) {
        return validated.data
      }
      lastError = validated.error
    } catch (error) {
      lastError = error
    }
  }
  throw new ApiError(
    502,
    'model_operation_failed',
    `Schema edit model returned an invalid result for field "${field.path}".`,
    { cause: lastError },
  )
}

async function editNewFields(
  currentTemplate: unknown,
  instruction: string,
  sourceContext: string,
  target: GeneralExecutionTarget,
  temperature?: number,
): Promise<EditSchemaOp[]> {
  const prompt = `You are a schema editing assistant for humanities researchers.

Current extraction schema (JSON):
${JSON.stringify(currentTemplate, null, 2)}${sourceContext}

Researcher instruction: "${instruction}"

Return ONLY a JSON array of "add" operations for any entirely new field the instruction requests. Existing fields are handled separately - do not include operations for them. No explanation, no markdown fences, no extra text.
Each operation must look like:
  {"op":"add","name":"fieldName","type":"string|number|boolean|object|array","parentName":"optionalParent"}

Rules:
- Only add fields the researcher explicitly asked for
- Omit parentName to add at the top level
- Return [] if no new fields are needed`

  let text: string
  try {
    const result = await generateText({
      model: target.model,
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
    if (validated.success && validated.data.op === 'add') {
      ops.push(validated.data)
    }
  }
  return ops
}

export async function editSchemaWithModel(
  currentTemplate: unknown,
  instruction: string,
  documentMarkdown: string | null = null,
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
  const fields = flattenTemplateFields(currentTemplate)

  const [fieldResults, additionOps] = await Promise.all([
    runWithConcurrencyLimit(
      fields.map((field) => () => editOneField(field, instruction, resolved, temperature)),
      MAX_CONCURRENT_FIELD_CALLS,
    ),
    editNewFields(currentTemplate, instruction, sourceContext, resolved, temperature),
  ])

  const fieldOps: Array<{ readonly depth: number; readonly op: EditSchemaOp }> = []
  fields.forEach((field, i) => {
    const edited = fieldResults[i]
    const name = fieldName(field.path)
    const parentName = fieldParentName(field.path)
    const depth = field.path.split('.').length

    if (edited.removed) {
      fieldOps.push({ depth, op: { op: 'remove', name, parentName } })
      return
    }

    const nameChanged = edited.name !== name
    const typeChanged = edited.type !== field.type
    if (nameChanged || typeChanged) {
      fieldOps.push({
        depth,
        op: {
          op: 'patch',
          name,
          parentName,
          ...(nameChanged ? { newName: edited.name } : {}),
          ...(typeChanged ? { type: edited.type } : {}),
        },
      })
    }
  })

  fieldOps.sort((a, b) => b.depth - a.depth)

  const ops: EditSchemaOp[] = fieldOps.map((f) => f.op)
  ops.push(...additionOps)
  return ops
}
