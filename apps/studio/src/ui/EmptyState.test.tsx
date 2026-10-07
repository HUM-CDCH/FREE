// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import EmptyState from './EmptyState'

afterEach(cleanup)

it('wraps its actions, centred with their gap, so three fit a 264px rail', () => {
  render(
    <EmptyState title="No schema yet">
      <button type="button">Generate from the document</button>
      <button type="button">Import from Excel codebook…</button>
      <button type="button">Start blank</button>
    </EmptyState>,
  )
  const actions = screen.getByRole('button', { name: 'Start blank' }).parentElement!
  expect(actions.className).toMatch(/\bflex-wrap\b/)
  expect(actions.className).toMatch(/\bjustify-center\b/)
  expect(actions.className).toMatch(/\bgap-2\b/)
})
