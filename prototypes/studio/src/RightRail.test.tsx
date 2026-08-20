// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RightRail from './RightRail'
import type { ExtractionController } from './useExtraction'
import type { TemplateState } from './SchemaPanel'
import type { ExtractionInspection } from './RightRail'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

const defaultController: ExtractionController = {
  state: { status: 'idle' },
  attempt: null,
  canRun: true,
  hasResults: false,
  stale: false,
  runExtraction: async () => {},
  requestCancellation: async () => {},
  cancellationRequested: false,
  cancellationError: null,
  review: {
    available: false,
    canAccept: false,
    saving: false,
    reviewedExtractionId: null,
    error: null,
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

const defaultSchemaState: TemplateState = {
  status: 'idle',
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
      schemaState={defaultSchemaState}
      schemaReady={true}
      schemaFieldCount={2}
      onGenerate={vi.fn()}
      onCancelGenerate={vi.fn()}
      onResetSchema={vi.fn()}
      onNodesChange={vi.fn()}
      beforeSchemaEdit={vi.fn(async () => null)}
      schemaHistory={[]}
      loadSchemaRevision={vi.fn(async () => ({} as never))}
      extraction={defaultController}
      inspection={defaultInspection}
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
