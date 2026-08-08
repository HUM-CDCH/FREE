// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ResultsTab from './ResultsTab'
import type { ExtractionController } from './useExtraction'

afterEach(cleanup)

function controller(
  state: ExtractionController['state'],
  retryGrounding = vi.fn(async () => {}),
): ExtractionController {
  return {
    state,
    canRun: true,
    hasResults:
      state.status === 'ready' ||
      (state.status === 'running' && state.step === 'grounding'),
    runExtraction: async () => {},
    retryGrounding,
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
  it('keeps clean extracted values visible while grounding runs', () => {
    render(
      <ResultsTab
        controller={controller({
          status: 'running',
          step: 'grounding',
          result: { title: 'Report' },
        })}
        schemaReady
        documentMarkdown="# Source"
      />,
    )

    expect(screen.getByText('Grounding Evidence…')).toBeInTheDocument()
    expect(
      screen.getByLabelText('Extracted values awaiting grounding'),
    ).toHaveTextContent('Report')
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

  it('retries only the grounding stage while preserving extracted values', () => {
    const retryGrounding = vi.fn(async () => {})
    render(
      <ResultsTab
        controller={controller(
          {
            status: 'ready',
            result: { title: 'Report' },
            evidenceLinks: [],
            groundingIssues: [],
            groundingError: 'provider unavailable',
          },
          retryGrounding,
        )}
        schemaReady
        documentMarkdown="# Source"
      />,
    )

    expect(screen.getByText('Report')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry grounding' }))
    expect(retryGrounding).toHaveBeenCalledOnce()
  })
})
