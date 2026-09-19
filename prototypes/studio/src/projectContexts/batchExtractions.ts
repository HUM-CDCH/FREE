import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import {
  batchExtractionListResponseSchema,
  batchExtractionOpenResponseSchema,
  batchExtractionResponseSchema,
  batchExtractionResultsResponseSchema,
  type BatchExtraction,
  type BatchExtractionResults,
} from '../../shared/batchExtraction.contract'
import {
  batchSchemaSuggestionErrorResponseSchema,
  batchSchemaSuggestionCreateFromSpreadsheetRequestSchema,
  batchSchemaSuggestionCreateRequestSchema,
  batchSchemaSuggestionDraftRequestSchema,
  batchSchemaSuggestionListResponseSchema,
  batchSchemaSuggestionResponseSchema,
  batchSchemaSuggestionRunRequestSchema,
  type BatchSchemaSuggestion,
  type BatchSchemaSuggestionFailure,
  type BatchSchemaSuggestionPurpose,
} from '../../shared/batchSchemaSuggestion.contract'
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
    throw new Error(
      typeof error?.message === 'string'
        ? error.message
        : `Batch Extraction request failed (HTTP ${response.status}).`,
    )
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
 * says which of the two it did through `disposition`.
 */
export async function openBatchExtraction(
  request: {
    projectContextId: string
    schemaRevisionId: string
    strategy: ExtractionStrategy
    sourceDocumentIds: readonly string[]
    force?: boolean
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

/**
 * The Extraction Results this Batch Extraction has produced, in member order.
 * Members without a result are absent, so the export never invents empty rows.
 */
export async function getBatchExtractionResults(
  projectContextId: string,
  batchExtractionId: string,
  signal?: AbortSignal,
): Promise<BatchExtractionResults> {
  const query = new URLSearchParams({ projectContextId })
  return batchExtractionResultsResponseSchema.parse(
    await read(`/api/batch-extractions/${batchExtractionId}/results?${query}`, {
      signal,
    }),
  )
}

export async function createBatchSchemaSuggestion(
  projectContextId: string,
  sourceDocumentIds: readonly string[],
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
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
 *  `measurement` object); omit it to keep every column flat. `purpose`
 *  chooses whether confirming the suggestion only seeds the schema
 *  (`SCHEMA`) or also populates an Evaluation Corpus version from this
 *  spreadsheet (`SCHEMA_AND_VALIDATE`). */
export async function createSpreadsheetBatchSchemaSuggestion(
  projectContextId: string,
  purpose: BatchSchemaSuggestionPurpose,
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

export async function runBatchSchemaSuggestion(
  projectContextId: string,
  batchSchemaSuggestionId: string,
  strategy: ExtractionStrategy,
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
  const query = new URLSearchParams({ projectContextId })
  return batchSchemaSuggestionResponseSchema.parse(
    await read(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/run?${query}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(batchSchemaSuggestionRunRequestSchema.parse({ strategy })),
      signal,
    }),
  ).batchSchemaSuggestion
}

export async function retryBatchSchemaSuggestion(
  projectContextId: string,
  batchSchemaSuggestionId: string,
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestion> {
  const query = new URLSearchParams({ projectContextId })
  return batchSchemaSuggestionResponseSchema.parse(
    await read(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?${query}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal,
    }),
  ).batchSchemaSuggestion
}
