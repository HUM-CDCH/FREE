import {
  batchExtractionListResponseSchema,
  batchExtractionResponseSchema,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
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
import type { SchemaDefinition } from '../../shared/schemaNode'
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
  const response = await fetch(url, init)
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
 * its identity and replays an equal selection unless `force` is explicit.
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
): Promise<ReturnType<typeof batchExtractionResponseSchema.parse>> {
  const opened = batchExtractionResponseSchema.parse(
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
  // Compatibility for the retiring panel actor. Durable member failures now
  // live on the operation snapshot, not on this transient response.
  return { ...opened, disposition: 'running' as const, memberFailures: [] }
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

export async function retryBatchExtraction(
  projectContextId: string,
  batchExtractionId: string,
  signal?: AbortSignal,
) {
  const query = new URLSearchParams({ projectContextId })
  return batchExtractionResponseSchema.parse(
    await read(`/api/batch-extractions/${batchExtractionId}/retry?${query}`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal,
    }),
  ).batchExtraction
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

