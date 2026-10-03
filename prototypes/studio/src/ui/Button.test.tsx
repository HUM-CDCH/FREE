// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import Button from './Button'

afterEach(cleanup)

it('positive is a green fill with white text, danger a danger fill, secondary an outline', () => {
  render(<>
    <Button variant="positive">▶ Run</Button>
    <Button variant="danger">Delete</Button>
    <Button>Cancel</Button>
  </>)
  expect(screen.getByRole('button', { name: '▶ Run' }).className).toMatch(/\bbg-green\b.*\btext-white\b/)
  expect(screen.getByRole('button', { name: 'Delete' }).className).toMatch(/\bbg-danger\b.*\btext-white\b/)
  expect(screen.getByRole('button', { name: 'Cancel' }).className).toMatch(/\bborder-line\b/)
})

it('a disabled positive button loses its fill, so colour never carries the state alone', () => {
  render(<Button variant="positive" disabled>▶ Run</Button>)
  expect(screen.getByRole('button', { name: '▶ Run' }).className).toMatch(/disabled:bg-line/)
})
