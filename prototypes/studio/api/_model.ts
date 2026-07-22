import {
  NoObjectGeneratedError,
  Output,
  convertToModelMessages,
  generateText,
  streamText,
} from 'ai'
import type { LanguageModel, UIMessage } from 'ai'
import { createOllama, ollama } from 'ai-sdk-ollama'
import { claudeCode } from 'ai-sdk-provider-claude-code'
import { z } from 'zod'
import type { Annotation, AnnotationMode, DocumentInput } from './_document.js'
import { documentFileParts, type DocumentFilePart } from './_pdf.js'
import { schemaPrompt } from './_schema.js'
import { RequestError } from './_http.js'
import { splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template.js'
import { parseExtractionResult, parseTemplate, parseUnknownJson } from './_model_output.js'
import { extractionRenderer, resolveModel } from './_provider.js'

export { parseAnnotationMode, parseAnnotations, parseDocument } from './_document.js'
export { json, modelError, parseTemperature, RequestError } from './_http.js'

const DEFAULT_MODEL = 'llama3.2'
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
const IMAGE_PLACEHOLDER = '<|vision_start|><|image_pad|><|vision_end|>'
// NuExtract's recommended non-thinking setting for fast, deterministic
// extraction / schema / markdown. We always render the non-thinking prompt
// (an empty <think></think>), so this is the right default; without it Ollama
// applies ~0.8, which produced noisy, instance-leaking templates.
// ponytail: thinking mode (temp 0.6, <think> left open) isn't wired up — add an
// enable_thinking path in renderNuExtractPrompt if difficult layouts need it.
const NON_THINKING_TEMPERATURE = 0.2

const EVIDENCE_FIELD_INSTRUCTION =
  'For every evidence field in the template, set "snippet" to a short verbatim excerpt from the document that contains the value, and set "page" to the 1-based index of the page or image where the value appears. Never leave "snippet" or "page" as null.'

declare const process: {
  env: Record<string, string | undefined>
}

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
type NuExtractMode = 'structured' | 'template-generation' | 'content'

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
    throw new RequestError(400, "No document content: provide a 'file' or 'document_markdown'")
  }
  const fileParts = await documentFileParts(document.file)
  return { parts: fileParts.parts, pages: fileParts.pages }
}

// Separate from resolveModel() (in _provider.ts) so AI_MODEL can stay pointed at NuExtract while
// chat and schema-edit use an instruction-following LLM.
function chatModel(): LanguageModel {
  const modelId = process.env.AI_CHAT_MODEL || DEFAULT_MODEL
  const baseURL = process.env.AI_BASE_URL
  const apiKey = process.env.AI_API_KEY

  if (process.env.AI_PROVIDER === 'claude-code') {
    // Source Documents and extraction instructions are untrusted. Claude Code
    // is used only as a model boundary here, never as a coding/tool agent.
    return claudeCode(modelId, { tools: [], settingSources: [] })
  }

  if (baseURL) {
    return createOllama({ baseURL, apiKey })(modelId)
  }

  if (apiKey) {
    return createOllama({ apiKey })(modelId)
  }

  return ollama(modelId)
}

export async function streamChatWithModel(messages: readonly UIMessage[]): Promise<Response> {
  const result = streamText({
    model: chatModel(),
    system:
      'You help humanities researchers inspect source documents in FREE. If no source document content is attached, say that no document context is available before answering normally.',
    messages: await convertToModelMessages([...messages]),
  })

  return result.toUIMessageStreamResponse({
    onError: () => 'Chat failed.',
  })
}

export async function extractWithModel({ document, template, instruction, temperature }: ExtractModelInput): Promise<{
  readonly result: Record<string, unknown>
  readonly evidence: Record<string, unknown> | null
  readonly raw: string
  readonly reasoning: null
  readonly pages: number | null
}> {
  const documentParts = await documentContentParts(document)
  const evidenceTemplate = wrapTemplateWithEvidence(template ?? {})
  const callerInstruction = instruction?.trim()
  const instructions = callerInstruction
    ? `${EVIDENCE_FIELD_INSTRUCTION}\n\n${callerInstruction}`
    : EVIDENCE_FIELD_INSTRUCTION
  let generated: { readonly response: string }
  if (extractionRenderer() === 'generic') {
    const request = [
      'Extract information from the Source Document using this Extraction Schema:',
      JSON.stringify(evidenceTemplate, null, 2),
      instructions ? `Additional extraction instruction:\n${instructions}` : null,
    ]
      .filter((value) => value !== null)
      .join('\n\n')
    generated = await generateWithGenericJsonPrompt({
      instructions:
        'Produce a source-grounded FREE Extraction Result. Follow the supplied Extraction Schema exactly. ' +
        'Each schema leaf is an evidence object with value, an exact source snippet, and a page number when available. ' +
        'Return only one JSON object with no Markdown or commentary.',
      request,
      documentParts: documentParts.parts,
      temperature,
    })
  } else {
    generated = await generateWithNuExtractRawPrompt({
      mode: 'structured',
      template: JSON.stringify(evidenceTemplate, null, 2),
      instructions,
      documentParts: documentParts.parts,
      temperature,
    })
  }
  const parsed = await parseExtractionResult(generated.response, evidenceTemplate)
  const split = splitEvidenceResult(parsed)

  return {
    result: split.result,
    evidence: split.evidence,
    raw: generated.response,
    reasoning: null,
    pages: documentParts.pages ?? document.pages,
  }
}

