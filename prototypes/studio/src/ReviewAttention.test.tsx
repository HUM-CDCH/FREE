// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewAttention } from './ReviewAttention'

afterEach(cleanup)

describe('ReviewAttention', () => {
  it('labels a Catalog cell by its record and any other cell by its path', () => {
    const onSelect = vi.fn()
    render(<ReviewAttention onSelect={onSelect} attention={{
      cells: [
        { nodeId: 'name', resultPath: ['records', 2, 'people', 0, 'name'], presence: 'grounded', decision: null },
        { nodeId: 'title', resultPath: ['context', 'title'], presence: 'grounded', decision: null },
      ],
      grounded: 2, ungrounded: 0, missing: 0, requiredRemaining: 2,
    }} />)
    // Open on arrival: two required decisions remain.
    expect(screen.getByText('Review attention · 2 to check').closest('details')).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Record 3 · people / 0 / name' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'context / title' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(['context', 'title'])
    expect(screen.queryByRole('button', { name: 'Edit field' })).not.toBeInTheDocument()
  })

  it('opens while required decisions remain, and keeps the researcher\'s own open or close', () => {
    const cells = [{ nodeId: 'a', resultPath: ['records', 0, 'a'], presence: 'grounded' as const, decision: null }]
    const view = render(<ReviewAttention onSelect={vi.fn()} attention={{ cells, grounded: 1, ungrounded: 0, missing: 0, requiredRemaining: 1 }} />)
    const details = screen.getByText('Review attention · 1 to check').closest('details')!
    expect(details).toHaveAttribute('open')
    expect(screen.getByRole('button', { name: 'Record 1 · a' })).toBeVisible()
    details.open = false
    view.rerender(<ReviewAttention onSelect={vi.fn()} attention={{ cells, grounded: 1, ungrounded: 0, missing: 0, requiredRemaining: 1 }} />)
    expect(details).not.toHaveAttribute('open')
    cleanup()

    render(<ReviewAttention onSelect={vi.fn()} attention={{
      cells: [{ ...cells[0]!, decision: { action: 'APPROVED' } }], grounded: 1, ungrounded: 0, missing: 0, requiredRemaining: 0,
    }} />)
    expect(screen.getByText('Review attention · 0 to check').closest('details')).not.toHaveAttribute('open')
  })

  it('colours a decided cell by its decision: accepted and edited green, rejected red', () => {
    render(<ReviewAttention onSelect={vi.fn()} attention={{
      cells: [
        { nodeId: 'a', resultPath: ['records', 0, 'a'], presence: 'grounded', decision: { action: 'APPROVED' } },
        { nodeId: 'b', resultPath: ['records', 0, 'b'], presence: 'grounded', decision: { action: 'EDITED' } },
        { nodeId: 'c', resultPath: ['records', 0, 'c'], presence: 'grounded', decision: { action: 'REJECTED' } },
        { nodeId: 'd', resultPath: ['records', 0, 'd'], presence: 'grounded', decision: null },
      ],
      grounded: 4, ungrounded: 0, missing: 0, requiredRemaining: 1,
    }} />)
    expect(screen.getByText('Review attention · 1 to check').closest('details')).toHaveAttribute('open')
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('approved')).toHaveClass('text-green')
    expect(screen.getByText('edited')).toHaveClass('text-green')
    expect(screen.getByText('rejected')).toHaveClass('text-danger')
    expect(screen.getByText('rejected')).not.toHaveClass('text-green')
    expect(screen.getByText('to check')).toHaveClass('text-accent')
  })
})
