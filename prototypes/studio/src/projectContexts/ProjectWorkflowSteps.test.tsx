// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProjectContextActivitySummary } from './transport'
import ProjectWorkflowSteps from './ProjectWorkflowSteps'

afterEach(cleanup)

function summary(
  overrides: Partial<ProjectContextActivitySummary> = {},
): ProjectContextActivitySummary {
  return {
    phase: 'extract',
    extractionCount: 1,
    extractedSourceDocumentCount: 1,
    reviewedSourceDocumentCount: 0,
    staleSourceDocumentCount: 0,
    schemaDraftCount: 0,
    schemaStabilised: false,
    lastActivityAt: '2026-08-03T10:00:00.000Z',
    runningBatch: null,
    ...overrides,
  }
}

function renderSteps(value: ProjectContextActivitySummary) {
  return render(
    <ProjectWorkflowSteps summary={value} onNavigate={vi.fn()} />,
  )
}

/** The step markers the component draws with the current-step ring. */
const currentStepCount = (container: HTMLElement) =>
  container.querySelectorAll('.border-2.border-accent').length

describe('ProjectWorkflowSteps', () => {
  it('keeps piloting current until the current Revision has a reviewed pilot', () => {
    const { container } = renderSteps(summary())
    expect(screen.getByRole('button', { name: 'Next: Pilot Extraction' })).toBeVisible()
    expect(screen.getAllByText('Pilot Extraction').length).toBeGreaterThan(0)
    expect(currentStepCount(container)).toBe(1)
  })

  it('names approval as the next step after a reviewed pilot on an unstabilised Revision', () => {
    const { container } = renderSteps(
      summary({
        phase: 'validate',
        reviewedSourceDocumentCount: 1,
        schemaStabilised: false,
      }),
    )
    expect(
      screen.getByRole('button', { name: 'Next: Approve for batch extraction' }),
    ).toBeVisible()
    expect(currentStepCount(container)).toBe(1)
  })

  it('keeps batch current when a Source Document changed since its Extraction', () => {
    const { container } = renderSteps(
      summary({
        phase: 'validate',
        reviewedSourceDocumentCount: 1,
        staleSourceDocumentCount: 1,
        schemaStabilised: true,
      }),
    )
    expect(screen.getByRole('button', { name: 'Next: Batch Extraction' })).toBeVisible()
    expect(currentStepCount(container)).toBe(1)
  })

  it('hides the next action once every current Extraction is reviewed and nothing is stale', () => {
    const { container } = renderSteps(
      summary({
        phase: 'validate',
        reviewedSourceDocumentCount: 1,
        staleSourceDocumentCount: 0,
        schemaStabilised: true,
      }),
    )
    expect(screen.queryByRole('button', { name: /^Next:/ })).not.toBeInTheDocument()
    expect(currentStepCount(container)).toBe(0)
  })
})
