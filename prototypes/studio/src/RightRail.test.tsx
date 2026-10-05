// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RightRail from './RightRail'
import { DurableResults } from './DurableResults'
import type { ExtractionController } from './useExtraction'
import type { ExtractionInspection } from './RightRail'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import {
  createSchemaEditorController,
  localSchemaPersistence,
  type SchemaEditorController,
} from './currentSchemaRevision'

vi.mock('./DurableResults', () => ({ DurableResults: vi.fn(() => <p>Durable results</p>) }))

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.mocked(DurableResults).mockClear()
})

const defaultController: ExtractionController = {
  attempt: null,
  admitting: false,
  canRun: true,
  acceptDurableStatus: () => {},
  runExtraction: async () => null,
  monitorError: null,
  reconnect: () => {},
}

const defaultInspection: ExtractionInspection = {
  attempt: null,
  cut: null,
  readOnly: false,
  parsedDocument: null,
}

const attempt = {
  extractionId: 'extraction-1', sourceDocumentId: 'document-1', sourceRepresentationRevisionId: 'source-1',
  schemaRevisionId: 'revision-1', strategy: 'ARTICLE', catalogRecipe: null, requestedModels: null, requestedSettings: null,
  executionStatus: 'PAUSED', finalizedReview: null, batchExtractionId: null, createdAt: '2026-10-05T00:00:00.000Z',
} satisfies ExtractionAttempt

function testSchema(): SchemaEditorController {
  return createSchemaEditorController(
    localSchemaPersistence({ onEdit: () => {} }),
    {
      initialDraft: {
        recordDescription: 'One record.',
        schemaNodes: [
          { id: 'title', name: 'title', type: 'string' },
          { id: 'gender', name: 'gender', type: 'string' },
        ],
      },
    },
  )
}
function renderRail({
  open = true,
  tab = 'schema',
  inspection = defaultInspection,
  extraction = defaultController,
}: {
  open?: boolean
  tab?: 'evidence' | 'schema' | 'results'
  inspection?: ExtractionInspection
  extraction?: ExtractionController
} = {}) {
  return render(
    <RightRail
      open={open}
      onToggle={vi.fn()}
      tab={tab}
      onTabChange={vi.fn()}
      schema={testSchema()}
      onClearDraft={vi.fn()}
      extraction={extraction}
      inspection={inspection}
      currentSchemaRevision={null}
      sourceDocumentName="test.pdf"
      sourceRepresentationId="source-representation"
      onSelectEvidence={vi.fn()}
      onResultPathChange={vi.fn()}
    />,
  )
}

describe('RightRail Results', () => {
  it('reviews every Extraction with the durable reader, at the live cut unless an explicit one is named', () => {
    renderRail({ tab: 'results', extraction: { ...defaultController, attempt } })
    expect(screen.getByText('Durable results')).toBeVisible()
    expect(vi.mocked(DurableResults).mock.lastCall![0]).toMatchObject({ attempt, initialCut: null, readOnly: false })
    cleanup()
    const cut = { snapshotVersion: 1, feedbackVersion: 2 }
    renderRail({ tab: 'results', inspection: { ...defaultInspection, attempt, cut, readOnly: true } })
    expect(vi.mocked(DurableResults).mock.lastCall![0]).toMatchObject({ attempt, initialCut: cut, readOnly: true })
  })

  it('says how to start when there is no Extraction, and offers Reconnect for an unanswered admission', () => {
    const reconnect = vi.fn()
    renderRail({ tab: 'results', extraction: { ...defaultController, monitorError: 'Unable to update status. The extraction may still be running.', reconnect } })
    expect(screen.getByText('No results yet')).toBeVisible()
    expect(screen.getByText('Press ▶ Run extraction above.')).toBeVisible()
    expect(screen.getByRole('alert')).toHaveTextContent('may still be running')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
    expect(DurableResults).not.toHaveBeenCalled()
  })

  it('names the shown Extraction\'s lifecycle in a badge that stays on one line', () => {
    renderRail({ extraction: { ...defaultController, attempt } })
    const results = screen.getByRole('tab', { name: /^Results\s*paused$/ })
    const badge = within(results).getByRole('img', { name: 'paused' })
    expect(badge.className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/)
    expect(within(results).getByText('Results').className).toMatch(/(^|\s)min-w-0(\s|$)/)
  })
})

describe('RightRail developer UI visibility', () => {
  it('hides the Evidence tab by default', () => {
    renderRail({ open: true })

    expect(screen.queryByRole('tab', { name: /Evidence/i })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Schema/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Results/i })).toBeInTheDocument()
  })

  it('falls back to Schema when the hidden Evidence tab was selected', () => {
    renderRail({ open: true, tab: 'evidence' })

    expect(screen.getByRole('tab', { name: /Schema/i })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('displays collapsed strip without Evidence by default', () => {
    renderRail({ open: false })

    expect(screen.getByText('Schema · Results')).toBeInTheDocument()
    expect(screen.queryByText('Evidence · Schema · Results')).not.toBeInTheDocument()
  })

  it('restores the Evidence tab when VITE_SHOW_DEVELOPER_UI=true', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', 'true')
    renderRail({ open: true })

    expect(screen.getByRole('tab', { name: /Evidence/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Schema/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Results/i })).toBeInTheDocument()
  })

  it('displays collapsed strip with Evidence when VITE_SHOW_DEVELOPER_UI=true', () => {
    vi.stubEnv('VITE_SHOW_DEVELOPER_UI', 'true')
    renderRail({ open: false })

    expect(screen.getByText('Evidence · Schema · Results')).toBeInTheDocument()
  })
})
