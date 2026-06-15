import { isRecord } from './template'
import { streamJsonl } from './jsonlStream'

export type TemplateAnnotation = { text: string; pageNumber: number }

export type AnnotationsMode = 'hints' | 'fields'

type TemplateOptions = {
  annotations?: TemplateAnnotation[]
  annotationsMode?: AnnotationsMode
}

// ---------- terminal `done` payloads (mirror main.py; one place to update) ----------

export type ChatDone = { message: string; reasoning: string | null; raw: string }
export type ExtractDone = {
  result: Record<string, unknown>
  reasoning: string | null
  raw: string
  pages: number
}
export type TemplateDone = { template: unknown; raw: string; pages: number }
export type MarkdownDone = { pages: string[]; count: number }

// ---------- boundary decoders ----------
// One per `done` payload. They assert the fields the frontend depends on and
// throw a named error on absence, so backend contract drift fails loud and
// localized here instead of flowing through as a silent `undefined`.

export function decodeTemplateDone(data: unknown): TemplateDone {
  if (!isRecord(data) || !('template' in data)) {
    throw new Error("generate-template: done payload missing 'template' — backend contract drift?")
  }
  return data as TemplateDone
}

export function decodeExtractDone(data: unknown): ExtractDone {
  if (!isRecord(data) || !isRecord(data.result)) {
    throw new Error("extract: done payload missing 'result' — backend contract drift?")
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
  if (!isRecord(data) || !Array.isArray(data.pages)) {
    throw new Error("markdown: done payload missing 'pages' — backend contract drift?")
  }
  return data as MarkdownDone
}

// ---------- request wrappers ----------

/**
 * Stream the `/generate-template` endpoint. Delta events carry incremental
 * model output; the return value is the parsed extraction template.
 */
export async function requestTemplate(
  file: Blob,
  fileName: string,
  onDelta: (output: string) => void,
  signal?: AbortSignal,
  options?: TemplateOptions,
): Promise<unknown> {
  const form = new FormData()
  form.append('file', file, fileName)
  if (options?.annotations?.length) {
    form.append('annotations', JSON.stringify(options.annotations))
    form.append('annotations_mode', options.annotationsMode ?? 'hints')
  }

  const done = await streamJsonl('/generate-template', form, { onDelta }, decodeTemplateDone, signal)
  return done.template
}

/**
 * Stream the `/extract` endpoint with the approved extraction schema. Delta
 * events carry incremental output; the return value is the extraction result
 * object, mirroring the schema's structure with extracted values.
 */
export async function requestExtraction(
  file: Blob,
  fileName: string,
  template: unknown,
  onDelta: (output: string) => void,
  signal?: AbortSignal,
): Promise<unknown> {
  const form = new FormData()
  form.append('file', file, fileName)
  form.append('template', JSON.stringify(template))

  const done = await streamJsonl('/extract', form, { onDelta }, decodeExtractDone, signal)
  return done.result
}