export async function generateSchemaWithModel({
  document,
  annotations,
  annotationsMode,
  temperature,
}: SchemaModelInput): Promise<{
  readonly template: Record<string, unknown>
  readonly raw: string
  readonly pages: number | null
}> {
  const documentParts = await documentContentParts(document)
  const guidance = schemaPrompt(annotations, annotationsMode)
  let generated: { readonly response: string }
  if (extractionRenderer() === 'generic') {
    generated = await generateWithGenericJsonPrompt({
      instructions:
        'Propose a compact FREE Extraction Schema grounded in the supplied Source Document. ' +
        'Return only one JSON object containing schema fields and type tokens, with no extracted values, Markdown, or commentary.',
      request: guidance,
      documentParts: documentParts.parts,
      temperature,
    })
  } else {
    generated = await generateWithNuExtractRawPrompt({
      mode: 'template-generation',
      instructions: null,
      documentParts: [{ type: 'text', text: guidance }, ...documentParts.parts],
      temperature,
    })
  }
  const template = await parseTemplate(generated.response)

  return {
    template,
    raw: generated.response,
    pages: documentParts.pages ?? document.pages,
  }
}

async function generateWithGenericJsonPrompt({
  instructions,
  request,
  documentParts,
  temperature,
}: {
  readonly instructions: string
  readonly request: string
  readonly documentParts: readonly DocumentContentPart[]
  readonly temperature?: number
}): Promise<{ readonly response: string }> {
  try {
    const model = resolveModel()
    const generated = await generateText({
      model,
      output: Output.json(),
      instructions,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `${request}\n\nSOURCE DOCUMENT:\n` },
            ...documentParts,
            {
              type: 'text',
              text: '\nEND SOURCE DOCUMENT\n\nReturn the JSON object now.',
            },
          ],
        },
      ],
      // Codex CLI and Claude Code both ignore temperature and warn when the caller supplies one.
      ...(model.provider === 'codex-app-server' || model.provider === 'claude-code' ? {} : { temperature: temperature ?? 0 }),
    })
    return { response: generated.text }
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error) && error.text) {
      return { response: error.text }
    }
    throw error
  }
}

async function generateWithNuExtractRawPrompt({
  mode,
  template,
  instructions,
  documentParts,
  temperature,
}: {
  readonly mode: NuExtractMode
  readonly template?: string
  readonly instructions: string | null
  readonly documentParts: readonly DocumentContentPart[]
  readonly temperature?: number
}): Promise<{ readonly response: string }> {
  const rendered = renderNuExtractPrompt({
    mode,
    template,
    instructions,
    documentParts,
  })
  const response = await fetch(ollamaGenerateUrl(), {
    method: 'POST',
    headers: ollamaHeaders(),
    body: JSON.stringify({
      model: process.env.AI_MODEL || DEFAULT_MODEL,
      prompt: rendered.prompt,
      images: rendered.images.length > 0 ? rendered.images : undefined,
      raw: true,
      stream: false,
      options: { temperature: temperature ?? NON_THINKING_TEMPERATURE },
    }),
  })

  const bodyText = await response.text()
  if (!response.ok) {
    throw new RequestError(response.status, 'Ollama generation failed.', bodyText || null)
  }

  const parsed = ollamaGenerateResponseSchema.safeParse(
    await parseUnknownJson(bodyText, 'Ollama returned invalid JSON.'),
  )
  if (!parsed.success) {
    throw new RequestError(502, 'Ollama returned an unexpected generation response.', bodyText)
  }
  return { response: parsed.data.response }
}

const ollamaGenerateResponseSchema = z.object({
  response: z.string(),
})

function renderNuExtractPrompt({
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
  if (template) {
    prompt += `【template_start】${template}【template_end】\n`
    if (instructions) {
      prompt += `【instructions_start】${instructions}【instructions_end】\n`
    }
  }
  prompt += '【document_start】\n'
  for (const part of documentParts) {
    if (part.type === 'text') {
      prompt += `${part.text.trim()}\n`
    } else {
      images.push(imageData(part))
      prompt += `${IMAGE_PLACEHOLDER}\n`
    }
  }
  prompt += '【document_end】<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'
  return { prompt, images }
}

function imageData(part: DocumentFilePart): string {
  if (typeof part.data === 'string') {
    const [, base64] = part.data.split(',', 2)
    return base64 ?? part.data
  }
  return Buffer.from(part.data).toString('base64')
}

function ollamaGenerateUrl(): string {
  const baseURL = (process.env.AI_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/$/, '')
  return baseURL.endsWith('/api') ? `${baseURL}/generate` : `${baseURL}/api/generate`
}

function ollamaHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  }
  if (process.env.AI_API_KEY) {
    headers.authorization = `Bearer ${process.env.AI_API_KEY}`
  }
  return headers
}

