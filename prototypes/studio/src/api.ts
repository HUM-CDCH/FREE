import { isRecord } from './template'

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
  evidence: Record<string, unknown> | null
  reasoning: string | null
  raw: string
  pages: number | null
}
export type SchemaDone = { template: unknown; raw: string; pages: number | null }
export type MarkdownDone = { markdown: string; pages: number | null }

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
  if (!('evidence' in data)) {
    throw new Error("extract: response missing 'evidence' — API contract drift?")
  }
  return data as ExtractDone
}

export function decodeMarkdownDone(data: unknown): MarkdownDone {
  if (!isRecord(data) || typeof data.markdown !== 'string') {
    throw new Error("markdown: response missing 'markdown' — API contract drift?")
  }
  return data as MarkdownDone
}

async function readErrorDetail(response: Response): Promise<string> {
  const body = await response.json().catch(() => null)
  const detail = isRecord(body) ? body.detail : null
  if (typeof detail === 'string') {
    return detail
  }
  if (isRecord(detail) && typeof detail.message === 'string') {
    return detail.message
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

// Starts a docling parse job on upload and resolves with its Markdown once done.
// check-then-delay polling so a job that is already complete returns immediately.
export async function parseDocumentToMarkdown(
  file: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData()
  form.append('file', file, fileName)
  form.append('pipeline', 'docling_pdf')

  const started = await fetch(`${PARSING_SERVICE_BASE}/tasks`, { method: 'POST', body: form, signal })
  if (!started.ok) {
    throw new Error(
      (await readErrorDetail(started)) || `Parsing service rejected the document (HTTP ${started.status})`,
    )
  }
  const { task_id: taskId } = (await started.json()) as { task_id: string }

  for (;;) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
    const res = await fetch(`${PARSING_SERVICE_BASE}/tasks/${taskId}`, { signal })
    if (!res.ok) {
      throw new Error(`Parsing status check failed (HTTP ${res.status})`)
    }
    const meta = (await res.json()) as TaskStatus
    if (meta.status === 'completed') {
      break
    }
    if (meta.status === 'failed') {
      throw new Error(meta.error || 'Document parsing failed')
    }
    await new Promise((resolve) => setTimeout(resolve, PARSE_POLL_MS))
  }

  const md = await fetch(`${PARSING_SERVICE_BASE}/tasks/${taskId}/markdown`, { signal })
  if (!md.ok) {
    throw new Error(`Could not fetch parsed Markdown (HTTP ${md.status})`)
  }
  return md.text()
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
): Promise<{ result: unknown; evidence: unknown }> {
  const form = new FormData()
  form.append('template', JSON.stringify(template ?? {}))
  if (markdown) {
    form.append('document_markdown', markdown)
  } else {
    form.append('file', file, fileName)
  }
  if (instruction) form.append('instruction', instruction)

  const done = await postForm('/extract', form, decodeExtractDone, signal)
  return { result: done.result, evidence: done.evidence }
}

export async function requestMarkdown(
  file: Blob,
  fileName: string,
  signal?: AbortSignal,
  markdown?: string | null,
): Promise<MarkdownDone> {
  const form = new FormData()
  form.append('file', file, fileName)
  if (markdown) {
    form.append('document_markdown', markdown)
  }

  return postForm('/markdown', form, decodeMarkdownDone, signal)
}
