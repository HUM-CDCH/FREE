// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RightRail from './RightRail'
import type { ExtractionController } from './useExtraction'
import type { ExtractionInspection } from './RightRail'
import {
  createSchemaEditorController,
  localSchemaPersistence,
  type SchemaEditorController,
} from './currentSchemaRevision'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const defaultController: ExtractionController = {
  state: { status: 'idle' },
  attempt: null,
  canRun: true,
  hasResults: false,
  runExtraction: async () => null,
  requestCancellation: async () => {},
  cancellationRequested: false,
  cancellationError: null,
  monitorError: null,
  reconnect: () => {},
  review: {
    available: false,
    canAccept: false,
    saving: false,
    loading: false,
    decisions: [],
    reviewedCount: 0,
    untouchedCount: 0,
    isTouched: () => false,
    reviewedExtractionId: null,
    error: null,
    draftError: null,
    draftSaving: false,
    retryDraft: () => {},
    transfer: {},
    setDecision: () => {},
    undo: () => {},
    reload: () => {},
    approveAll: () => {},
    accept: async () => {},
  },
}

const defaultInspection: ExtractionInspection = {
  attempt: null,
  readOnly: false,
  documentMarkdown: '# Test doc',
  parsedDocument: null,
  reviewDecisions: [],
  pinnedSchema: null,
  exportSchema: null,
}

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
}: {
  open?: boolean
  tab?: 'evidence' | 'schema' | 'results'
} = {}) {
  return render(
    <RightRail
      open={open}
      onToggle={vi.fn()}
      tab={tab}
      onTabChange={vi.fn()}
      schema={testSchema()}
      onClearDraft={vi.fn()}
      extraction={defaultController}
      onRunExtraction={vi.fn()}
      runExtractionDisabled={false}
      runExtractionStrategy={{ strategy: 'ARTICLE' }}
      inspection={defaultInspection}
      currentSchemaRevision={null}
      sourceDocumentName="test.pdf"
      onSelectEvidence={vi.fn()}
      onResultPathChange={vi.fn()}
    />,
  )
}

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
