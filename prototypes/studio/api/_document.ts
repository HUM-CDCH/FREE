import { z } from 'zod'
import { ApiError, type FormValue } from './_http.js'

const supportedMediaTypes = new Set([
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export type DocumentInput = {
  readonly file: File | null
  readonly pages: number | null
  // Pre-parsed Markdown from the parsing service (the document's "index"). When
  // present it replaces page-image rendering as the model's view of the document.
  readonly markdown: string | null
}

export type AnnotationMode = 'hints' | 'fields'

export type Annotation = {
  readonly text: string
  readonly pageNumber: number
}

export function parseAnnotations(value: FormValue | null): readonly Annotation[] {
  if (value === null || (typeof value === 'string' && value.trim() === '')) return []
  if (typeof value !== 'string') {
    throw new ApiError(400, 'invalid_request', 'annotations must be text')
  }

  try {
    const parsed: unknown = JSON.parse(value)
    return z
      .array(
        z.object({
          text: z.string(),
          pageNumber: z.number(),
        }).strict(),
      )
      .parse(parsed)
  } catch (cause) {
    throw new ApiError(400, 'invalid_request', 'annotations must contain valid annotation JSON.', { cause })
  }
}

export function parseAnnotationMode(value: FormValue | null): AnnotationMode {
  if (value === null || value === '') {
    return 'hints'
  }
  if (value === 'hints' || value === 'fields') {
    return value
  }
  throw new ApiError(400, 'invalid_request', "annotations_mode must be 'hints' or 'fields'")
}

export async function parseDocument(form: FormData): Promise<DocumentInput> {
  const file = form.get('file')
  const markdownEntry = form.get('document_markdown')
  const markdown =
    typeof markdownEntry === 'string' && markdownEntry.trim() ? normalizeMarkdownNewlines(markdownEntry) : null

  // Markdown-only: no file to validate or rasterise.
  if (!(file instanceof File)) {
    if (!markdown) {
      throw new ApiError(400, 'invalid_request', "FormData must include a 'file' or 'document_markdown' entry")
    }
    return { file: null, pages: null, markdown }
  }

  const mediaType = file.type || mediaTypeFromName(file.name)
  if (!supportedMediaTypes.has(mediaType)) {
    throw new ApiError(400, 'invalid_request', `Unsupported source document type: ${mediaType || 'unknown'}`)
  }

  return { file: new File([file], file.name, { type: mediaType }), pages: null, markdown }
}

function normalizeMarkdownNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function mediaTypeFromName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.pdf')) {
    return 'application/pdf'
  }
  if (lower.endsWith('.png')) {
    return 'image/png'
  }
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) {
    return 'image/jpeg'
  }
  if (lower.endsWith('.webp')) {
    return 'image/webp'
  }
  if (lower.endsWith('.gif')) {
    return 'image/gif'
  }
  return ''
}
