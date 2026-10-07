import { describe, expect, it } from 'vitest'
import type { BatchExtractionMember } from '../../shared/batchExtraction.contract'
import { memberStatus } from './batchExtractionStatus'

const member: BatchExtractionMember = {
  extractionId: '51000000-0000-4000-8006-000000000001',
  sourceDocumentId: '51000000-0000-4000-8001-000000000001',
  sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
  executionStatus: 'QUEUED',
  completed: false,
  reviewable: false,
  currentReview: null,
}

describe('a Batch Extraction member status', () => {
  it('names each durable lifecycle state with its tone', () => {
    expect(memberStatus(member)).toEqual({ label: 'Queued', tone: 'neutral', message: null })
    expect(memberStatus({ ...member, executionStatus: 'RUNNING' }).tone).toBe('accent')
    expect(memberStatus({ ...member, executionStatus: 'PAUSING' }).tone).toBe('accent')
    expect(memberStatus({ ...member, executionStatus: 'FAILED' })).toMatchObject({ label: 'Failed', tone: 'danger' })
    expect(memberStatus({ ...member, executionStatus: 'STOPPED' })).toMatchObject({ label: 'Stopped', tone: 'neutral' })
  })

  it('keeps a paused, failed or stopped member\'s saved values reviewable', () => {
    for (const executionStatus of ['PAUSED', 'FAILED', 'STOPPED'] as const)
      expect(memberStatus({ ...member, executionStatus, reviewable: true }).message)
        .toBe('Saved values and producing inputs remain available.')
  })

  it('reads a finalized current cut as reviewed, whatever the processing state', () => {
    const currentReview = { snapshotVersion: 2, feedbackVersion: 3, createdAt: '2026-10-05T09:00:00.000Z', schemaRevisionId: '51000000-0000-4000-8005-000000000001' }
    expect(memberStatus({ ...member, executionStatus: 'PAUSED', reviewable: true, currentReview }))
      .toEqual({ label: 'Reviewed', tone: 'success', message: 'The finalized review names its result and decision versions.' })
  })
})
