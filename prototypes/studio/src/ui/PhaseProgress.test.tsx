// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import PhaseProgress from './PhaseProgress'

afterEach(cleanup)

const segments = () => screen.getAllByTestId('phase-segment')

describe('PhaseProgress', () => {
  it('fills segments up to the current phase in the in-progress tone', () => {
    render(<PhaseProgress phase="chat" timestamp="12 Aug" />)

    const fills = segments().map((segment) =>
      segment.classList.contains('bg-accent'),
    )
    expect(fills).toEqual([true, true, false, false, false])
    expect(screen.getByText('Schema Chat')).toBeInTheDocument()
    expect(screen.getByText('12 Aug')).toBeInTheDocument()
  })

  it('turns every segment green when validated', () => {
    render(<PhaseProgress phase="validate" tone="validated" timestamp="12 Aug" />)

    for (const segment of segments())
      expect(segment).toHaveClass('bg-green')
    expect(screen.getByText('Validated')).toBeInTheDocument()
  })

  it('marks the current phase amber when stale', () => {
    render(<PhaseProgress phase="extract" tone="stale" timestamp="28 Jul" />)

    const fills = segments()
    expect(fills[2]).toHaveClass('bg-accent')
    expect(fills[3]).toHaveClass('bg-stale')
    expect(fills[4]).toHaveClass('bg-line')
    expect(screen.getByText('Re-run needed')).toBeInTheDocument()
  })

  it('renders the running dot, partial segment, and member count', () => {
    render(
      <PhaseProgress
        phase="extract"
        tone="running"
        running={{ completedMemberCount: 31, memberCount: 42 }}
        timestamp="today"
      />,
    )

    expect(screen.getByText('Extraction running')).toBeInTheDocument()
    expect(screen.getByText('31 / 42')).toBeInTheDocument()
    // Running shows the persisted count, never the timestamp.
    expect(screen.queryByText('today')).toBeNull()
    // The current segment fills to the persisted member fraction.
    const current = segments()[3]
    expect(current.style.background).toContain('73.8')
  })
})
