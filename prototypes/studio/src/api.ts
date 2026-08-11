import { isRecord } from '../shared/template'
import type { SchemaNode } from '../shared/schemaNode'
import { schemaEditResponseSchema, type SchemaEditResponse } from '../shared/schemaEdit.contract'
import { decodeParsedDocument, type ParsedDocument } from '../shared/parsedDocument'
import {
  extractionRequestSchema,
  extractionAttemptSchema,
  finalizeExtractionReviewSchema,
  type ExtractionRequest,
  type ExtractionAttempt,
  type ReviewDecisionInput,
} from '../shared/extraction.contract'

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

export type SchemaDone = { template: unknown; raw: string; pages: number | null }

export function decodeSchemaDone(data: unknown): SchemaDone {
  if (!isRecord(data) || !('template' in data)) {
    throw new Error("generate_schema: response missing 'template' — API contract drift?")
  }
  return data as SchemaDone
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

export async function fetchParsedDocument(taskId: string, signal?: AbortSignal): Promise<ParsedDocument> {
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
): Promise<{ markdown: string; document: ParsedDocument }> {
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

async function extractionJson(
  path: string,
  method: 'POST' | 'DELETE',
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    throw new Error(detail || `Extraction failed (HTTP ${response.status})`)
  }
  return response.json()
}

export async function requestExtraction(
  input: ExtractionRequest,
  signal?: AbortSignal,
): Promise<ExtractionAttempt> {
  const request = extractionRequestSchema.parse(input)
  return extractionAttemptSchema.parse(
    await extractionJson('/extractions', 'POST', request, signal),
  )
}

export async function cancelExtraction(extractionId: string) {
  await extractionJson(`/extractions/${extractionId}`, 'DELETE', null)
}

export async function finalizeExtractionReview(
  extractionId: string,
  reviewDecisions: readonly ReviewDecisionInput[],
): Promise<ExtractionAttempt> {
  const review = finalizeExtractionReviewSchema.parse({ reviewDecisions })
  return extractionAttemptSchema.parse(
    await extractionJson(
      `/extractions/${extractionId}/review`,
      'POST',
      review,
    ),
  )
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
