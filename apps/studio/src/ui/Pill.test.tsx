// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import Pill from './Pill'

afterEach(cleanup)

it('sizes its text by prop, so a caller never fights the base classes', () => {
  render(<><Pill>overline</Pill><Pill size="compact">compact</Pill></>)
  expect(screen.getByText('overline').className).toMatch(/\btext-overline\b/)
  expect(screen.getByText('overline').className).toMatch(/\bfont-semibold\b/)
  expect(screen.getByText('compact').className).toMatch(/\btext-compact\b/)
  expect(screen.getByText('compact').className).toMatch(/\bfont-medium\b/)
  expect(screen.getByText('compact').className).not.toMatch(/text-overline|font-semibold/)
})
