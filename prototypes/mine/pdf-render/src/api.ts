import { isRecord } from './template'
import { API_BASE } from './jsonlStream'

export type TemplateAnnotation = { text: string; pageNumber: number }

export type AnnotationsMode = 'hints' | 'fields'

type TemplateOptions = {
  annotations?: TemplateAnnotation[]
  annotationsMode?: AnnotationsMode
}

// ---------- response payloads (mirror main.py; one place to update) ----------

export type ChatDone = { message: string; reasoning: string | null; raw: string }
export type EvidenceItem = { snippet: string; page: number }
// The model may use any nesting structure in _evidence — leaves are collected
// recursively by the highlight layer, so we accept any shape here.
export type Evidence = Record<string, unknown>

export type ExtractDone = {
  result: Record<string, unknown>
  reasoning: string | null
  raw: string
  pages: number
  evidence: Evidence | null
}
export type TemplateDone = { template: unknown; raw: string; pages: number }
export type MarkdownDone = { markdown: string; pages: number }

// ---------- boundary decoders ----------
// One per response payload. They assert the fields the frontend depends on and
// throw a named error on absence, so backend contract drift fails loud and
// localized here instead of flowing through as a silent `undefined`.

export function decodeTemplateDone(data: unknown): TemplateDone {
  if (!isRecord(data) || !('template' in data)) {
    throw new Error("generate-template: response missing 'template' — backend contract drift?")
  }
  return data as TemplateDone
}

export function decodeExtractDone(data: unknown): ExtractDone {
  if (!isRecord(data) || !isRecord(data.result)) {
    throw new Error("extract: response missing 'result' — backend contract drift?")
  }
  return data as ExtractDone
}

export function decodeChatDone(data: unknown): ChatDone {
  if (!isRecord(data) || typeof data.message !== 'string') {
    throw new Error("chat: done payload missing 'message' — backend contract drift?")
  }
  return data as ChatDone
}

export function decodeMarkdownDone(data: unknown): MarkdownDone {
  if (!isRecord(data) || typeof data.markdown !== 'string') {
    throw new Error("markdown: response missing 'markdown' — backend contract drift?")
  }
  return data as MarkdownDone
}

// ---------- buffered POST helper ----------

/** FastAPI surfaces failures as `{ detail }` — a string (400 / model-unreachable
 * 502) or an object with `message` (the unparseable-output 502). */
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

/**
 * POST `form` to a buffered endpoint and decode its single JSON response,
 * throwing the backend's `detail` on a non-OK response.
 */
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

// ---------- request wrappers ----------

/**
 * Request a schema suggestion from `/generate-template`. Resolves with the
 * parsed extraction template.
 */
export async function requestTemplate(
  file: Blob,
  fileName: string,
  signal?: AbortSignal,
  options?: TemplateOptions,
): Promise<unknown> {
  const form = new FormData()
  form.append('file', file, fileName)
  if (options?.annotations?.length) {
    form.append('annotations', JSON.stringify(options.annotations))
    form.append('annotations_mode', options.annotationsMode ?? 'hints')
  }

  const done = await postForm('/generate-template', form, decodeTemplateDone, signal)
  return done.template
}

/**
 * Run `/extract` with the approved extraction schema. Resolves with the
 * extraction result object, mirroring the schema's structure with extracted
 * values.
 */
export async function requestExtraction(
  file: Blob,
  fileName: string,
  template: unknown,
  signal?: AbortSignal,
  includeEvidence = true,
): Promise<{ result: unknown; evidence: Evidence | null }> {
  const form = new FormData()
  form.append('file', file, fileName)
  form.append('template', JSON.stringify(template ?? {}))
  if (includeEvidence) {
    form.append('include_evidence', 'true')
  }

  const done = await postForm('/extract', form, decodeExtractDone, signal)
  return { result: done.result, evidence: done.evidence ?? null }
}
