// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectLoadFailure, SessionExpiryWarning, SessionFailure, SignedOutLanding } from './AuthForms.tsx'

afterEach(cleanup)

// One filled primary per screen (decision 01): the command that moves the researcher on is the green one; a retry is not.
describe('the auth screens\' commands', () => {
  it('Sign in with Microsoft is the filled primary', () => {
    render(<SignedOutLanding />)
    expect(screen.getByRole('button', { name: 'Sign in with Microsoft' }).className).toMatch(/(^|\s)bg-green(\s|$)/)
  })

  it('Continue session is the filled primary', () => {
    render(<SessionExpiryWarning onContinue={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Continue session' }).className).toMatch(/(^|\s)bg-green(\s|$)/)
  })

  it.each([
    ['session', () => <SessionFailure onRetry={vi.fn()} />],
    ['workspace', () => <ProjectLoadFailure onRetry={vi.fn()} />],
  ])('a %s failure\'s Try again stays secondary', (_name, screenOf) => {
    render(screenOf())
    const retry = screen.getByRole('button', { name: 'Try again' })
    expect(retry.className).toMatch(/(^|\s)bg-surface(\s|$)/)
    expect(retry.className).not.toMatch(/(^|\s)bg-green(\s|$)/)
  })
})
