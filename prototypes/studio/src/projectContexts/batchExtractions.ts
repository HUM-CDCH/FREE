import { authenticatedFetch } from '../auth/authenticatedFetch.ts'
import { ensureModelKeysSent } from '../modelKeys/modelKeyHandoff'
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
  batchSchemaSuggestionCreateRequestSchema,
  batchSchemaSuggestionDraftRequestSchema,
  batchSchemaSuggestionListResponseSchema,
  batchSchemaSuggestionResponseSchema,
  batchSchemaSuggestionRunRequestSchema,
  type BatchSchemaSuggestion,
  type BatchSchemaSuggestionFailure,
} from '../../shared/batchSchemaSuggestion.contract'
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
  await ensureModelKeysSent()
  return batchSchemaSuggestionResponseSchema.parse(
    await read(`/api/batch-schema-suggestions/${batchSchemaSuggestionId}/retry?${query}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal,
    }),
  ).batchSchemaSuggestion
}
