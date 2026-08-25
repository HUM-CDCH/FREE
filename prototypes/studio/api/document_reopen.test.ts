import { describe, expect, it, vi } from 'vitest'
import type { ExtractionModule, ExtractionSnapshot } from 'extraction'
import type { DocumentReopenSnapshot } from '../../../packages/db/src/project-store.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { createGetDocumentReopen } from './document_reopen.js'

const projectId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const representationId = '33333333-3333-4333-8333-333333333333'
const schemaRevisionId = '55555555-5555-4555-8555-555555555555'
const extractionId = '99999999-9999-4999-8999-999999999999'
const extractionSchemaId = '77777777-7777-4777-8777-777777777777'
const definition = {
  recordDescription: 'One title record.',
  schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
}

const extraction: ExtractionSnapshot = {
  extractionId,
  sourceDocumentId: documentId,
  sourceRepresentationRevisionId: representationId,
  sourceRepresentationRevisionNumber: 2,
  schemaRevisionId,
  extractionSchemaId,
  schemaRevisionNumber: 2,
  strategy: 'ARTICLE',
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
  },
  result: { records: [{ title: 'Ellekilde' }] },
  evidence: [
    { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' },
  ],
  failure: null,
  reviewable: true,
  retryOfId: null,
  batchExtractionId: null,
  createdAt: new Date('2026-08-10T01:00:00Z'),
  reviewedAt: new Date('2026-08-10T01:30:00Z'),
  reviewDecisions: [
    {
      evidenceAnchorId: 'anchor-1',
      reviewedOccurrenceIds: ['occurrence-1'],
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
      extraction.reviewDecisions,
    )
    expect(body.latestAttempt?.sourceRepresentation.resources.sourcePdfUrl).toContain(
      `${representationId}/pdf?v=2026-08-10T01%3A00%3A00.000Z`,
    )
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
