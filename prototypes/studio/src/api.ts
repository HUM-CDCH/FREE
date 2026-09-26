import { authenticatedFetch } from './auth/authenticatedFetch.ts'
import { ensureModelKeysSent } from './modelKeys/modelKeyHandoff'
import { acknowledgeReviewDraft, forgetReviewDraft, rememberReviewDraft, REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import { resultPathKey } from './reviewDecisions'
import { isRecord } from '../shared/template'
import { schemaEditResponseSchema, type SchemaEditResponse } from '../shared/schemaEdit.contract'
import {
  extractionRequestSchema,
  extractionAttemptSchema,
  extractionReadResponseSchema,
  extractionModelListingSchema,
  finalizeExtractionReviewSchema,
  extractionReviewDraftSchema,
  reviewDecisionInputSchema,
  type ExtractionRequestInput,
  type ExtractionAttempt,
  type ExtractionModelListing,
  type ReviewDecisionInput,
} from '../shared/extraction.contract'
import { ingestionModelListingSchema, type IngestionModelListing } from '../shared/modelConfig.contract'

export const API_BASE = '/api'

export type TemplateAnnotation = { text: string; pageNumber: number }
//
// export type AnnotationsMode = 'hints' | 'fields'

type TemplateOptions = {
  instruction?: string
}

export type SourceModelContext = {
  projectContextId: string
  sourceRepresentationRevisionId: string
}

export type SchemaModelContext = {
  projectContextId: string
  extractionSchemaId: string
  schemaRevisionId: string
  sourceRepresentationRevisionId?: string
}

export type SchemaDone = { template: unknown; raw: string; pages: number | null }

export function decodeSchemaDone(data: unknown): SchemaDone {
  if (!isRecord(data) || !('template' in data)) {
    throw new Error("generate_schema: response missing 'template' — API contract drift?")
  }
  return data as SchemaDone
}

async function readError(response: Response): Promise<{ code: string; message: string } | null> {
  const body = await response.json().catch(() => null)
  const error = isRecord(body) && isRecord(body.error) ? body.error : null
  return error && typeof error.code === 'string' && typeof error.message === 'string'
    ? { code: error.code, message: error.message }
    : null
}

async function readErrorDetail(response: Response): Promise<string> {
  const error = await readError(response)
  return error ? `${error.code}: ${error.message}` : ''
}

async function postForm<T>(
  endpoint: string,
  form: FormData,
  decode: (data: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const response = await authenticatedFetch(`${API_BASE}${endpoint}`, {
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
  context: SourceModelContext,
  signal?: AbortSignal,
  options?: TemplateOptions,
): Promise<unknown> {
  const form = new FormData()
  form.append('project_context_id', context.projectContextId)
  form.append(
    'source_representation_revision_id',
    context.sourceRepresentationRevisionId,
  )
  if (options?.instruction?.trim())
    form.append('instruction', options.instruction.trim())

  await ensureModelKeysSent()
  const done = await postForm('/generate_schema', form, decodeSchemaDone, signal)
  return done.template
}

/** Thrown when a JSON endpoint (an Extraction, or a model listing) answers with an HTTP error status. */
export class ApiRequestError extends Error {
  readonly status: number
  /** The server's error code (`{ error: { code } }`), when it sent one. */
  readonly code: string | null

  constructor(message: string, status: number, code: string | null = null) {
    super(message)
    this.name = 'ApiRequestError'
    this.status = status
    this.code = code
  }
}

async function requestJson(
  path: string,
  method: 'GET' | 'POST' | 'DELETE',
  body: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await authenticatedFetch(`${API_BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal,
  })
  if (!response.ok) {
    const error = await readError(response)
    throw new ApiRequestError(
      error ? `${error.code}: ${error.message}` : `Request to ${path} failed (HTTP ${response.status})`,
      response.status,
      error?.code ?? null,
    )
  }
  return response.json()
}

/** The kei-exp deployment's extraction models, the roles each may take and its default per role: what a run's
 *  Extraction Model Choice picks from. */
export async function readExtractionModels(signal?: AbortSignal): Promise<ExtractionModelListing> {
  return extractionModelListingSchema.parse(
    await requestJson('/extraction-models', 'GET', null, signal),
  )
}

/** kei's OCR and layout models, whether its OCR server serves each now, and its default per role: what the
 *  researcher's Ingestion Model Choice picks from. */
export async function readIngestionModels(signal?: AbortSignal): Promise<IngestionModelListing> {
  return ingestionModelListingSchema.parse(
    await requestJson('/ingestion-models', 'GET', null, signal),
  )
}

export async function requestExtraction(
  input: ExtractionRequestInput,
  signal?: AbortSignal,
): Promise<ExtractionAttempt> {
  const request = extractionRequestSchema.parse(input)
  return extractionAttemptSchema.parse(
    await requestJson('/extractions', 'POST', request, signal),
  )
}

/**
 * Reads one stored Extraction with the Review Decisions its Evidence requires.
 * The server derives them from the pinned Source Representation, so a reader
 * never loads the parsed document only to review.
 */
export async function readExtraction(
  extractionId: string,
  signal?: AbortSignal,
) {
  await draftWrites.get(extractionId)?.catch(() => {})
  signal?.throwIfAborted()
  return extractionReadResponseSchema.parse(
    await requestJson(`/extractions/${extractionId}`, 'GET', null, signal),
  )
}

export async function cancelExtraction(extractionId: string) {
  await requestJson(`/extractions/${extractionId}`, 'DELETE', null)
}

export async function finalizeExtractionReview(
  extractionId: string,
  reviewDecisions: readonly ReviewDecisionInput[],
  expectedDraftVersion = 0,
): Promise<ExtractionAttempt> {
  const review = finalizeExtractionReviewSchema.parse({ reviewDecisions, expectedDraftVersion })
  return extractionAttemptSchema.parse(
    await requestJson(
      `/extractions/${extractionId}/review`,
      'POST',
      review,
    ),
  )
}

type SavedReviewDraft = { version: number; decisions: ReviewDecisionInput[] }
export async function resetExtractionReview(extractionId: string, expectedDraftVersion: number): Promise<SavedReviewDraft> {
  return extractionReviewDraftSchema.parse(
    await requestJson(`/extractions/${extractionId}/review/reset`, 'POST', { expectedDraftVersion }),
  )
}
// Only in-flight writes live here. PostgreSQL owns all persisted review state.
const draftWrites = new Map<string, Promise<SavedReviewDraft>>()
export function saveExtractionReviewDraft(extractionId: string, decisions: readonly ReviewDecisionInput[], version: number): Promise<SavedReviewDraft> {
  const invalid = decisions
    .map((decision) => reviewDecisionInputSchema.safeParse(decision))
    .flatMap((result, index) => (result.success ? [] : [{ decision: decisions[index], error: result.error }]))
  if (invalid.length > 0) {
    const detail = invalid
      .map(
        ({ decision, error }) =>
          `${resultPathKey(decision.resultPath)}: ${error.issues.map((issue) => issue.message).join('; ')}`,
      )
      .join(' | ')
    return Promise.reject(new Error(`invalid_draft: ${detail}`))
  }
  const previous = draftWrites.get(extractionId) ?? Promise.resolve({ version, decisions: [] })
  rememberReviewDraft(extractionId, { version, decisions })
  const write = previous.then(async (saved) => {
    acknowledgeReviewDraft(extractionId, saved.version)
    // A conflict is one state for every caller: the hooks key their reload path on this message.
    const result = extractionReviewDraftSchema.parse(
      await requestJson(`/extractions/${extractionId}/review/draft`, 'POST', { version: saved.version, decisions }).catch((error: unknown) => {
        throw error instanceof Error && error.message.startsWith('review_conflict:') ? new Error(REVIEW_DRAFT_CONFLICT) : error
      }),
    )
    acknowledgeReviewDraft(extractionId, result.version)
    return result
  })
  draftWrites.set(extractionId, write)
  const warn = (event: BeforeUnloadEvent) => event.preventDefault()
  window.addEventListener('beforeunload', warn)
  void write.then(() => {
    if (draftWrites.get(extractionId) === write) forgetReviewDraft(extractionId)
  }).catch(() => {})
  void write.finally(() => {
    if (draftWrites.get(extractionId) === write) draftWrites.delete(extractionId)
    window.removeEventListener('beforeunload', warn)
  }).catch(() => {})
  return write
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
  context: SchemaModelContext,
  instruction: string,
  signal?: AbortSignal,
): Promise<SchemaEditResponse> {
  const form = new FormData()
  form.append('project_context_id', context.projectContextId)
  form.append('extraction_schema_id', context.extractionSchemaId)
  form.append('schema_revision_id', context.schemaRevisionId)
  if (context.sourceRepresentationRevisionId)
    form.append(
      'source_representation_revision_id',
      context.sourceRepresentationRevisionId,
    )
  form.append('instruction', instruction)
  await ensureModelKeysSent()
  return postForm('/edit_schema', form, decodeSchemaEdit, signal)
}
