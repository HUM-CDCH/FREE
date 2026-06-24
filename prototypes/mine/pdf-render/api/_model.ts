import { createOllama, ollama } from 'ai-sdk-ollama'
import {
  convertToModelMessages,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  Output,
  streamText,
} from 'ai'
import type { LanguageModel, UIMessage } from 'ai'
import { z } from 'zod'
import type { Annotation, AnnotationMode, DocumentInput } from './_document'
import { documentFileParts, type DocumentFilePart } from './_pdf'
import { extractionPrompt, schemaFromTemplate, schemaPrompt } from './_schema'
import { RequestError } from './_http'

export {
  parseAnnotationMode,
  parseAnnotations,
  parseDocument,
} from './_document'
export { json, modelError, parseTemperature, RequestError } from './_http'

const DEFAULT_MODEL = 'llama3.2'

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

const templateEnvelopeSchema = z.object({
  template: z.record(z.string(), z.unknown()),
})

// The document's content for the model: parsed Markdown when the parsing service
// has indexed it (the chosen "replace page-images" path), otherwise rasterised
// page images (covers non-PDF image uploads and parse failures).
type DocumentContentPart = DocumentFilePart | { readonly type: 'text'; readonly text: string }

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
}: ExtractModelInput): Promise<{ readonly result: Record<string, unknown>; readonly raw: string; readonly reasoning: null; readonly pages: number | null }> {
  const resultSchema = jsonSchema<Record<string, unknown>>(schemaFromTemplate(template), {
    validate(value) {
      return isRecord(value)
        ? { success: true, value }
        : { success: false, error: new Error('Extraction result must be a JSON object') }
    },
  })

  try {
    const documentParts = await documentContentParts(document)
    const result = await generateText({
      model: model(),
      temperature,
      output: Output.object({
        schema: resultSchema,
        name: 'extraction_result',
      }),
      messages: [
        {
          role: 'user',
          content: [
            ...documentParts.parts,
            {
              type: 'text',
              text: extractionPrompt(template, instruction),
            },
          ],
        },
      ],
    })

    return { result: result.output, raw: result.text, reasoning: null, pages: documentParts.pages ?? document.pages }
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new RequestError(502, 'Model returned output that did not match the extraction schema.', error.text ?? null)
    }
    throw error
  }
}

export async function generateSchemaWithModel({
  document,
  annotations,
  annotationsMode,
  temperature,
}: SchemaModelInput): Promise<{ readonly template: Record<string, unknown>; readonly raw: string; readonly pages: number | null }> {
  try {
    const documentParts = await documentContentParts(document)
    const result = await generateText({
      model: model(),
      temperature,
      output: Output.object({
        schema: templateEnvelopeSchema,
        name: 'extraction_schema',
      }),
      messages: [
        {
          role: 'user',
          content: [
            ...documentParts.parts,
            {
              type: 'text',
              text: schemaPrompt(annotations, annotationsMode),
            },
          ],
        },
      ],
    })

    return { template: result.output.template, raw: result.text, pages: documentParts.pages ?? document.pages }
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      throw new RequestError(502, 'Model returned an invalid extraction schema.', error.text ?? null)
    }
    throw error
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
