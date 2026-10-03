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
})
