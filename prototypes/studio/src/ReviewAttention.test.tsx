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
    fireEvent.click(screen.getByText('Review attention · 2 to check'))
    expect(screen.getByRole('button', { name: 'Record 3 · people / 0 / name' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'context / title' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(['context', 'title'])
    expect(screen.queryByRole('button', { name: 'Edit field' })).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByText('Review attention · 1 to check'))
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(screen.getByText('approved')).toHaveClass('text-green')
    expect(screen.getByText('edited')).toHaveClass('text-green')
    expect(screen.getByText('rejected')).toHaveClass('text-danger')
    expect(screen.getByText('rejected')).not.toHaveClass('text-green')
    expect(screen.getByText('to check')).toHaveClass('text-accent')
  })
})
