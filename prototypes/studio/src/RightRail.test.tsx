// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import RightRail from './RightRail'
import ResultsTab from './ResultsTab'
import type { ParsedDocument } from 'extraction/parsed-document'
import type { ExtractionController } from './useExtraction'
import type { ExtractionInspection } from './RightRail'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import type { SchemaRevision } from '../shared/schemaRevision.contract'
import {
  createSchemaEditorController,
  localSchemaPersistence,
  type SchemaEditorController,
} from './currentSchemaRevision'

vi.mock('./ResultsTab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ResultsTab')>()
  return { ...actual, default: vi.fn(actual.default) }
})

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
    requiredCount: 0,
    untouchedCount: 0,
    isTouched: () => false,
    reviewedExtractionId: null,
    error: null,
    draftError: null,
    draftSaving: false,
    draftSaved: false,
    retryDraft: () => {},
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

describe('RightRail developer UI visibility', () => {
  it('jumps from Results to the current draft while closing a historical preview', async () => {
    const historical: SchemaRevision = { schemaRevisionId: 'revision-1', extractionSchemaId: 'schema-1', revisionNumber: 1,
      origin: 'researcher-edit', createdAt: '2026-09-30T00:00:00Z', recordDescription: 'One record.', recordScope: null,
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
        inspection={{ ...defaultInspection, attempt, pinnedSchema: historical }} currentSchemaRevision={null}
        sourceDocumentName="test.pdf" sourceRepresentationId="source-1" onSelectEvidence={() => {}} onResultPathChange={() => {}} />
    }
    render(<Rail />)
    expect(screen.getByText(/Review attention · 1 to check/).closest('details')).toHaveAttribute('open')
    // The value is its own Evidence link (decision 14), and the Review attention row's "Edit field" stays.
    expect(screen.getByRole('button', { name: 'View Evidence for title' })).toHaveTextContent('Report')
    expect(screen.queryByText('Evidence')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit field' }))
    expect(schema.snapshot().historicalPreview).toBeNull()
    expect(schema.snapshot().draft).toEqual(draft)
    expect(screen.getByText(/This field was removed. No replacement was selected/)).toBeVisible()
    expect(screen.getByRole('button', { name: 'Edit gender' })).toBeVisible()
  })

  it('a tab badge stays on one line at the 264px rail; the tab\'s label gives way first', () => {
    renderRail({ extraction: { ...defaultController, hasResults: true, review: { ...defaultController.review, untouchedCount: 6 } } })
    // (jsdom computes the name without the flex layout's space between the label and the badge.)
    const results = screen.getByRole('tab', { name: /^Results\s*6 to check$/ })
    // Under a 300px tab strip (the 264px rail) the badge shows its number only; its full words are its name and title,
    // and "Results" stays whole.
    const badge = within(results).getByRole('img', { name: '6 to check' })
    expect(badge).toHaveAttribute('title', '6 to check')
    expect(badge.className).toMatch(/(^|\s)whitespace-nowrap(\s|$)/)
    expect(badge.className).toMatch(/(^|\s)shrink-0(\s|$)/)
    expect(within(badge).getByText('6 to check').className).toMatch(/(^|\s)@max-\[300px\]:hidden(\s|$)/)
    expect(within(badge).getByText('6').className).toMatch(/(^|\s)hidden(\s|$)/)
    expect(within(badge).getByText('6').className).toMatch(/(^|\s)@max-\[300px\]:inline(\s|$)/)
    expect(screen.getByRole('tablist').className).toMatch(/(^|\s)@container(\s|$)/)
    const label = within(results).getByText('Results')
    expect(label.className).toMatch(/(^|\s)min-w-0(\s|$)/)
    expect(results.className).toMatch(/(^|\s)min-w-0(\s|$)/)
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

describe('RightRail evidence pages', () => {
  it('hands the Results tab each Evidence anchor\'s first page, for the export\'s Evidence sheet', () => {
    const parsedDocument = { evidence_index: { anchors: [
      { anchor_id: 'a_p1_s1', producer_observations: [{ page_number: 1 }] },
      { anchor_id: 'a_p3_s2', producer_observations: [{ page_number: 3 }, { page_number: 4 }] },
    ] } } as unknown as ParsedDocument
    renderRail({ tab: 'results', inspection: { ...defaultInspection, parsedDocument } })

    const props = vi.mocked(ResultsTab).mock.lastCall![0]
    expect(props.evidencePages).toEqual(new Map([['a_p1_s1', 1], ['a_p3_s2', 3]]))
  })
})
