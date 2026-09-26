import { describe, expect, it } from 'vitest'
import type { BatchExtractionMember } from '../../shared/batchExtraction.contract'
import { memberStatus } from './batchExtractionStatus'

const member = {
  sourceDocumentId: '51000000-0000-4000-8001-000000000001',
  sourceRepresentationRevisionId: '51000000-0000-4000-8002-000000000001',
} as const

describe('a Batch Extraction member status', () => {
  it('an interrupted member reads Failed with the interruption message', () => {
    const interrupted: BatchExtractionMember = {
      ...member,
      executionStatus: 'FAILED',
      executionFailureMessage: 'This work stopped before it finished. Start it again.',
      latestExtraction: null,
    }
    expect(memberStatus(interrupted)).toEqual({
      label: 'Failed',
      tone: 'danger',
      message: 'This work stopped before it finished. Start it again.',
    })
  })

  it('reads queued, running and published members from their status and result', () => {
    const waiting = { ...member, executionFailureMessage: null, latestExtraction: null }
    expect(memberStatus({ ...waiting, executionStatus: 'QUEUED' }).label).toBe('Queued')
    expect(memberStatus({ ...waiting, executionStatus: 'RUNNING' }).label).toBe('Running')
    const published = {
      extractionId: '51000000-0000-4000-8006-000000000001',
      outcome: 'SUCCEEDED',
      complete: true,
      reviewable: true,
      createdAt: '2026-09-26T10:00:00.000Z',
      reviewedAt: null,
    } as const
    expect(memberStatus({ ...waiting, executionStatus: 'COMPLETED', latestExtraction: published }).label)
      .toBe('Needs review')
    expect(memberStatus({
      ...waiting,
      executionStatus: 'COMPLETED',
      latestExtraction: { ...published, reviewedAt: '2026-09-26T10:05:00.000Z' },
    }).label).toBe('Reviewed')
    expect(memberStatus({
      ...waiting,
      executionStatus: 'COMPLETED',
      latestExtraction: { ...published, reviewable: false },
    }).label).toBe('No reviewable result')
  })
})
