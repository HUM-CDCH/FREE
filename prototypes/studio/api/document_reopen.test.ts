import { describe, expect, it, vi } from 'vitest'
import type { DocumentReopenSnapshot } from '../../../packages/db/src/project-store.js'
import { documentReopenResponseSchema } from '../shared/projectContext.contract.js'
import { createGetDocumentReopen } from './document_reopen.js'

const projectId = '11111111-1111-4111-8111-111111111111'
const documentId = '22222222-2222-4222-8222-222222222222'
const latestRepresentationId = '33333333-3333-4333-8333-333333333333'
const latestSchemaId = '55555555-5555-4555-8555-555555555555'
const reviewedSchemaId = '66666666-6666-4666-8666-666666666666'

function attempt(
  extractionId: string,
  representationId: string,
  schemaRevisionId: string,
  reviewedAt: Date | null,
) {
  return {
    extractionId,
    sourceDocumentId: documentId,
    sourceRepresentationRevisionId: representationId,
    sourceRepresentationRevisionNumber: representationId === latestRepresentationId ? 2 : 1,
    schemaRevisionId,
    extractionSchemaId: '77777777-7777-4777-8777-777777777777',
    schemaRevisionNumber: schemaRevisionId === latestSchemaId ? 2 : 1,
    schemaTree: {
      recordDescription: 'One title record.',
      schemaNodes: [{ id: 'title', name: 'title', type: 'string' as const }],
    },
    createdAt: new Date(reviewedAt ? '2026-08-10T00:00:00Z' : '2026-08-10T01:00:00Z'),
    reviewedAt,
    strategy: 'ARTICLE' as const,
    outcome: 'SUCCEEDED' as const,
    complete: true,
    modelAttribution: { provider: 'ollama', modelId: 'fixture' },
    diagnostics: { phase: 'grounding', durationMs: 1, modelCalls: 0, finishReason: null, inputTokens: null, outputTokens: null, values: null, grounding: null },
    resultPayload: { records: [{ title: 'Ellekilde' }] },
    evidenceLinks: reviewedAt ? [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }] : [],
    failure: null,
    reviewable: true,
    retryOfId: null,
    batchExtractionId: null,
    reviewDecisions: reviewedAt
      ? [{ reviewDecisionId: '88888888-8888-4888-8888-888888888888', evidenceAnchorId: 'anchor-1', reviewedOccurrenceIds: ['occurrence-1'] }]
      : [],
  }
}

function snapshot(): DocumentReopenSnapshot {
  return {
    projectContext: { projectContextId: projectId, name: 'Project', createdAt: new Date('2026-08-10T00:00:00Z') },
    sourceDocument: { sourceDocumentId: documentId, name: 'source.pdf', createdAt: new Date('2026-08-10T00:00:00Z') },
    sourceRepresentation: { sourceRepresentationId: latestRepresentationId, revisionNumber: 2, createdAt: new Date('2026-08-10T01:00:00Z') },
    annotationSet: null,
    extractionSchema: {
      extractionSchemaId: '77777777-7777-4777-8777-777777777777',
      schemaRevisionId: latestSchemaId,
      revisionNumber: 2,
      schemaTree: {
        recordDescription: 'One title record.',
        schemaNodes: [{ id: 'title', name: 'title', type: 'string' }],
      },
    },
    latestAttempt: attempt('99999999-9999-4999-8999-999999999999', latestRepresentationId, latestSchemaId, null),
    latestReviewed: attempt('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', latestRepresentationId, reviewedSchemaId, new Date('2026-08-10T00:30:00Z')),
  }
}

describe('document reopen Article attempts', () => {
  it('returns current-representation attempts with their schema pins', async () => {
    const handler = createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return snapshot()
      },
    })
    const response = await handler(
      new Request(`http://studio/api/project-contexts/${projectId}/source-documents/${documentId}/reopen`),
    )
    const body = documentReopenResponseSchema.parse(await response.json())

    expect(response.status).toBe(200)
    if (!body.latestAttempt || !body.latestReviewed)
      throw new Error('Expected both reopen snapshots.')
    expect(body.latestAttempt.sourceRepresentationRevisionId).toBe(latestRepresentationId)
    expect(body.latestAttempt.schemaRevisionId).toBe(latestSchemaId)
    expect(body.latestAttempt.sourceRepresentation.resources.sourcePdfUrl).toContain(latestRepresentationId)
    expect(body.latestAttempt.sourceRepresentation.resources.sourcePdfUrl).toContain(
      '?v=2026-08-10T01%3A00%3A00.000Z',
    )
    expect(body.latestReviewed.sourceRepresentationRevisionId).toBe(latestRepresentationId)
    expect(body.latestReviewed.schemaRevisionId).toBe(reviewedSchemaId)
    expect(body.latestReviewed.sourceRepresentation.resources.sourcePdfUrl).toContain(latestRepresentationId)
    expect(body.latestReviewed.sourceRepresentation.resources.sourcePdfUrl).toContain(
      '?v=2026-08-10T01%3A00%3A00.000Z',
    )
  })

  it('reopens a requested Extraction in the full document workspace', async () => {
    const getDocumentReopenSnapshot = vi.fn(async () => snapshot())
    const response = await createGetDocumentReopen({
      getDocumentReopenSnapshot,
    })(
      new Request(
        `http://studio/api/project-contexts/${projectId}/source-documents/${documentId}/reopen?extractionId=99999999-9999-4999-8999-999999999999`,
      ),
    )

    expect(response.status).toBe(200)
    expect(getDocumentReopenSnapshot).toHaveBeenCalledWith(
      projectId,
      documentId,
      '99999999-9999-4999-8999-999999999999',
    )
  })

  it('fails closed for an unreadable schema tree', async () => {
    const stored = snapshot()
    stored.extractionSchema!.schemaTree = { schemaNodes: 'not-an-array' }
    const response = await createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return stored
      },
    })(
      new Request(
        `http://studio/api/project-contexts/${projectId}/source-documents/${documentId}/reopen`,
      ),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'persistence_unavailable' },
    })
  })

  it('fails closed for invalid stored Evidence paths', async () => {
    const stored = snapshot()
    stored.latestAttempt!.evidenceLinks = [
      {
        resultPath: ['records', 99, 'title'],
        evidenceAnchorId: 'anchor-1',
      },
    ]
    const response = await createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return stored
      },
    })(
      new Request(
        `http://studio/api/project-contexts/${projectId}/source-documents/${documentId}/reopen`,
      ),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'persistence_unavailable' },
    })
  })

  it('fails closed for incomplete stored Review Decisions', async () => {
    const stored = snapshot()
    stored.latestReviewed!.reviewDecisions = []
    const response = await createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return stored
      },
    })(
      new Request(
        `http://studio/api/project-contexts/${projectId}/source-documents/${documentId}/reopen`,
      ),
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'persistence_unavailable' },
    })
  })

  it('returns not found when the durable snapshot is missing', async () => {
    const response = await createGetDocumentReopen({
      async getDocumentReopenSnapshot() {
        return null
      },
    })(
      new Request(
        `http://studio/api/project-contexts/${projectId}/source-documents/${documentId}/reopen`,
      ),
    )

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'not_found' },
    })
  })
})
