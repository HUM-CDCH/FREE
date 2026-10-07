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

it('outline-positive and outline-danger keep their colour on text and border, never a fill; ghost has no border', () => {
  render(<>
    <Button variant="outline-positive">Approve rest…</Button>
    <Button variant="outline-danger">Reject</Button>
    <Button variant="ghost">Undo</Button>
  </>)
  const positive = screen.getByRole('button', { name: 'Approve rest…' }).className
  expect(positive).toMatch(/\btext-green\b/)
  expect(positive).toMatch(/\bborder-green\/40\b/)
  expect(positive).toMatch(/\bhover:bg-green-soft\b/)
  expect(positive).not.toMatch(/(^|\s)bg-green(\s|$)/)
  expect(screen.getByRole('button', { name: 'Reject' }).className).toMatch(/\bborder-danger\/40\b.*\btext-danger\b/)
  expect(screen.getByRole('button', { name: 'Undo' }).className).toMatch(/\bborder-transparent\b.*\btext-ink-muted\b/)
})

it('secondary and pill hover neutral, never terracotta, so green stays the only action fill', () => {
  render(<><Button>Cancel</Button><Button variant="pill">Filter</Button></>)
  for (const name of ['Cancel', 'Filter']) {
    const className = screen.getByRole('button', { name }).className
    expect(className).toMatch(/\bhover:text-ink\b/)
    expect(className).not.toMatch(/hover:text-accent|hover:bg-accent|hover:border-accent/)
  }
})
