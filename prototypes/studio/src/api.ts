import { isRecord } from './template'
import { type SchemaNode, nodesToTemplate } from './schemaNode'
import type { SchemaOp } from './schemaOps'
import { type ParsedTable, parseParsedTables } from './parsedDocument'

export const API_BASE = '/api'

// The parsing service runs the docling/paddleocr extraction. The browser starts
// the job on upload and polls it; the resulting Markdown becomes the document's
// representation that the LLM extraction works from.
export const PARSING_SERVICE_BASE: string =
  (import.meta.env.VITE_PARSING_SERVICE_URL as string | undefined) ?? 'http://127.0.0.1:8000'

const PARSE_POLL_MS = 1500

export type TemplateAnnotation = { text: string; pageNumber: number }

export type AnnotationsMode = 'hints' | 'fields'

// The researcher's explicit choice of extraction pipeline for the current
// schema — 'catalog' documents (many structurally similar records, e.g. one
// section per grave) get heading-based per-section extraction; 'article'
// documents (one continuous document, e.g. a journal article) always run a
// single whole-document extraction, even if their heading structure would
// otherwise look sectionable. See _catalog_sections.ts's getExtractionStrategy.
export type ExtractionStrategy = 'catalog' | 'article'

type TemplateOptions = {
  annotations?: TemplateAnnotation[]
  annotationsMode?: AnnotationsMode
  markdown?: string | null
  strategy?: ExtractionStrategy
}

export type ExtractDone = {
  result: Record<string, unknown>
  evidence: Record<string, unknown> | null
  reasoning: string | null
  raw: string
  pages: number | null
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
  if (!('evidence' in data)) {
    throw new Error("extract: response missing 'evidence' — API contract drift?")
  }
  return data as ExtractDone
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
): Promise<{ taskId: string; markdown: string }> {
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
  return { taskId, markdown: await md.text() }
}

// Best-effort: table geometry is an enhancement (see design.md), never a hard
// dependency, so callers should treat a rejected promise the same as "no tables".
export async function fetchParsedTables(taskId: string, signal?: AbortSignal): Promise<ParsedTable[]> {
  const response = await fetch(`${PARSING_SERVICE_BASE}/tasks/${taskId}/document`, { signal })
  if (!response.ok) {
    throw new Error(`Could not fetch parsed document (HTTP ${response.status})`)
  }
  const data = (await response.json()) as { tables?: unknown }
  return parseParsedTables(data.tables)
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
  if (options?.strategy) {
    form.append('strategy', options.strategy)
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
  hasTables?: boolean,
): Promise<{ result: unknown; evidence: unknown }> {
  const form = new FormData()
  form.append('template', JSON.stringify(template ?? {}))
  if (markdown) {
    form.append('document_markdown', markdown)
  } else {
    form.append('file', file, fileName)
  }
  if (instruction) form.append('instruction', instruction)
  form.append('has_tables', hasTables ? 'true' : 'false')

  const done = await postForm('/extract', form, decodeExtractDone, signal)
  return { result: done.result, evidence: done.evidence }
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

function decodeSchemaOps(data: unknown): SchemaOp[] {
  if (!isRecord(data) || !Array.isArray(data.ops)) {
    throw new Error("edit_schema: response missing 'ops' — API contract drift?")
  }
  return data.ops as SchemaOp[]
}

export async function requestSchemaEdit(
  nodes: SchemaNode[],
  instruction: string,
  signal?: AbortSignal,
): Promise<SchemaOp[]> {
  const form = new FormData()
  form.append('current_template', JSON.stringify(nodesToTemplate(nodes)))
  form.append('instruction', instruction)
  return postForm('/edit_schema', form, decodeSchemaOps, signal)
}
