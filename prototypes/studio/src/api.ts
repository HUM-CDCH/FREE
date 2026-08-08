import { isRecord } from './template'
import type { SchemaNode } from '../shared/schemaNode'
import { schemaEditResponseSchema, type SchemaEditResponse } from '../shared/schemaEdit.contract'
import { decodeParsedDocument, type ParsedDocumentV2 } from './parsedDocument'
import type {
  GroundingModelRequest,
  GroundingModelResponse,
} from './extractionGrounding'
import type {
  EvidenceLink,
  GroundedModelAttribution,
} from '../shared/groundedExtraction'

export const API_BASE = '/api'

// The parsing service runs the docling/paddleocr extraction. The browser starts
// the job on upload and polls it; the resulting Markdown becomes the document's
// representation that the LLM extraction works from.
export const PARSING_SERVICE_BASE: string =
  (import.meta.env.VITE_PARSING_SERVICE_URL as string | undefined) ?? 'http://127.0.0.1:8000'

const PARSE_POLL_MS = 1500

export type TemplateAnnotation = { text: string; pageNumber: number }

export type AnnotationsMode = 'hints' | 'fields'

type TemplateOptions = {
  annotations?: TemplateAnnotation[]
  annotationsMode?: AnnotationsMode
  markdown?: string | null
}

export type ExtractDone = {
  result: Record<string, unknown>
  reasoning: string | null
  raw: string
  pages: number | null
  /** What produced this result, as the review write records it. */
  modelAttribution: unknown
}
export type SchemaDone = { template: unknown; raw: string; pages: number | null }

export function decodeSchemaDone(data: unknown): SchemaDone {
  if (!isRecord(data) || !('template' in data)) {
    throw new Error("generate_schema: response missing 'template' — API contract drift?")
  }
  return data as SchemaDone
}

export function decodeExtractDone(data: unknown): ExtractDone {
  if (!isRecord(data) || !isRecord(data.result)) {
    throw new Error("extract: response missing 'result' — API contract drift?")
  }
  return data as ExtractDone
}

async function readErrorDetail(response: Response): Promise<string> {
  const body = await response.json().catch(() => null)
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return `${error.code}: ${error.message}`
  }
  return ''
}

