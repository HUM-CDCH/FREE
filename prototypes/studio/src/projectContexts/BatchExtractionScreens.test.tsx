// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
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

it('opens every retained member and keeps typed review on its member route', () => {
  const onOpenMember = vi.fn()
  render(<BatchExtractionMembers batch={batch}
    pinnedSchemaFailure={null} hasSuccessfulResult coverageMessage={null} opening={false}
    canRunAgain={false} runAgainRefusal={null} runAgainMethod={null}
    documentName={(id) => id} onExport={vi.fn()} onRetrySchema={vi.fn()} onRunAgain={vi.fn()}
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
