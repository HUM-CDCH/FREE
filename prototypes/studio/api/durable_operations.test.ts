import { describe, expect, it, vi } from 'vitest'
import type {
  BatchExtractionRecord,
  BatchSchemaSuggestionRecord,
} from '../../../packages/db/src/project-store.js'
import { createBatchExtractionsApi } from './batch_extractions.js'
import { createBatchSchemaSuggestionsApi } from './batch_schema_suggestions.js'

const projectContextId = '51000000-0000-4000-8000-000000000001'
const sourceDocumentId = '51000000-0000-4000-8001-000000000001'
const representationRevisionId = '51000000-0000-4000-8002-000000000001'
const schemaRevisionId = '51000000-0000-4000-8004-000000000001'
const batchExtractionId = '51000000-0000-4000-8007-000000000001'
const suggestionId = '51000000-0000-4000-8008-000000000001'

const now = new Date('2026-08-15T10:00:00.000Z')

const batch = {
  batchExtractionId,
  projectContextId,
  schemaRevisionId,
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  extractionSchemaName: 'Places',
  schemaRevisionNumber: 1,
  strategy: 'ARTICLE',
  executionStatus: 'QUEUED',
  executionFailure: null,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  members: [
    {
      sourceDocumentId,
      sourceRepresentationRevisionId: representationRevisionId,
      executionStatus: 'QUEUED',
      executionFailure: null,
      startedAt: null,
      finishedAt: null,
      latestExtraction: null,
    },
  ],
} as unknown as BatchExtractionRecord

const suggestion = {
  batchSchemaSuggestionId: suggestionId,
  projectContextId,
  selectionKey: 'a'.repeat(64),
  executionStatus: 'QUEUED',
  phase: 'SOURCES',
  proposal: null,
  coverage: null,
  draft: null,
  draftVersion: 0,
  failure: null,
  confirmedSchemaRevisionId: null,
  batchExtractionId: null,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  sources: [
    {
      sourceDocumentId,
      sourceRepresentationRevisionId: representationRevisionId,
      executionStatus: 'QUEUED',
      definition: null,
      failure: null,
      startedAt: null,
      finishedAt: null,
    },
  ],
} as unknown as BatchSchemaSuggestionRecord

describe('durable operation APIs', () => {
  it('persists and schedules a Batch Extraction before returning its snapshot', async () => {
    const createBatchExtraction = vi.fn(async () => ({
      status: 'created' as const,
      batch,
    }))
    const kick = vi.fn()
    const handler = createBatchExtractionsApi(
      { createBatchExtraction } as never,
      { kick },
    )

    const response = await handler(
      new Request('http://studio.test/api/batch-extractions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projectContextId,
          schemaRevisionId,
          strategy: 'ARTICLE',
          sourceDocumentIds: [sourceDocumentId],
        }),
      }),
    )

    expect(response.status).toBe(202)
    expect(createBatchExtraction).toHaveBeenCalledOnce()
    expect(kick).toHaveBeenCalledOnce()
    await expect(response.json()).resolves.toMatchObject({
      batchExtraction: {
        batchExtractionId,
        executionStatus: 'QUEUED',
        members: [{ executionStatus: 'QUEUED' }],
      },
    })
  })

  it('replays an unforced selection and opens a fresh Batch Extraction when the researcher forces it', async () => {
    const openedIds: string[] = []
    const createBatchExtraction = vi.fn(
      async (_: string, input: { batchExtractionId: string }) => {
        openedIds.push(input.batchExtractionId)
        return openedIds.length === 1
          ? { status: 'replayed' as const, batch }
          : { status: 'created' as const, batch }
      },
    )
    const handler = createBatchExtractionsApi(
      { createBatchExtraction } as never,
      { kick: vi.fn() },
    )
    const open = (force?: boolean) =>
      handler(
        new Request('http://studio.test/api/batch-extractions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            projectContextId,
            schemaRevisionId,
            strategy: 'ARTICLE',
            sourceDocumentIds: [sourceDocumentId],
            ...(force === undefined ? {} : { force }),
          }),
        }),
      )

    const replayed = await open()
    const forced = await open(true)

    await expect(replayed.json()).resolves.toMatchObject({
      disposition: 'replayed',
    })
    await expect(forced.json()).resolves.toMatchObject({
      disposition: 'created',
    })
    expect(openedIds[1]).not.toBe(openedIds[0])
    // The fingerprint identity is stable, so only the forced open may differ.
    expect((await open()).status).toBe(202)
    expect(openedIds[2]).toBe(openedIds[0])
  })

  it('persists and schedules a schema suggestion without waiting for its model work', async () => {
    const createBatchSchemaSuggestion = vi.fn(async () => ({
      status: 'created' as const,
      suggestion,
    }))
    const kick = vi.fn()
    const handler = createBatchSchemaSuggestionsApi(
      { createBatchSchemaSuggestion } as never,
      { kick },
    )

    const response = await handler(
      new Request('http://studio.test/api/batch-schema-suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectContextId, sourceDocumentIds: [sourceDocumentId] }),
      }),
    )

    expect(response.status).toBe(202)
    expect(createBatchSchemaSuggestion).toHaveBeenCalledWith(projectContextId, [
      sourceDocumentId,
    ])
    expect(kick).toHaveBeenCalledOnce()
    await expect(response.json()).resolves.toMatchObject({
      batchSchemaSuggestion: {
        batchSchemaSuggestionId: suggestionId,
        executionStatus: 'QUEUED',
        phase: 'SOURCES',
      },
    })
  })

  it('rejects the removed request-scoped merge protocol', async () => {
    const createBatchSchemaSuggestion = vi.fn()
    const handler = createBatchSchemaSuggestionsApi(
      { createBatchSchemaSuggestion } as never,
      { kick: vi.fn() },
    )

    const response = await handler(
      new Request('http://studio.test/api/batch-schema-suggestions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'merge',
          projectContextId,
          sourceDocumentIds: [sourceDocumentId],
        }),
      }),
    )

    expect(response.status).toBe(422)
    expect(createBatchSchemaSuggestion).not.toHaveBeenCalled()
  })

  it('retries a previously confirmed schema suggestion', async () => {
    const retryBatchSchemaSuggestion = vi.fn(async () => ({
      status: 'retried' as const,
      suggestion,
    }))
    const kick = vi.fn()
    const handler = createBatchSchemaSuggestionsApi(
      { retryBatchSchemaSuggestion } as never,
      { kick },
    )

    const response = await handler(
      new Request(
        `http://studio.test/api/batch-schema-suggestions/${suggestionId}/retry?projectContextId=${projectContextId}`,
        { method: 'POST' },
      ),
    )

    expect(response.status).toBe(202)
    await expect(response.json()).resolves.toMatchObject({
      batchSchemaSuggestion: {
        batchSchemaSuggestionId: suggestionId,
        executionStatus: 'QUEUED',
      },
    })
    expect(kick).toHaveBeenCalledOnce()
    expect(retryBatchSchemaSuggestion).toHaveBeenCalledWith(
      projectContextId,
      suggestionId,
    )
  })
})
