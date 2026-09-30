// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RightRail from './RightRail'
import type { ExtractionController } from './useExtraction'
import type { ExtractionInspection } from './RightRail'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
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
    pairing: { pairings: [], sources: [], pair: () => {} },
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
      sourceRepresentationId="source-representation"
      onSelectEvidence={vi.fn()}
      onResultPathChange={vi.fn()}
    />,
  )
}

describe('RightRail developer UI visibility', () => {
  it('jumps from Results to the current draft while closing a historical preview', async () => {
    const historical: SchemaRevision = { schemaRevisionId: 'revision-1', extractionSchemaId: 'schema-1', revisionNumber: 1,
      origin: 'researcher-edit', createdAt: '2026-09-30T00:00:00Z', recordDescription: 'One record.',
      schemaNodes: [{ id: 'title', name: 'title', type: 'string' }, { id: 'gender', name: 'gender', type: 'string' }] }
    const schema = createSchemaEditorController({ ...localSchemaPersistence({ onEdit: () => {} }), getRevision: async () => historical },
      { initialDraft: historical })
    schema.commit((nodes) => nodes.filter((node) => node.id !== 'title'), 'Removed title')
    const draft = schema.snapshot().draft
    await schema.previewHistoricalRevision(historical.schemaRevisionId)
    const attempt: ExtractionAttempt = {
      extractionId: 'extraction-1', sourceDocumentId: 'document-1', sourceRepresentationRevisionId: 'source-1',
      schemaRevisionId: historical.schemaRevisionId, strategy: 'ARTICLE', catalogRecipe: null, batchExtractionId: null,
      executionStatus: 'COMPLETED', outcome: 'SUCCEEDED', complete: true, modelAttribution: null, diagnostics: null, failure: null,
      resultPayload: { records: [{ title: 'Report' }] }, evidenceLinks: [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }],
      reviewable: true, createdAt: historical.createdAt, reviewedAt: null, reviewDecisions: [],
    }
    function Rail() {
      const [tab, setTab] = useState<'schema' | 'results'>('results')
      return <RightRail open onToggle={() => {}} tab={tab} onTabChange={(next) => setTab(next === 'results' ? next : 'schema')}
        schema={schema} onClearDraft={() => {}} extraction={{ ...defaultController, attempt, hasResults: true,
          state: { status: 'ready', result: attempt.resultPayload!, evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0 } }}
        runExtractionDisabled={false} runExtractionStrategy={{ strategy: 'ARTICLE' }}
        inspection={{ ...defaultInspection, attempt, pinnedSchema: historical }} currentSchemaRevision={null}
        sourceDocumentName="test.pdf" onSelectEvidence={() => {}} onResultPathChange={() => {}} />
    }
    render(<Rail />)
    fireEvent.click(screen.getByText(/1 grounded · 1 required decisions remaining/))
    fireEvent.click(screen.getByRole('button', { name: 'Edit this field' }))
    expect(schema.snapshot().historicalPreview).toBeNull()
    expect(schema.snapshot().draft).toEqual(draft)
    expect(screen.getByText(/This field was removed. No replacement was selected/)).toBeVisible()
    expect(screen.getByTitle('Edit gender')).toBeVisible()
  })

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
