import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import { ensureModelKeysSent } from '../modelKeys/modelKeyHandoff'
import {
  batchExtractionListResponseSchema,
  batchExtractionOpenResponseSchema,
  batchExtractionResponseSchema,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import {
  batchSchemaSuggestionErrorResponseSchema,
  batchSchemaSuggestionCreateFromSpreadsheetRequestSchema,
  batchSchemaSuggestionCreateRequestSchema,
  batchSchemaSuggestionDraftRequestSchema,
  batchSchemaSuggestionListResponseSchema,
  batchSchemaSuggestionResponseSchema,
  batchSchemaSuggestionRetryRequestSchema,
  batchSchemaSuggestionRunRequestSchema,
  type BatchSchemaSuggestion,
  type BatchSchemaSuggestionFailure,
  type BatchSchemaSuggestionPurpose,
} from '../../shared/batchSchemaSuggestion.contract'
import type { ExtractionMethodIntent } from 'extraction/extraction-method'
import {
  projectSpreadsheetErrorResponseSchema,
  projectSpreadsheetVersionResponseSchema,
  type ProjectSpreadsheetVersion,
} from '../../shared/projectSpreadsheet.contract'
import type { SchemaDefinition } from 'extraction/schema'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import { isRecord } from '../../shared/template'

export class BatchSchemaSuggestionRequestError extends Error {
  readonly status: number
  readonly failure: BatchSchemaSuggestionFailure

  constructor(status: number, failure: BatchSchemaSuggestionFailure) {
    super(failure.message)
    this.name = 'BatchSchemaSuggestionRequestError'
    this.status = status
    this.failure = failure
  }
}
/** A refused Batch Extraction request, with the server's code when it sent one (e.g. `method_changed`). */
export class BatchRequestError extends Error {
  readonly status: number
  readonly code: string | null
  constructor(status: number, code: string | null, message: string) {
    super(message)
    this.name = 'BatchRequestError'
    this.status = status
    this.code = code
  }
}

async function read(url: string, init?: RequestInit): Promise<unknown> {
  const response = await authenticatedFetch(url, init)
  const value: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    if (url.startsWith('/api/batch-schema-suggestions')) {
      const parsed = batchSchemaSuggestionErrorResponseSchema.safeParse(value)
      if (parsed.success)
        throw new BatchSchemaSuggestionRequestError(
          response.status,
          parsed.data.error,
        )
    }
    if (url.startsWith('/api/project-spreadsheets')) {
      const parsed = projectSpreadsheetErrorResponseSchema.safeParse(value)
      if (parsed.success) throw new Error(parsed.data.error.message)
    }
    const error = isRecord(value) && isRecord(value.error) ? value.error : null
    const message =
      typeof error?.message === 'string'
        ? error.message
        : `Batch Extraction request failed (HTTP ${response.status}).`
    if (typeof error?.code === 'string')
      throw new BatchRequestError(response.status, error.code, message)
    throw new Error(message)
  }
  return value
}

export async function listBatchExtractions(
  projectContextId: string,
  signal?: AbortSignal,
): Promise<BatchExtraction[]> {
  const query = new URLSearchParams({ projectContextId, limit: '50' })
  return batchExtractionListResponseSchema.parse(
    await read(`/api/batch-extractions?${query}`, { signal }),
  ).batchExtractions
}

/**
 * Opens one Batch Extraction over the researcher's selection. The server owns
 * its identity and replays an equal selection unless `force` is explicit, and
 * says which of the two it did through `disposition`. `method` is the saved
 * method the start view showed; the server refuses it if an Apply changed it
 * since.
 */
export async function openBatchExtraction(
  request: {
    projectContextId: string
    schemaRevisionId: string
    strategy: ExtractionStrategy
    sourceDocumentIds: readonly string[]
    force?: boolean
    method: ExtractionMethodIntent
  },
  signal?: AbortSignal,
): Promise<ReturnType<typeof batchExtractionOpenResponseSchema.parse>> {
  return batchExtractionOpenResponseSchema.parse(
    await read('/api/batch-extractions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(request),
      signal,
    }),
  )
}

export async function getBatchExtraction(
  projectContextId: string,
  batchExtractionId: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ projectContextId })
  return batchExtractionResponseSchema.parse(
    await read(`/api/batch-extractions/${batchExtractionId}?${query}`, { signal }),
  ).batchExtraction
}

