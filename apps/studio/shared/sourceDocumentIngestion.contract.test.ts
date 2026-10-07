import { describe, expect, it } from 'vitest'
import {
  isLiveIngestion,
  sourceDocumentIngestionResponseSchema,
  sourceIngestionAdmittedSchema,
  sourceIngestionListingSchema,
} from './sourceDocumentIngestion.contract'

const common = {
  workflowId: 'ingest:51000000-0000-4000-8000-000000000001:51000000-0000-4000-8005-000000000001',
  name: 'Beretning.pdf',
  createdAt: '2026-09-27T10:00:00.000Z',
}
const at = { completedAt: '2026-09-27T10:05:00.000Z' }

describe('source ingestion contracts', () => {
  it('admits with a workflow identity and nothing that claims a document exists', () => {
    expect(sourceIngestionAdmittedSchema.parse({ workflowId: common.workflowId })).toEqual({ workflowId: common.workflowId })
    expect(() => sourceIngestionAdmittedSchema.parse({ workflowId: common.workflowId, status: 'queued' })).toThrow()
  })

  it('keeps the completed upload response unchanged', () => {
    expect(Object.keys(sourceDocumentIngestionResponseSchema.shape).sort()).toEqual(
      ['createdAt', 'name', 'pageCount', 'revisionNumber', 'sourceDocumentId', 'sourceRepresentationId'],
    )
  })

  it('lists live, succeeded and failed attempts, each with the fields its status needs, and the absent IDs', () => {
    const listing = sourceIngestionListingSchema.parse({
      ingestions: [
        { ...common, status: 'queued' },
        { ...common, status: 'parsing' },
        { ...common, status: 'succeeded', ...at, sourceDocumentId: '51000000-0000-4000-8001-000000000001' },
        { ...common, status: 'failed', ...at, failure: { code: 'source_ingestion_failed', message: 'kei refused the PDF.' } },
      ],
      absent: ['ingest:gone'],
    })
    expect(listing.ingestions.map(isLiveIngestion)).toEqual([true, true, false, false])
    expect(listing.absent).toEqual(['ingest:gone'])
  })

  it('refuses a failure without its reason, a success without a canonical document, extra fields and oversized text', () => {
    for (const ingestion of [
      { ...common, status: 'failed', ...at },
      { ...common, status: 'succeeded', ...at },
      { ...common, status: 'succeeded', ...at, sourceDocumentId: 'not-a-uuid' },
      { ...common, status: 'queued', failure: null },
      { ...common, status: 'failed', ...at, failure: { code: 'x'.repeat(129), message: 'm' } },
      { ...common, status: 'failed', ...at, failure: { code: 'c', message: 'm'.repeat(513) } },
      { ...common, createdAt: '2026-09-27T10:00:00.000+02:00', status: 'queued' },
    ])
      expect(sourceIngestionListingSchema.safeParse({ ingestions: [ingestion], absent: [] }).success).toBe(false)
    expect(sourceIngestionListingSchema.safeParse({ ingestions: [] }).success).toBe(false)
  })
})
