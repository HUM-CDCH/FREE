import { describe, expect, it, vi } from 'vitest'
import type { ExtractionAttemptSnapshot, ExtractionModule } from 'extraction'
import type { DocumentReopenSnapshot } from '../../../packages/db/src/project-store.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { createGetDocumentReopen } from './document_reopen.js'

const projectId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const representationId = '33333333-3333-4333-8333-333333333333'
const schemaRevisionId = '55555555-5555-4555-8555-555555555555'
const extractionId = '99999999-9999-4999-8999-999999999999'
const extractionSchemaId = '77777777-7777-4777-8777-777777777777'
/** The revision that reprocessing publishes after `representationId`. */
const reprocessedRepresentationId = '44444444-4444-4444-8444-444444444444'
const definition = {
  recordDescription: 'One title record.',
  schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
}

const extraction: ExtractionAttemptSnapshot = {
  extractionId,
  sourceDocumentId: documentId,
  sourceRepresentationRevisionId: representationId,
  sourceRepresentationRevisionNumber: 2,
  schemaRevisionId,
  extractionSchemaId,
  schemaRevisionNumber: 2,
  strategy: 'ARTICLE',
  catalogRecipe: null,
  executionStatus: 'COMPLETED',
  outcome: 'SUCCEEDED',
  complete: true,
  modelAttribution: { provider: 'openai', modelId: 'fixture' },
  diagnostics: {
    phase: 'grounding',
    durationMs: 1,
    modelCalls: 1,
    finishReason: 'stop',
    inputTokens: 1,
    outputTokens: 1,
    ungroundedPaths: [],
    groundingIssues: [],
    groundingBatches: [],
    unverifiedFields: [],
    catalog: null,
  },
  result: { records: [{ title: 'Ellekilde' }] },
  evidence: [
    { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' },
  ],
  failure: null,
  reviewable: true,
  batchExtractionId: null,
  createdAt: new Date('2026-08-10T01:00:00Z'),
  reviewedAt: new Date('2026-08-10T01:30:00Z'),
  reviewDecisions: [
    {
      resultPath: ['records', 0, 'title'],
      evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'],
      action: 'APPROVED',
      reviewedValue: null,
      createdAt: new Date('2026-08-10T01:30:00Z'),
    },
  ],
}

function snapshot(schemaTree: unknown = definition): DocumentReopenSnapshot {
  return {
    projectContext: {
      projectContextId: projectId,
      name: 'Project',
      createdAt: new Date('2026-08-10T00:00:00Z'),
    },
    sourceDocument: {
      sourceDocumentId: documentId,
      name: 'source.pdf',
      createdAt: new Date('2026-08-10T00:00:00Z'),
    },
    sourceRepresentation: {
      sourceRepresentationId: representationId,
      revisionNumber: 2,
      createdAt: new Date('2026-08-10T01:00:00Z'),
    },
    annotationSet: null,
    extractionSchema: {
      extractionSchemaId,
      name: 'Titles',
      schemaRevisionId,
      revisionNumber: 2,
      schemaTree,
      recordScope: 'document',
      sourceCoverage: null,
    },
  }
}

function extractionModule(overrides: Partial<ExtractionModule> = {}) {
  return {
    runSingle: vi.fn(),
    cancelSingle: vi.fn(),
    prepareReview: vi.fn(),
    finalizeReview: vi.fn(),
    readDocumentExtractions: vi.fn(async () => ({
      sourceRepresentationRevisionId: representationId,
      latestAttempt: extraction,
      latestReviewed: extraction,
    })),
    scheduleBatch: vi.fn(),
    scheduleSuggestedBatch: vi.fn(),
    listBatches: vi.fn(),
    readBatch: vi.fn(),
    readBatchResults: vi.fn(),
    retryBatch: vi.fn(),
    ...overrides,
  } as ExtractionModule
}

const url = (query = '') =>
  new Request(
    `http://studio/api/project-contexts/${projectId}/source-documents/${documentId}/reopen${query}`,
  )

describe('document reopen ExtractionModule projection', () => {
  it.each(['', `?extractionId=${extractionId}`])('opens the current schema for editing while preserving extraction pins (%s)', async (query) => {
    const current = snapshot({ ...definition, recordDescription: 'Updated description.' })
    current.extractionSchema = {
      ...current.extractionSchema!,
      schemaRevisionId: '66666666-6666-4666-8666-666666666666',
      revisionNumber: 3,
    }
    const response = await createGetDocumentReopen({
      getDocumentReopenSnapshot: vi.fn(async (_project: string, _document: string, pins?: unknown) =>
        pins ? snapshot() : current),
    }, extractionModule())(url(query))
    const body = documentReopenResponseSchema.parse(await response.json())

    expect(body.extractionSchema).toMatchObject({
      schemaRevisionId: current.extractionSchema.schemaRevisionId,
      revisionNumber: 3,
      recordDescription: 'Updated description.',
    })
    for (const attempt of [body.latestAttempt, body.latestReviewed]) {
      expect(attempt).toMatchObject({
        schemaRevisionId,
        extractionSchema: { revisionNumber: 2, ...definition },
      })
    }
  })

  it('reopens the current schema and each attempt\'s pinned schema with their own record scopes', async () => {
    const current = snapshot()
    current.extractionSchema = { ...current.extractionSchema!, schemaRevisionId: '66666666-6666-4666-8666-666666666666',
      revisionNumber: 3, recordScope: 'records' }
    const pinned = snapshot()
    pinned.extractionSchema = { ...pinned.extractionSchema!, recordScope: null }
    const response = await createGetDocumentReopen({
      getDocumentReopenSnapshot: vi.fn(async (_project: string, _document: string, pins?: unknown) => pins ? pinned : current),
    }, extractionModule())(url())
    const body = documentReopenResponseSchema.parse(await response.json())
    expect(body.extractionSchema).toMatchObject({ revisionNumber: 3, recordScope: 'records', ...definition })
    for (const attempt of [body.latestAttempt, body.latestReviewed])
      expect(attempt?.extractionSchema).toEqual({ extractionSchemaId, revisionNumber: 2, ...definition, recordScope: null })
  })

  it('refuses a stored scope other than document or records as unreadable state', async () => {
    const current = snapshot()
    current.extractionSchema = { ...current.extractionSchema!, recordScope: 'catalog' as never }
    const response = await createGetDocumentReopen({ getDocumentReopenSnapshot: vi.fn(async () => current) },
      extractionModule())(url())
    expect(response.status).toBe(503)
  })

  it('opens the current schema with the source declaration its revision was saved with; an unreadable one is not recorded', async () => {
    const excerpted = { complete: false, sourceCharacters: 50_040, omitted: [{ page: 1, start: 23_000, end: 27_040 }] }
    const reopen = async (sourceCoverage: unknown) => {
      const current = snapshot()
      current.extractionSchema = { ...current.extractionSchema!, sourceCoverage }
      const response = await createGetDocumentReopen({ getDocumentReopenSnapshot: vi.fn(async () => current) },
        extractionModule())(url())
      return documentReopenResponseSchema.parse(await response.json()).extractionSchema?.sourceCoverage
    }

    expect(await reopen(excerpted)).toEqual(excerpted)
    expect(await reopen({ complete: true })).toEqual({ complete: true })
    expect(await reopen(null)).toBeNull()
    expect(await reopen([{ nodeId: 'legacy', present: 1, total: 2 }])).toBeNull()
  })

  it('combines source/schema state with module-owned latest attempts', async () => {
    const getDocumentReopenSnapshot = vi.fn(async () => snapshot())
    const module = extractionModule()
    const response = await createGetDocumentReopen(
      { getDocumentReopenSnapshot },
      module,
    )(url())
    const body = documentReopenResponseSchema.parse(await response.json())

    expect(response.status).toBe(200)
    expect(module.readDocumentExtractions).toHaveBeenCalledWith({
      sourceDocumentId: documentId,
    })
    expect(body.latestAttempt).toMatchObject({
      extractionId,
      sourceRepresentationRevisionId: representationId,
      schemaRevisionId,
      resultPayload: extraction.result,
    })
    expect(body.latestReviewed?.reviewDecisions).toEqual(
      extraction.reviewDecisions.map((decision) => ({
        ...decision,
        createdAt: decision.createdAt.toISOString(),
      })),
    )
    expect(
      body.latestAttempt?.sourceRepresentation.resources.sourcePdfUrl,
    ).toContain(
      `/api/project-contexts/${projectId}/source-representations/${representationId}/pdf?v=2026-08-10T01%3A00%3A00.000Z`,
    )
  })

  it.each([
    { reopen: 'a plain reopen without Extractions', query: '', attempt: null, head: representationId, current: true },
    { reopen: 'a plain reopen', query: '', attempt: extraction, head: representationId, current: true },
    {
      reopen: 'a reopen by an Extraction on the current revision',
      query: `?extractionId=${extractionId}`,
      attempt: extraction,
      head: representationId,
      current: true,
    },
    {
      reopen: 'a reopen by an Extraction on a superseded revision',
      query: `?extractionId=${extractionId}`,
      attempt: extraction,
      head: reprocessedRepresentationId,
      current: false,
    },
  ])('states whether $reopen opens the current Source Representation', async ({ query, attempt, head, current }) => {
    const pinned = snapshot()
    // The unpinned read is the Source Document's current snapshot.
    const currentSnapshot: DocumentReopenSnapshot = head === representationId
      ? pinned
      : {
          ...pinned,
          sourceRepresentation: {
            sourceRepresentationId: head,
            revisionNumber: 3,
            createdAt: new Date('2026-08-11T00:00:00Z'),
          },
        }
    const response = await createGetDocumentReopen(
      {
        getDocumentReopenSnapshot: vi.fn(async (_project: string, _document: string, pins?: unknown) =>
          pins ? pinned : currentSnapshot),
      },
      extractionModule({
        readDocumentExtractions: vi.fn(async () => ({
          sourceRepresentationRevisionId: representationId,
          latestAttempt: attempt,
          latestReviewed: attempt,
        })),
      }),
    )(url(query))
    const body = documentReopenResponseSchema.parse(await response.json())

    expect(response.status).toBe(200)
    expect(body.sourceRepresentation).toMatchObject({
      sourceRepresentationId: representationId,
      revisionNumber: 2,
      current,
    })
  })

  it('asks the module for a requested Extraction and pins the source snapshot read', async () => {
    const getDocumentReopenSnapshot = vi.fn(async () => snapshot())
    const module = extractionModule()
    const response = await createGetDocumentReopen(
      { getDocumentReopenSnapshot },
      module,
    )(url(`?extractionId=${extractionId}`))

    expect(response.status).toBe(200)
    expect(module.readDocumentExtractions).toHaveBeenCalledWith({
      sourceDocumentId: documentId,
      extractionId,
    })
    expect(getDocumentReopenSnapshot).toHaveBeenCalledWith(
      projectId,
      documentId,
      {
        sourceRepresentationRevisionId: representationId,
        schemaRevisionId,
      },
    )
  })

  it('fails closed before extraction reads when the project/source is inaccessible', async () => {
    const module = extractionModule()
    const response = await createGetDocumentReopen(
      { getDocumentReopenSnapshot: vi.fn(async () => null) },
      module,
    )(url(`?extractionId=${extractionId}`))

    expect(response.status).toBe(404)
    expect(module.readDocumentExtractions).not.toHaveBeenCalled()
  })

  it('rejects mixed-owner extraction pins with the existing not-found shape', async () => {
    const getDocumentReopenSnapshot = vi.fn(
      async (
        _projectContextId: string,
        _sourceDocumentId: string,
        pins?: unknown,
      ) => (pins ? null : snapshot()),
    )
    const response = await createGetDocumentReopen(
      { getDocumentReopenSnapshot },
      extractionModule(),
    )(url(`?extractionId=${extractionId}`))

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    })
  })

  it('fails closed for unreadable schema state and missing module authority', async () => {
    const invalidSchema = await createGetDocumentReopen(
      {
        getDocumentReopenSnapshot: vi.fn(async () =>
          snapshot({ schemaNodes: 'not-an-array' }),
        ),
      },
      extractionModule(),
    )(url())
    expect(invalidSchema.status).toBe(503)
    await expect(invalidSchema.json()).resolves.toMatchObject({
      error: { code: 'persistence_unavailable' },
    })

    const missing = await createGetDocumentReopen(
      { getDocumentReopenSnapshot: vi.fn(async () => snapshot()) },
      extractionModule({
        readDocumentExtractions: vi.fn(async () => null),
      }),
    )(url(`?extractionId=${extractionId}`))
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    })
  })
})
