// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResultsTab from './ResultsTab'
import type { ExtractionController } from './useExtraction'

afterEach(cleanup)

function controller(
  state: ExtractionController['state'],
): ExtractionController {
  return {
    state,
    attempt: null,
    canRun: true,
    hasResults: state.status === 'ready',
    runExtraction: async () => {},
    review: {
      available: false,
      canAccept: false,
      saving: false,
      reviewedExtractionId: null,
      error: null,
      accept: async () => {},
    },
  }
}

describe('ResultsTab grounded values', () => {
  it('shows one server-owned progress state without raw output', () => {
    render(
      <ResultsTab
        controller={controller({
          status: 'running',
          step: 'extraction',
        })}
        schemaReady
        documentMarkdown="# Source"
      />,
    )

    expect(screen.getByText('Running Article extraction…')).toBeInTheDocument()
    expect(screen.queryByText('Report')).not.toBeInTheDocument()
  })

  it('offers canonical Evidence navigation only for linked scalar paths', () => {
    const onSelectEvidence = vi.fn()
    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: { title: 'Report', ungrounded: 'Visible without Evidence' },
          evidenceLinks: [
            { resultPath: ['title'], evidenceAnchorId: 'anchor-1' },
          ],
          groundingIssues: [],
        })}
        schemaReady
        documentMarkdown="# Source"
        onSelectEvidence={onSelectEvidence}
      />,
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'View Evidence for title' }),
    )
    expect(onSelectEvidence).toHaveBeenCalledWith('anchor-1')
    expect(
      screen.queryByRole('button', { name: 'View Evidence for ungrounded' }),
    ).not.toBeInTheDocument()
    expect(screen.getByText('Visible without Evidence')).toBeInTheDocument()
  })

  it('keeps Evidence navigation on expanded record scalars', () => {
    const onSelectEvidence = vi.fn()
    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: { records: [{ title: 'Report' }] },
          evidenceLinks: [
            {
              resultPath: ['records', 0, 'title'],
              evidenceAnchorId: 'anchor-1',
            },
          ],
          groundingIssues: [],
        })}
        schemaReady
        documentMarkdown="# Source"
        onSelectEvidence={onSelectEvidence}
      />,
    )

    fireEvent.click(screen.getByText('records', { exact: true }))
    fireEvent.click(screen.getByText('Item 1', { exact: true }))
    fireEvent.click(
      screen.getByRole('button', { name: 'View Evidence for title' }),
    )
    expect(onSelectEvidence).toHaveBeenCalledWith('anchor-1')
  })

  it('offers a new run after cancellation', () => {
    render(
      <ResultsTab
        controller={controller({ status: 'cancelled' })}
        schemaReady
        documentMarkdown="# Source"
      />,
    )

    expect(screen.getByText('Extraction cancelled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run a new extraction' })).toBeInTheDocument()
  })
})