export type EditSchemaOp =
  | { op: 'add'; name: string; type: string; parentName?: string }
  | { op: 'remove'; name: string; parentName?: string }
  | { op: 'patch'; name: string; newName?: string; type?: string; parentName?: string }

const editSchemaOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), name: z.string(), type: z.string(), parentName: z.string().optional() }),
  z.object({ op: z.literal('remove'), name: z.string(), parentName: z.string().optional() }),
  z.object({ op: z.literal('patch'), name: z.string(), newName: z.string().optional(), type: z.string().optional(), parentName: z.string().optional() }),
])

type FlatField = { readonly path: string; readonly type: string }

// Flattens a schema template into { path, type } entries, in traversal order —
// including group (object/array) fields themselves, not just their leaves, so
// a group's own name can be renamed/retyped too, matching schemaNode.ts's
// nodesToTemplate(): a plain nested record is an "object" field, an array
// represents a repeating group of its first element and is an "array" field.
// The template root itself has no name, so it never gets an entry.
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

// Runs `tasks` with at most `limit` in flight at once, preserving result order.
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

// Immediate-parent name, matching schemaOps.ts's single-level parentName disambiguation.
function fieldParentName(path: string): string | undefined {
  const segments = path.split('.')
  return segments.length > 1 ? segments.at(-2) : undefined
}

// Requests a result for exactly one field. Completeness across the whole
// schema is guaranteed by the caller's array iteration (one call per element
// of `fields`), not by this call's output shape — each call only ever has to
// get a single field right, and a failure here only costs a retry of that one
// field, never a whole batch.
async function editOneField(field: FlatField, instruction: string): Promise<FieldEditResult> {
  const prompt = `You are a schema editing assistant for humanities researchers.

Researcher instruction: "${instruction}"

Field: "${field.path}" — current name "${fieldName(field.path)}", current type "${field.type}".

Decide this field's result after applying the instruction. If the instruction does not affect this field, echo its current name and current type unchanged and set "removed" to false. If the instruction says to delete this field, set "removed" to true.`

  let lastError: unknown
  for (let attempt = 0; attempt < FIELD_EDIT_ATTEMPTS; attempt++) {
    try {
      const result = await generateText({
        model: chatModel(),
        output: Output.object({ schema: fieldEditResultSchema }),
        messages: [{ role: 'user', content: prompt }],
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
  throw new RequestError(
    502,
    `Schema edit model returned an invalid result for field "${field.path}".`,
    lastError instanceof Error ? lastError.message : String(lastError),
  )
}

// Requests only brand-new fields the instruction asks for; these can't be
// enumerated against the existing schema, so they stay a free-form op list.
async function editNewFields(currentTemplate: unknown, instruction: string): Promise<EditSchemaOp[]> {
  const schemaJson = JSON.stringify(currentTemplate, null, 2)
  const prompt = `You are a schema editing assistant for humanities researchers.

Current extraction schema (JSON):
${schemaJson}

Researcher instruction: "${instruction}"

Return ONLY a JSON array of "add" operations for any entirely new field the instruction requests. Existing fields are handled separately — do not include operations for them. No explanation, no markdown fences, no extra text.
Each operation must look like:
  {"op":"add","name":"fieldName","type":"string|number|boolean|object|array","parentName":"optionalParent"}

Rules:
- Only add fields the researcher explicitly asked for
- Omit parentName to add at the top level
- Return [] if no new fields are needed`

  const result = await generateText({
    model: chatModel(),
    messages: [{ role: 'user', content: prompt }],
  })

  const text = result.text.replace(/```(?:json)?|```/g, '').trim()
  const parsed = await parseUnknownJson(text, 'Edit schema model returned invalid JSON.')
  if (!Array.isArray(parsed)) {
    return []
  }

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
): Promise<EditSchemaOp[]> {
  const fields = flattenTemplateFields(currentTemplate)

  const [fieldResults, additionOps] = await Promise.all([
    runWithConcurrencyLimit(
      fields.map((field) => () => editOneField(field, instruction)),
      MAX_CONCURRENT_FIELD_CALLS,
    ),
    editNewFields(currentTemplate, instruction),
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

  // schemaOps.ts applies ops sequentially against a mutating tree, matching
  // each op's parentName against the tree's *current* state. A child's op
  // still carries its parent's original name, so children must be applied
  // before any ancestor group is itself renamed/removed — otherwise the
  // child's op silently fails to match once its parent's name has changed.
  fieldOps.sort((a, b) => b.depth - a.depth)

  const ops: EditSchemaOp[] = fieldOps.map((f) => f.op)
  ops.push(...additionOps)
  return ops
}
