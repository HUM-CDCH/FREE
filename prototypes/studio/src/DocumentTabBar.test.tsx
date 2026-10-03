// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DocumentTabBar from './DocumentTabBar'

afterEach(cleanup)
const tabs = [{ sourceDocumentId: 'doc-1', name: 'Beretning.pdf' }]

it('shows the project as a chip that opens its Sources tab, and no breadcrumb row', () => {
  const onNavigateProject = vi.fn()
  render(<DocumentTabBar projectName="Ellekilde" tabs={tabs} activeSourceDocumentId="doc-1" onActivate={vi.fn()} onClose={vi.fn()}
    onNavigateProject={onNavigateProject} slotRef={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Open project Ellekilde' }))
  expect(onNavigateProject).toHaveBeenCalledOnce()
  expect(screen.queryByRole('navigation', { name: 'Breadcrumb' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Project actions' })).not.toBeInTheDocument()
})

it('offers Back to review grid in the chip menu when the document came from a review grid', () => {
  const onBackToReviewGrid = vi.fn()
  render(<DocumentTabBar projectName="Ellekilde" tabs={tabs} activeSourceDocumentId="doc-1" onActivate={vi.fn()} onClose={vi.fn()}
    onNavigateProject={vi.fn()} onBackToReviewGrid={onBackToReviewGrid} slotRef={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Project actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Back to review grid' }))
  expect(onBackToReviewGrid).toHaveBeenCalledOnce()
})

it('shows no project chip until the project name is known', () => {
  render(<DocumentTabBar projectName={null} tabs={tabs} activeSourceDocumentId="doc-1" onActivate={vi.fn()} onClose={vi.fn()}
    onNavigateProject={vi.fn()} onBackToReviewGrid={vi.fn()} slotRef={() => {}} />)
  expect(screen.queryByRole('button', { name: /^Open project/ })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Project actions' })).not.toBeInTheDocument()
  expect(screen.getByRole('tablist', { name: 'Open Source Documents' })).toBeInTheDocument()
})
