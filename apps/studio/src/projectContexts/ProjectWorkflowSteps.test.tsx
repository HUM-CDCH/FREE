// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectContextActivitySummary } from './transport'
import ProjectWorkflowSteps from './ProjectWorkflowSteps'

afterEach(cleanup)

const REVISION = '11111111-1111-4111-8111-111111111111'

function summary(
  overrides: Partial<ProjectContextActivitySummary> = {},
): ProjectContextActivitySummary {
  return {
    phase: 'pilot',
    extractionCount: 0,
    extractedSourceDocumentCount: 0,
    reviewedSourceDocumentCount: 0,
    staleSourceDocumentCount: 0,
    pendingExtractionSourceDocumentCount: 3,
    schemaDraftCount: 0,
    currentSchemaRevisionId: REVISION,
    schemaStabilised: false,
    currentSchemaRevisionReviewed: false,
    lastActivityAt: '2026-08-03T10:00:00.000Z',
    runningBatch: null,
    ...overrides,
  }
}

function renderSteps(value: ProjectContextActivitySummary, sourcesInFlight = false) {
  const onOpenStep = vi.fn()
  const onNext = vi.fn()
  render(
    <ProjectWorkflowSteps
      summary={value}
      sourcesInFlight={sourcesInFlight}
      onOpenStep={onOpenStep}
      onNext={onNext}
    />,
  )
  return { onOpenStep, onNext }
}

describe('ProjectWorkflowSteps', () => {
  it('offers one Next for the current step and Back to the step before', () => {
    const { onOpenStep, onNext } = renderSteps(summary())

    expect(screen.getAllByRole('button', { name: /^Next:/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Next: Pilot extraction' }))
    expect(onNext).toHaveBeenCalledWith('pilot')
    fireEvent.click(screen.getByRole('button', { name: 'Back: Create schema' }))
    expect(onOpenStep).toHaveBeenCalledWith('schema')
  })

  it('sends a pilot that has run to reviewing its results, not to another pilot', () => {
    const { onNext } = renderSteps(summary({ extractionCount: 3, extractedSourceDocumentCount: 3 }))

    fireEvent.click(screen.getByRole('button', { name: 'Next: Review 3 pilot results' }))
    expect(onNext).toHaveBeenCalledWith('review')
  })

  it('lets a done step be revisited but not an upcoming one', () => {
    const { onOpenStep } = renderSteps(summary({ phase: 'approve', currentSchemaRevisionReviewed: true }))

    fireEvent.click(screen.getByRole('button', { name: 'Go to Upload' }))
    expect(onOpenStep).toHaveBeenCalledWith('upload')
    expect(screen.queryByRole('button', { name: /Go to Batch extract/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Next: Approve schema' })).toBeEnabled()
  })

  it('leads back to the pilot when the schema changed before its first approval', () => {
    const { onNext } = renderSteps(summary({ phase: 'approve', currentSchemaRevisionReviewed: false }))

    expect(screen.getByRole('button', { name: 'Go to Pilot (Schema changed since the pilot)' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Next: Pilot the revised schema' }))
    expect(onNext).toHaveBeenCalledWith('pilot')
  })

  it('never moves back when an approved schema is revised: Next asks to re-approve, piloting stays optional', () => {
    const { onNext } = renderSteps(
      summary({ phase: 'review', schemaStabilised: false, currentSchemaRevisionReviewed: false, pendingExtractionSourceDocumentCount: 3 }),
    )

    expect(screen.getByRole('button', { name: 'Go to Approve (Schema changed since approval)' })).toBeVisible()
    expect(screen.getByText('Revised schema not piloted')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Next: Re-approve schema' }))
    expect(onNext).toHaveBeenCalledWith('approve')
  })

  it('turns documents added after the batch into work on the batch step', () => {
    const { onNext } = renderSteps(
      summary({ phase: 'review', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 2 }),
    )

    expect(screen.getByRole('button', { name: 'Go to Batch extract (2 documents to extract)' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Next: Extract 2 documents' }))
    expect(onNext).toHaveBeenCalledWith('batch')
  })

  it('names the results left to review once the batch is done', () => {
    renderSteps(
      summary({
        phase: 'review',
        schemaStabilised: true,
        currentSchemaRevisionReviewed: true,
        pendingExtractionSourceDocumentCount: 0,
        extractedSourceDocumentCount: 3,
        reviewedSourceDocumentCount: 1,
      }),
    )

    expect(screen.getByRole('button', { name: 'Next: Review 2 results' })).toBeEnabled()
  })

  it('says why Next waits while an Extraction runs', () => {
    renderSteps(
      summary({
        phase: 'batch',
        schemaStabilised: true,
        runningBatch: { completedMemberCount: 1, memberCount: 3 },
      }),
    )

    expect(screen.getByRole('button', { name: 'Next: Extract 3 documents' })).toBeDisabled()
    expect(screen.getByText('Extraction running · 1/3')).toBeVisible()
  })

  it('waits for uploads still parsing before the first step is done', () => {
    renderSteps(summary({ phase: 'upload', currentSchemaRevisionId: null, pendingExtractionSourceDocumentCount: 0 }), true)

    expect(screen.getByRole('button', { name: 'Next: Upload documents' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: /^Back:/ })).not.toBeInTheDocument()
  })

  it('has no Next once every document is extracted and reviewed', () => {
    renderSteps(
      summary({
        phase: 'review',
        schemaStabilised: true,
        currentSchemaRevisionReviewed: true,
        pendingExtractionSourceDocumentCount: 0,
        extractedSourceDocumentCount: 3,
        reviewedSourceDocumentCount: 3,
      }),
    )

    expect(screen.queryByRole('button', { name: /^Next:/ })).not.toBeInTheDocument()
    expect(screen.getByText('Every document is extracted and reviewed.')).toBeVisible()
  })
})
