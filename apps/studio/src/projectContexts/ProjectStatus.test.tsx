// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectStatus, { type ProjectBatchActions } from './ProjectStatus'
import type { ProjectContext } from './transport'

vi.mock('../auth/authenticatedFetch', () => ({ authenticatedFetch: (...args: unknown[]) => fetch(...args as Parameters<typeof fetch>) }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const summary = (overrides: Partial<ProjectContext['summary']> = {}): ProjectContext['summary'] => ({
  phase: 'pilot', extractionCount: 0, extractedSourceDocumentCount: 0, reviewedSourceDocumentCount: 0, staleSourceDocumentCount: 0,
  pendingExtractionSourceDocumentCount: 4, currentSchemaRevisionId: '51000000-0000-4000-8004-000000000001', schemaStabilised: false,
  currentSchemaRevisionReviewed: false, lastActivityAt: '2026-11-01T00:00:00.000Z', runningBatch: null, ...overrides })
const actions = (): ProjectBatchActions => ({ extract: vi.fn(), review: vi.fn(), upload: vi.fn(),
  exported: { projectContextId: '51000000-0000-4000-8000-000000000001', documents: [], name: 'Letters' } })
const approved = (overrides: Partial<ProjectContext['summary']> = {}) =>
  summary({ phase: 'batch', schemaStabilised: true, currentSchemaRevisionReviewed: true, pendingExtractionSourceDocumentCount: 2,
    extractedSourceDocumentCount: 2, reviewedSourceDocumentCount: 2, ...overrides })

describe('ProjectStatus', () => {
  it('leaves the workflow to the chat until the template is approved', () => {
    const onContinue = vi.fn()
    render(<ProjectStatus summary={summary()} onContinue={onContinue} batch={actions()} />)
    expect(screen.getByText('Next in the chat: Try template on a few documents')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Batch extraction' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Continue in chat/ }))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('once approved, extracts the documents left, uploads more, and keeps the way to change the template (ADR 0041)', () => {
    const batch = actions(), onContinue = vi.fn()
    render(<ProjectStatus summary={approved()} onContinue={onContinue} batch={batch} />)
    expect(screen.getByText('Next: Extract 2 documents')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue in chat/ })).not.toBeInTheDocument()
    const group = screen.getByRole('group', { name: 'Batch extraction' })
    fireEvent.click(within(group).getByRole('button', { name: 'Extract 2 documents' }))
    expect(batch.extract).toHaveBeenCalledOnce()
    fireEvent.click(within(group).getByRole('button', { name: 'Upload more documents' }))
    expect(batch.upload).toHaveBeenCalledOnce()
    fireEvent.click(within(group).getByRole('button', { name: /Change the template in the chat/ }))
    expect(onContinue).toHaveBeenCalledOnce()
  })

  it('reviews in the grid, and exports once a document is reviewed', () => {
    const batch = actions()
    const { rerender } = render(<ProjectStatus summary={approved({ phase: 'review', pendingExtractionSourceDocumentCount: 0, extractedSourceDocumentCount: 4,
      reviewedSourceDocumentCount: 0 })} onContinue={null} batch={batch} />)
    expect(screen.getByText('Next: Review 4 results')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Review in grid' }))
    expect(batch.review).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Export results…' })).toBeDisabled()
    // Every document reviewed: the export leads.
    rerender(<ProjectStatus summary={approved({ phase: 'review', pendingExtractionSourceDocumentCount: 0, extractedSourceDocumentCount: 4,
      reviewedSourceDocumentCount: 4 })} onContinue={null} batch={batch} />)
    expect(screen.getByText('Every document is extracted and reviewed.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Review in grid' })).not.toBeInTheDocument()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ extractionSchemas: [] })))
    fireEvent.click(screen.getByRole('button', { name: 'Export results…' }))
    expect(screen.getByRole('dialog', { name: 'Export options' })).toBeInTheDocument()
  })

  it('sends a re-approval back to the chat', () => {
    render(<ProjectStatus summary={approved({ phase: 'review', schemaStabilised: false })} onContinue={vi.fn()} batch={actions()} />)
    expect(screen.getByText('Next in the chat: Re-approve template')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Continue in chat/ })).toBeInTheDocument()
  })
})
