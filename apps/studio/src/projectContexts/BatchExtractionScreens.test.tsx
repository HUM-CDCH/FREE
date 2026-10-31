// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BatchExtraction } from '../../shared/batchExtraction.contract'
import { BatchExtractionHistory, BatchExtractionMembers } from './BatchExtractionScreens'

afterEach(cleanup)
const batch: BatchExtraction = {
  batchExtractionId: '51000000-0000-4000-8007-000000000001',
  projectContextId: '51000000-0000-4000-8000-000000000001',
  schemaRevisionId: '51000000-0000-4000-8004-000000000001',
  extractionSchemaId: '51000000-0000-4000-8003-000000000001',
  extractionSchemaName: 'Places', schemaRevisionNumber: 1, strategy: 'ARTICLE',
  executionStatus: 'RUNNING', createdAt: '2026-10-04T10:00:00.000Z',
  members: ['PAUSED', 'FAILED', 'STOPPED', 'COMPLETED'].map((executionStatus, index) => ({
    extractionId: `51000000-0000-4000-8006-00000000000${index + 1}`,
    sourceDocumentId: `51000000-0000-4000-8001-00000000000${index + 1}`,
    sourceRepresentationRevisionId: `51000000-0000-4000-8002-00000000000${index + 1}`,
    executionStatus: executionStatus as BatchExtraction['members'][number]['executionStatus'],
    completed: executionStatus === 'COMPLETED',
    reviewable: true, currentReview: null,
  })),
}

it('reports retained member states without claiming completed research review', () => {
  render(<BatchExtractionHistory batches={[batch]} onOpen={vi.fn()} />)
  expect(screen.getByText('1 paused · 1 failed · 1 stopped · 1 completed')).toBeVisible()
  expect(screen.queryByText('Reviewed')).not.toBeInTheDocument()
  expect(screen.queryByText(/Running ·/)).not.toBeInTheDocument()
})

it('names a run at the pilot limit a pilot and a larger one a collection batch', () => {
  const members = (count: number): BatchExtraction['members'] =>
    Array.from({ length: count }, (_, index) => ({
      extractionId: `51000000-0000-4000-8006-${String(index + 1).padStart(12, '0')}`,
      sourceDocumentId: `51000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
      sourceRepresentationRevisionId: `51000000-0000-4000-8002-${String(index + 1).padStart(12, '0')}`,
      executionStatus: 'COMPLETED' as const,
      completed: true,
      reviewable: true,
      currentReview: null,
    }))

  const pilot = render(
    <BatchExtractionHistory
      batches={[{ ...batch, members: members(5) }]}
      onOpen={vi.fn()}
    />,
  )
  expect(screen.getByText('Pilot')).toBeVisible()
  pilot.unmount()

  render(
    <BatchExtractionHistory
      batches={[{ ...batch, members: members(6) }]}
      onOpen={vi.fn()}
    />,
  )
  expect(screen.queryByText('Pilot')).not.toBeInTheDocument()
})

it('opens every retained member and keeps typed review on its member route', () => {
  const onOpenMember = vi.fn()
  render(<BatchExtractionMembers batch={batch}
    pinnedSchemaFailure={null} hasSuccessfulResult coverageMessage={null} opening={false}
    canRunAgain={false} runAgainRefusal={null} runAgainMethod={null}
    documentName={(id) => id} exportSchemaNodes={[]} onExport={vi.fn()} onRetrySchema={vi.fn()} onRunAgain={vi.fn()}
    onOpenMember={onOpenMember} />)
  expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled()
  // Each member is reviewed through its own typed values; there is no batch-wide review grid.
  expect(screen.queryByRole('button', { name: 'Review grid' })).not.toBeInTheDocument()
  for (const member of batch.members) {
    const button = screen.getByRole('button', { name: new RegExp(member.sourceDocumentId) })
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onOpenMember).toHaveBeenLastCalledWith(member.sourceDocumentId, member.extractionId)
  }
})

describe('the settled batch outcome', () => {
  const review = { snapshotVersion: 1, feedbackVersion: 0, createdAt: '2026-10-05T10:00:00.000Z', schemaRevisionId: batch.schemaRevisionId }
  const collection = (count: number, reviewed: number, status: 'COMPLETED' | 'FAILED' = 'COMPLETED'): BatchExtraction => ({
    ...batch, executionStatus: 'COMPLETED',
    members: Array.from({ length: count }, (_, index) => ({
      extractionId: `51000000-0000-4000-8006-${String(index + 1).padStart(12, '0')}`,
      sourceDocumentId: `51000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
      sourceRepresentationRevisionId: `51000000-0000-4000-8002-${String(index + 1).padStart(12, '0')}`,
      executionStatus: index === 0 ? status : 'COMPLETED',
      completed: index !== 0 || status === 'COMPLETED',
      reviewable: true,
      currentReview: index < reviewed ? review : null,
    })) as BatchExtraction['members'],
  })
  const show = (shown: BatchExtraction) => render(<BatchExtractionMembers batch={shown}
    pinnedSchemaFailure={null} hasSuccessfulResult coverageMessage={null} opening={false}
    canRunAgain={false} runAgainRefusal={null} runAgainMethod={null}
    documentName={(id) => id} exportSchemaNodes={[]} onExport={vi.fn()} onRetrySchema={vi.fn()} onRunAgain={vi.fn()}
    onOpenMember={vi.fn()} />)

  it('says what is left to review before the batch is done', () => {
    show(collection(6, 2))
    expect(screen.getByRole('status', { name: 'Batch Extraction outcome' })).toHaveTextContent('2 of 6 documents reviewed')
    expect(screen.queryByText('Batch Extraction complete')).not.toBeInTheDocument()
  })

  it('names documents that were not extracted first', () => {
    show(collection(6, 0, 'FAILED'))
    expect(screen.getByRole('status', { name: 'Batch Extraction outcome' })).toHaveTextContent('1 of 6 documents not extracted')
  })

  it('calls a fully extracted and reviewed batch complete and leads to the export', () => {
    show(collection(6, 6))
    expect(screen.getByRole('status', { name: 'Batch Extraction outcome' })).toHaveTextContent('Batch Extraction complete')
    expect(screen.getByRole('button', { name: 'Export' }).className).toContain('bg-green')
  })

  it('leaves a pilot round and a running batch without an outcome', () => {
    const pilot = show(collection(3, 3))
    expect(screen.queryByRole('status', { name: 'Batch Extraction outcome' })).not.toBeInTheDocument()
    pilot.unmount()
    show(batch)
    expect(screen.queryByRole('status', { name: 'Batch Extraction outcome' })).not.toBeInTheDocument()
  })
})