export async function createBatchSchemaSuggestion(
  projectContextId: string,
  sourceDocumentIds: readonly string[],
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
  await ensureModelKeysSent()
  return batchSchemaSuggestionResponseSchema.parse(
    await read('/api/batch-schema-suggestions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        batchSchemaSuggestionCreateRequestSchema.parse({
          projectContextId,
          sourceDocumentIds,
        }),
      ),
      signal,
    }),
  ).batchSchemaSuggestion
}
/** Derives a schema suggestion from the project's current shared
 *  spreadsheet (upload it first with `uploadProjectSpreadsheet`) — ready
 *  immediately, no document sources involved (spreadsheet-schema-
 *  suggestion spec). `separator` splits a column header into a nested
 *  path when given (e.g. "." groups `measurement.temperature` under a
 *  `measurement` object); omit it to keep every column flat.
 *  `inferTypesFromValues` chooses whether each field's type is guessed
 *  from its column's cell values (number/integer/enum/string) or every
 *  field is left as a plain `string`, reading only the header row.
 *  `purpose` chooses whether confirming the suggestion only seeds the
 *  schema (`SCHEMA`) or also populates an Evaluation Corpus version from
 *  this spreadsheet (`SCHEMA_AND_VALIDATE`). */
export async function createSpreadsheetBatchSchemaSuggestion(
  projectContextId: string,
  purpose: BatchSchemaSuggestionPurpose,
  inferTypesFromValues: boolean,
  separator?: string,
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
  return batchSchemaSuggestionResponseSchema.parse(
    await read('/api/batch-schema-suggestions/from-spreadsheet', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        batchSchemaSuggestionCreateFromSpreadsheetRequestSchema.parse({
          projectContextId,
          separator,
          inferTypesFromValues,
          purpose,
        }),
      ),
      signal,
    }),
  ).batchSchemaSuggestion
}
/** Appends a new version to the project's one shared spreadsheet slot —
 *  never replaces a prior version. Used once per upload; the resulting
 *  version is then reused by `createSpreadsheetBatchSchemaSuggestion` and,
 *  later, gold-standard-corpus population, rather than re-uploaded each
 *  time (project-level sharing, per spreadsheet-schema-suggestion design.md). */
export async function uploadProjectSpreadsheet(
  projectContextId: string,
  file: File,
  signal?: AbortSignal,
): Promise<ProjectSpreadsheetVersion> {
  const form = new FormData()
  form.append('file', file, file.name)
  form.append('projectContextId', projectContextId)
  const parsed = projectSpreadsheetVersionResponseSchema.parse(
    await read('/api/project-spreadsheets', {
      method: 'POST',
      headers: { accept: 'application/json' },
      body: form,
      signal,
    }),
  )
  if (!parsed.projectSpreadsheetVersion)
    throw new Error('The uploaded spreadsheet was not saved.')
  return parsed.projectSpreadsheetVersion
}

/** The project's current spreadsheet version, or null if none has been
 *  uploaded yet. */
export async function getCurrentProjectSpreadsheet(
  projectContextId: string,
  signal?: AbortSignal,
): Promise<ProjectSpreadsheetVersion | null> {
  const query = new URLSearchParams({ projectContextId })
  return projectSpreadsheetVersionResponseSchema.parse(
    await read(`/api/project-spreadsheets?${query}`, { signal }),
  ).projectSpreadsheetVersion
}

export async function listBatchSchemaSuggestions(
  projectContextId: string,
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion[]> {
  const query = new URLSearchParams({ projectContextId })
  return batchSchemaSuggestionListResponseSchema.parse(
    await read(`/api/batch-schema-suggestions?${query}`, { signal }),
  ).batchSchemaSuggestions
}

export async function updateBatchSchemaSuggestionDraft(
  projectContextId: string,
  batchSchemaSuggestionId: string,
  definition: SchemaDefinition,
  expectedDraftVersion: number,
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
  const query = new URLSearchParams({ projectContextId })
  return batchSchemaSuggestionResponseSchema.parse(
    await read(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/draft?${query}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(
        batchSchemaSuggestionDraftRequestSchema.parse({
          expectedDraftVersion,
          ...definition,
        }),
      ),
      signal,
    }),
  ).batchSchemaSuggestion
}

/** Runs the suggestion's draft as a Batch Extraction on the saved method the start view showed. */
export async function runBatchSchemaSuggestion(
  projectContextId: string,
  batchSchemaSuggestionId: string,
  strategy: ExtractionStrategy,
  method: ExtractionMethodIntent,
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
  const query = new URLSearchParams({ projectContextId })
  return batchSchemaSuggestionResponseSchema.parse(
    await read(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(batchSchemaSuggestionRunRequestSchema.parse({ strategy, method })),
      signal,
    }),
  ).batchSchemaSuggestion
}

/** Starts the attempt after `expectedAttempt` over every surviving pin. Repeating the POST (an uncertain answer)
 *  returns that same successor rather than starting another; an older attempt answers 409 attempt_conflict. */
export async function retryBatchSchemaSuggestion(
  projectContextId: string,
  batchSchemaSuggestionId: string,
  expectedAttempt: number,
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
  const query = new URLSearchParams({ projectContextId })
  await ensureModelKeysSent()
  return batchSchemaSuggestionResponseSchema.parse(
    await read(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(batchSchemaSuggestionRetryRequestSchema.parse({ expectedAttempt })),
      signal,
    }),
  ).batchSchemaSuggestion
}
