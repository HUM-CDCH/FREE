// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import SegmentedControl from './SegmentedControl'

afterEach(cleanup)

it('gives every segment the 24px hit-target floor and the compact text size', () => {
  render(<SegmentedControl aria-label="View" value="a" onChange={vi.fn()} options={[{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }]} />)
  for (const name of ['A', 'B']) {
    expect(screen.getByRole('button', { name })).toHaveClass('min-h-6', 'text-compact')
  }
})