async function postForm<T>(
  endpoint: string,
  form: FormData,
  decode: (data: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method: 'POST',
    body: form,
    headers: { accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(detail || `Request to ${endpoint} failed (HTTP ${response.status})`)
  }
  return decode(await response.json())
}

// ---------- parsing service (document indexing) ----------

type TaskStatus = { status: string; error?: string | null }

export async function fetchParsedDocument(taskId: string, signal?: AbortSignal): Promise<ParsedDocumentV2> {
  const response = await fetch(`${PARSING_SERVICE_BASE}/tasks/${taskId}/document`, { signal, headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`Could not fetch parsed document (HTTP ${response.status})`)
  return decodeParsedDocument(await response.json())
}

// Starts a Docling parse job for a Source Document and resolves once done with both the
// Markdown and the strict v2 document. check-then-delay polling so a job that
// is already complete returns immediately.
export async function parseDocument(
  file: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<{ markdown: string; document: ParsedDocumentV2 }> {
  const form = new FormData()
  form.append('file', file, fileName)
  form.append('pipeline', 'docling_pdf')
  const started = await fetch(`${PARSING_SERVICE_BASE}/tasks`, { method: 'POST', body: form, signal })
  if (!started.ok) throw new Error((await readErrorDetail(started)) || `Parsing service rejected the document (HTTP ${started.status})`)
  const { task_id: taskId } = (await started.json()) as { task_id: string }
  for (;;) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const res = await fetch(`${PARSING_SERVICE_BASE}/tasks/${taskId}`, { signal })
    if (!res.ok) throw new Error(`Parsing status check failed (HTTP ${res.status})`)
    const meta = (await res.json()) as TaskStatus
    if (meta.status === 'completed') break
    if (meta.status === 'failed') throw new Error(meta.error || 'Document parsing failed')
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, PARSE_POLL_MS)
    await promise
  }
  const [md, document] = await Promise.all([
    fetch(`${PARSING_SERVICE_BASE}/tasks/${taskId}/markdown`, { signal }),
    fetchParsedDocument(taskId, signal),
  ])
  if (!md.ok) throw new Error(`Could not fetch parsed Markdown (HTTP ${md.status})`)
  return { markdown: await md.text(), document }
}

// ---------- request wrappers ----------

export async function requestSchema(
  file: Blob,
  fileName: string,
  signal?: AbortSignal,
  options?: TemplateOptions,
): Promise<unknown> {
  const form = new FormData()
  if (options?.markdown) {
    form.append('document_markdown', options.markdown)
  } else {
    form.append('file', file, fileName)
  }
  if (options?.annotations?.length) {
    form.append('annotations', JSON.stringify(options.annotations))
    form.append('annotations_mode', options.annotationsMode ?? 'hints')
  }

  const done = await postForm('/generate_schema', form, decodeSchemaDone, signal)
  return done.template
}

export async function requestExtraction(
  file: Blob,
  fileName: string,
  template: unknown,
  signal?: AbortSignal,
  markdown?: string | null,
  instruction?: string,
): Promise<{ result: unknown; modelAttribution: unknown }> {
  const form = new FormData()
  form.append('template', JSON.stringify(template ?? {}))
  if (markdown) {
    form.append('document_markdown', markdown)
  } else {
    form.append('file', file, fileName)
  }
  if (instruction) form.append('instruction', instruction)

  const done = await postForm('/extract', form, decodeExtractDone, signal)
  return { result: done.result, modelAttribution: done.modelAttribution ?? null }
}

/** One buffered grounding operation over the provider-neutral model route. */
export async function requestGrounding({
  documentMarkdown,
  template,
  instruction,
  signal,
}: GroundingModelRequest): Promise<GroundingModelResponse> {
  const form = new FormData()
  form.append('template', JSON.stringify(template))
  form.append('document_markdown', documentMarkdown)
  form.append('instruction', instruction)

  const done = await postForm('/extract', form, decodeExtractDone, signal)
  return { result: done.result, modelAttribution: done.modelAttribution ?? null }
}

export type ExtractionReview = {
  schemaRevisionId: string
  result: unknown
  evidenceLinks: EvidenceLink[]
  modelAttribution: GroundedModelAttribution
  reviewDecisions: Array<{
    evidenceAnchorId: string
    reviewedOccurrenceIds: string[]
  }>
}

/** The researcher's accepted Extraction Result and its canonical Review Decisions. */
export async function postExtractionReview(
  sourceRepresentationId: string,
  review: ExtractionReview,
  signal?: AbortSignal,
): Promise<{ extractionId: string }> {
  const response = await fetch(
    `${API_BASE}/source-representations/${sourceRepresentationId}/extraction-reviews`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(review),
      signal,
    },
  )
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(detail || `Saving the review failed (HTTP ${response.status})`)
  }
  return (await response.json()) as { extractionId: string }
}

// export async function requestMarkdown(
//   file: Blob,
//   fileName: string,
//   signal?: AbortSignal,
//   markdown?: string | null,
// ): Promise<MarkdownDone> {
//   const form = new FormData()
//   form.append('file', file, fileName)
//   if (markdown) {
//     form.append('document_markdown', markdown)
//   }

//   return postForm('/markdown', form, decodeMarkdownDone, signal)
// }

function decodeSchemaEdit(data: unknown): SchemaEditResponse {
  const parsed = schemaEditResponseSchema.safeParse(data)
  if (!parsed.success) throw new Error('edit_schema: invalid response — API contract drift?')
  return parsed.data
}

export async function requestSchemaEdit(
  nodes: SchemaNode[],
  instruction: string,
  documentMarkdown: string | null,
  signal?: AbortSignal,
): Promise<SchemaEditResponse> {
  const form = new FormData()
  form.append('current_nodes', JSON.stringify(nodes))
  form.append('instruction', instruction)
  if (documentMarkdown !== null) form.append('document_markdown', documentMarkdown)
  return postForm('/edit_schema', form, decodeSchemaEdit, signal)
}
