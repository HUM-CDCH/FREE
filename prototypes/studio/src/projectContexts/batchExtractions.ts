import {
  batchExtractionListResponseSchema,
  batchExtractionResponseSchema,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import type { ExtractionStrategy } from '../../shared/extraction.contract'
import {
  batchSchemaSuggestionErrorResponseSchema,
  batchSchemaSuggestionMergeResponseSchema,
  type BatchSchemaSuggestionFailure,
  type BatchSchemaSuggestionMerge,
} from '../../shared/batchSchemaSuggestion.contract'
import { schemaRevisionResponseSchema } from '../../shared/schemaRevision.contract'
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
    if (url === '/api/batch-schema-suggestions') {
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
  return batchExtractionResponseSchema.parse(
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

export async function mergeBatchSchemaSuggestions(
  projectContextId: string,
  sourceDocumentIds: readonly string[],
  signal?: AbortSignal,
): Promise<BatchSchemaSuggestionMerge> {
  return batchSchemaSuggestionMergeResponseSchema.parse(
    await read('/api/batch-schema-suggestions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        action: 'merge',
        projectContextId,
        sourceDocumentIds,
      }),
      signal,
    }),
  )
}

export async function confirmBatchSchemaSuggestion(
  projectContextId: string,
  sourceDocumentIds: readonly string[],
  selectionKey: string,
  definition: SchemaDefinition,
  signal?: AbortSignal,
) {
  return schemaRevisionResponseSchema.parse(
    await read('/api/batch-schema-suggestions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        action: 'confirm',
        projectContextId,
        sourceDocumentIds,
        selectionKey,
        ...definition,
      }),
      signal,
    }),
  ).revision
}
