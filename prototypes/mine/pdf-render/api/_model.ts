import { createOllama, ollama } from 'ai-sdk-ollama'
import {
  convertToModelMessages,
  generateText,
  streamText,
} from 'ai'
import type { LanguageModel, UIMessage } from 'ai'
import { z } from 'zod'
import type { Annotation, AnnotationMode, DocumentInput } from './_document'
import { documentFileParts, type DocumentFilePart } from './_pdf'
import { schemaPrompt } from './_schema'
import { RequestError } from './_http'
import { splitEvidenceResult, wrapTemplateWithEvidence } from './_evidence_template'
import { parseExtractionResult, parseTemplate, parseUnknownJson } from './_model_output'

export {
  parseAnnotationMode,
  parseAnnotations,
  parseDocument,
} from './_document'
export { json, modelError, parseTemperature, RequestError } from './_http'

const DEFAULT_MODEL = 'llama3.2'
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
const IMAGE_PLACEHOLDER = '<|vision_start|><|image_pad|><|vision_end|>'

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

export type MarkdownModelInput = {
  readonly document: DocumentInput
  readonly temperature?: number
}

// The document's content for the model: parsed Markdown when the parsing service
// has indexed it (the chosen "replace page-images" path), otherwise rasterised
// page images (covers non-PDF image uploads and parse failures).
type DocumentContentPart = DocumentFilePart | { readonly type: 'text'; readonly text: string }
type NuExtractMode = 'structured' | 'template-generation' | 'markdown' | 'content'

async function documentContentParts(
  document: DocumentInput,
): Promise<{ readonly parts: readonly DocumentContentPart[]; readonly pages: number | null }> {
  if (document.markdown) {
    return { parts: [{ type: 'text', text: document.markdown }], pages: document.pages }
  }
  if (!document.file) {
    throw new RequestError(400, "No document content: provide a 'file' or 'document_markdown'")
  }
  const fileParts = await documentFileParts(document.file)
  return { parts: fileParts.parts, pages: fileParts.pages }
}

function model(): LanguageModel {
  const modelId = process.env.AI_MODEL || DEFAULT_MODEL
  const baseURL = process.env.AI_BASE_URL
  const apiKey = process.env.AI_API_KEY

  if (baseURL) {
    return createOllama({
      baseURL,
      apiKey,
    })(modelId)
  }

  if (apiKey) {
    return createOllama({ apiKey })(modelId)
  }

  return ollama(modelId)
}

export async function streamChatWithModel(messages: readonly UIMessage[]): Promise<Response> {
  const result = streamText({
    model: model(),
    system:
      'You help humanities researchers inspect source documents in FREE. If no source document content is attached, say that no document context is available before answering normally.',
    messages: await convertToModelMessages([...messages]),
  })

  return result.toUIMessageStreamResponse({
    onError: () => 'Chat failed.',
  })
}

export async function extractWithModel({
  document,
  template,
  instruction,
  temperature,
}: ExtractModelInput): Promise<{
  readonly result: Record<string, unknown>
  readonly evidence: Record<string, unknown> | null
  readonly raw: string
  readonly reasoning: null
  readonly pages: number | null
}> {
  const documentParts = await documentContentParts(document)
  const evidenceTemplate = wrapTemplateWithEvidence(template ?? {})
  const generated = await generateWithNuExtractRawPrompt({
    mode: 'structured',
    template: JSON.stringify(evidenceTemplate, null, 2),
    instructions: instruction?.trim() || null,
    documentParts: documentParts.parts,
    temperature,
  })
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
}: SchemaModelInput): Promise<{ readonly template: Record<string, unknown>; readonly raw: string; readonly pages: number | null }> {
  const documentParts = await documentContentParts(document)
  const generated = await generateWithNuExtractRawPrompt({
    mode: 'template-generation',
    instructions: null,
    documentParts: [...documentParts.parts, { type: 'text', text: schemaPrompt(annotations, annotationsMode) }],
    temperature,
  })
  const template = await parseTemplate(generated.response)

  return { template, raw: generated.response, pages: documentParts.pages ?? document.pages }
}

export async function markdownWithModel({
  document,
  temperature,
}: MarkdownModelInput): Promise<{ readonly markdown: string; readonly pages: number | null }> {
  // The parsing service already produces Markdown — serve it as-is rather than
  // re-deriving it from page images.
  if (document.markdown) {
    return { markdown: document.markdown, pages: document.pages }
  }
  if (!document.file) {
    throw new RequestError(400, "No document content: provide a 'file' or 'document_markdown'")
  }

  const documentParts = await documentFileParts(document.file)
  const result = await generateText({
    model: model(),
    temperature,
    messages: [
      {
        role: 'user',
        content: [
          ...documentParts.parts,
          {
            type: 'text',
            text:
              'Convert this source document to high-fidelity Markdown. Return only Markdown: no introduction, no explanation. Preserve headings, tables, reading order, math, figures/images as descriptions, and page breaks.',
          },
        ],
      },
    ],
  })

  return { markdown: result.text.trim(), pages: documentParts.pages ?? document.pages }
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
  const rendered = renderNuExtractPrompt({ mode, template, instructions, documentParts })
  const response = await fetch(ollamaGenerateUrl(), {
    method: 'POST',
    headers: ollamaHeaders(),
    body: JSON.stringify({
      model: process.env.AI_MODEL || DEFAULT_MODEL,
      prompt: rendered.prompt,
      images: rendered.images.length > 0 ? rendered.images : undefined,
      raw: true,
      stream: false,
      options: temperature === undefined ? undefined : { temperature },
    }),
  })

  const bodyText = await response.text()
  if (!response.ok) {
    throw new RequestError(response.status, 'Ollama generation failed.', bodyText || null)
  }

  const parsed = ollamaGenerateResponseSchema.safeParse(await parseUnknownJson(bodyText, 'Ollama returned invalid JSON.'))
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
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (process.env.AI_API_KEY) {
    headers.authorization = `Bearer ${process.env.AI_API_KEY}`
  }
  return headers
}
