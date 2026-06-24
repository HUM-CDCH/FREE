import { isRecord } from './template'

export const API_BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? '/api'

export type TemplateAnnotation = { text: string; pageNumber: number }

export type AnnotationsMode = 'hints' | 'fields'

type TemplateOptions = {
  annotations?: TemplateAnnotation[]
  annotationsMode?: AnnotationsMode
}

export type ExtractDone = {
  result: Record<string, unknown>
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

// ---------- request wrappers ----------

export async function requestSchema(
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

  const done = await postForm('/generate_schema', form, decodeSchemaDone, signal)
  return done.template
}

export async function requestExtraction(
  file: Blob,
  fileName: string,
  template: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const form = new FormData()
  form.append('file', file, fileName)
  form.append('template', JSON.stringify(template ?? {}))

  const done = await postForm('/extract', form, decodeExtractDone, signal)
  return done.result
}

export async function requestMarkdown(
  file: Blob,
  fileName: string,
  signal?: AbortSignal,
): Promise<MarkdownDone> {
  const form = new FormData()
  form.append('file', file, fileName)

  return postForm('/markdown', form, decodeMarkdownDone, signal)
}
