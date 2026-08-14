// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportExtractionResult } from 'extraction-result-export'
import ResultsTab from './ResultsTab'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import type { SchemaDefinition } from '../shared/schemaNode'

vi.mock('extraction-result-export', () => ({
  exportExtractionResult: vi.fn(async () => {}),
}))

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(exportExtractionResult).mockReset()
  vi.mocked(exportExtractionResult).mockResolvedValue(undefined)
})

function controller(
  state: ExtractionController['state'],
  attempt: ExtractionAttempt | null = null,
): ExtractionController {
  return {
    state,
    attempt,
    canRun: true,
    hasResults: state.status === 'ready',
    runExtraction: async () => {},
    retryExtraction: vi.fn(async () => {}),
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
}

const catalogAttempt: ExtractionAttempt = {
  extractionId: '11111111-1111-4111-8111-111111111111',
  sourceDocumentId: '44444444-4444-4444-8444-444444444444',
  sourceRepresentationRevisionId: '22222222-2222-4222-8222-222222222222',
  schemaRevisionId: '33333333-3333-4333-8333-333333333333',
  strategy: 'CATALOG',
  outcome: 'SUCCEEDED',
  complete: false,
  modelAttribution: { provider: 'ollama', modelId: 'fixture' },
  diagnostics: {
    phase: 'grounding', durationMs: 42, modelCalls: 4,
    finishReason: 'length', inputTokens: 10, outputTokens: 20,
    values: null, grounding: null,
    catalog: {
      stages: [
        { stage: 'discovery', outcome: 'succeeded', finishReason: 'stop', calls: 1, inputTokens: 2, outputTokens: 3, durationMs: 4, failureCode: null },
      ],
      records: [
        {
          ordinal: 0, outcome: 'succeeded', finishReason: 'stop', calls: 1,
          inputTokens: 4, outputTokens: 5, durationMs: 6, failureCode: null,
          boundary: { startBlockId: 'heading-1', startContentIndex: 2, endContentIndex: 5, headingText: 'First place', headingLevel: 2 },
        },
        {
          ordinal: 1, outcome: 'not_attempted', finishReason: null, calls: 0,
          inputTokens: null, outputTokens: null, durationMs: 0, failureCode: 'not_attempted_limit',
          boundary: { startBlockId: 'heading-2', startContentIndex: 5, endContentIndex: 8, headingText: 'Second place', headingLevel: 2 },
        },
      ],
    },
  },
  failure: null,
  resultPayload: { records: [{ place: 'First place' }] },
  evidenceLinks: [],
  reviewable: true,
  retryOfId: null,
  batchExtractionId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  reviewedAt: null,
  reviewDecisions: [],
}

const currentExportSchema: SchemaDefinition = {
  recordDescription: 'Current findings',
  schemaNodes: [
    {
      id: 'context',
      name: 'context',
      type: 'object',
      children: [
        { id: 'title', name: 'title', type: 'string' },
        { id: 'tags', name: 'tags', type: 'array', itemType: 'string' },
      ],
    },
  ],
}

const historicalExportSchema: SchemaDefinition = {
  recordDescription: 'Historical findings',
  schemaNodes: [
    {
      id: 'findings',
      name: 'findings',
      type: 'array',
      children: [{ id: 'value', name: 'value', type: 'string' }],
    },
  ],
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
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
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
          ungroundedCount: 0,
        })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
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
    expect(screen.queryByText(/could not be grounded/)).not.toBeInTheDocument()
  })

  it('reports the persisted ungrounded value count', () => {
    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: { title: 'Report', place: 'Unknown' },
          evidenceLinks: [],
          ungroundedCount: 2,
        })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(
      screen.getByText(
        '2 values could not be grounded and will not create Evidence highlights.',
      ),
    ).toBeInTheDocument()
  })

  it('hides the Article records envelope while preserving Evidence paths', () => {
    const onSelectEvidence = vi.fn()
    const onResultPathChange = vi.fn()
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
          ungroundedCount: 0,
        })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
        onSelectEvidence={onSelectEvidence}
        onResultPathChange={onResultPathChange}
      />,
    )

    expect(screen.queryByText('records', { exact: true })).not.toBeInTheDocument()
    expect(screen.queryByText('Item 1', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText('Report')).toBeInTheDocument()
    expect(onResultPathChange).toHaveBeenLastCalledWith(['records', '0'])
    fireEvent.click(
      screen.getByRole('button', { name: 'View Evidence for title' }),
    )
    expect(onSelectEvidence).toHaveBeenCalledWith('anchor-1')

    fireEvent.click(screen.getByRole('button', { name: 'Raw JSON' }))
    expect(screen.getByText(/"title": "Report"/)).toBeInTheDocument()
    expect(screen.queryByText(/"records"/)).not.toBeInTheDocument()
  })

  it('hides the Article envelope for multiple returned records', () => {
    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: { records: [{ title: 'First' }, { title: 'Second' }] },
          evidenceLinks: [],
          ungroundedCount: 0,
        })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(screen.queryByText('records', { exact: true })).not.toBeInTheDocument()
    expect(screen.getByText('Item 1')).toBeInTheDocument()
    expect(screen.getByText('Item 2')).toBeInTheDocument()
  })

  it('shows successful partial Catalog records and persisted diagnostics without placeholders', () => {
    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: catalogAttempt.resultPayload!,
          evidenceLinks: [],
          ungroundedCount: 0,
        }, catalogAttempt)}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(screen.getByText('Incomplete Extraction')).toBeInTheDocument()
    expect(screen.getAllByText('First place').length).toBeGreaterThan(0)
    expect(screen.getByText('Run details')).toBeVisible()
    expect(screen.getByText('discovery · succeeded')).not.toBeVisible()

    fireEvent.click(screen.getByText('Run details'))

    expect(screen.queryByText('Second place', { exact: true })).toBeInTheDocument()
    expect(screen.queryByText('Missing')).not.toBeInTheDocument()
    expect(screen.getByText('discovery · succeeded')).toBeVisible()
    expect(screen.getByText('Record 1 · succeeded · First place')).toBeInTheDocument()
    expect(screen.getByText('Record 2 · not attempted · Second place')).toBeInTheDocument()

    fireEvent.click(screen.getAllByText('Technical details').at(-1)!)
    expect(screen.getByText('not_attempted_limit')).toBeInTheDocument()
    expect(screen.getAllByText('Record identity').length).toBeGreaterThan(0)
    expect(screen.getByText('heading-2')).toBeInTheDocument()
  })

  it('bounds a large Catalog diagnostics list while keeping the result visible', () => {
    const catalog = catalogAttempt.diagnostics.catalog
    if (!catalog) throw new Error('Expected Catalog diagnostics')
    const records = Array.from({ length: 101 }, (_, ordinal) => ({
      ...catalog.records[0]!,
      ordinal,
      outcome: ordinal === 100 ? 'not_attempted' as const : 'succeeded' as const,
      failureCode: ordinal === 100 ? 'not_attempted_limit' : null,
      boundary: {
        ...catalog.records[0]!.boundary,
        startBlockId: `heading-${ordinal + 1}`,
        startContentIndex: ordinal,
        endContentIndex: ordinal + 1,
        headingText: `Record ${ordinal + 1}`,
      },
    }))
    const attempt = {
      ...catalogAttempt,
      diagnostics: { ...catalogAttempt.diagnostics, catalog: { ...catalog, records } },
    }

    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: catalogAttempt.resultPayload!,
          evidenceLinks: [],
          ungroundedCount: 0,
        }, attempt)}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    const runDetails = screen.getByText('Run details').parentElement
    expect(runDetails?.querySelector(':scope > div')).toHaveClass(
      'max-h-64',
      'overflow-y-auto',
    )
    fireEvent.click(screen.getByText('Run details'))
    expect(screen.getByTestId('catalog-record-diagnostics')).toHaveClass(
      'max-h-48',
      'overflow-y-auto',
    )
    expect(screen.getByText(/Record 101 · not attempted · Record 101/)).toBeInTheDocument()
    expect(screen.getAllByText('First place').length).toBeGreaterThan(0)
  })

  it('offers only failed Catalog components and submits selected or grounding-only retries', () => {
    const retryAttempt: ExtractionAttempt = {
      ...catalogAttempt,
      diagnostics: {
        ...catalogAttempt.diagnostics,
        catalog: {
          stages: [
            { stage: 'document-values', provenance: 'executed', outcome: 'failed', finishReason: 'stop', calls: 1, inputTokens: 2, outputTokens: 3, durationMs: 4, failureCode: 'invalid_model_output' },
            { stage: 'discovery', provenance: 'executed', outcome: 'failed', finishReason: 'length', calls: 1, inputTokens: 2, outputTokens: 3, durationMs: 4, failureCode: 'truncated' },
          ],
          records: [
            { ...catalogAttempt.diagnostics.catalog!.records[0]!, outcome: 'succeeded', provenance: 'reused', finishReason: 'length' },
            { ...catalogAttempt.diagnostics.catalog!.records[1]!, outcome: 'failed', provenance: 'reused', failureCode: 'record_failed' },
            { ...catalogAttempt.diagnostics.catalog!.records[1]!, ordinal: 2, outcome: 'not_attempted', provenance: 'reused', failureCode: 'not_attempted_limit', boundary: { ...catalogAttempt.diagnostics.catalog!.records[1]!.boundary, startBlockId: 'heading-3', headingText: 'Third place' } },
          ],
        },
      },
    }
    const retry = vi.fn(async () => {})
    const extraction = controller({
      status: 'ready',
      result: retryAttempt.resultPayload!,
      evidenceLinks: [],
      ungroundedCount: 0,
    }, retryAttempt)
    extraction.retryExtraction = retry
    render(<ResultsTab controller={extraction} schemaReady documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf" />)

    expect(screen.getByRole('checkbox', { name: 'Retry failed or truncated document metadata' })).not.toBeVisible()
    fireEvent.click(screen.getByText('Run details'))

    expect(screen.getByRole('checkbox', { name: 'Retry failed or truncated document metadata' })).toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'Rediscover Catalog record boundaries' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Retry record 2: Second place' })).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'Retry record 3: Third place' })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Retry record 1: First place' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Retry failed or truncated document metadata' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Rediscover Catalog record boundaries' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Retry record 2: Second place' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Retry record 3: Third place' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry selected components' }))
    expect(retry).toHaveBeenCalledWith({
      retryDocument: true,
      rediscover: true,
      retryRecordStartBlockIds: ['heading-2', 'heading-3'],
    })

    fireEvent.click(screen.getByRole('button', { name: 'Grounding only' }))
    expect(retry).toHaveBeenLastCalledWith({
      retryDocument: false,
      rediscover: false,
      retryRecordStartBlockIds: [],
    })
  })

  it('does not offer targeted retry controls for Article attempts', () => {
    const article = { ...catalogAttempt, strategy: 'ARTICLE' as const, diagnostics: { ...catalogAttempt.diagnostics, catalog: null } }
    render(<ResultsTab controller={controller({ status: 'ready', result: article.resultPayload!, evidenceLinks: [], ungroundedCount: 0 }, article)} schemaReady documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf" />)
    fireEvent.click(screen.getByText('Run details'))
    expect(screen.queryByRole('region', { name: 'Targeted Catalog retry' })).not.toBeInTheDocument()
  })

  it('offers a new run after cancellation', () => {
    render(
      <ResultsTab
        controller={controller({ status: 'cancelled' })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(screen.getByText('Extraction cancelled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run a new extraction' })).toBeInTheDocument()
  })

  it('exports the current displayed result to Excel with nested and scalar-array schema paths', () => {
    const currentResult = { records: [{ context: { title: 'Current', tags: ['a'] } }] }
    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: currentResult,
          evidenceLinks: [],
          ungroundedCount: 0,
        })}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="current.pdf"
        exportSchema={currentExportSchema}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Excel' }))

    expect(exportExtractionResult).toHaveBeenCalledWith(
      { context: { title: 'Current', tags: ['a'] } },
      {
        format: 'xlsx',
        filename: 'current.pdf',
        columns: ['context.title', 'context.tags.0'],
      },
    )
  })

  it('exports the inspected historical result to CSV with its historical schema', () => {
    const historicalAttempt: ExtractionAttempt = {
      ...catalogAttempt,
      extractionId: '55555555-5555-4555-8555-555555555555',
      resultPayload: { records: [{ findings: [{ value: 'Historical' }] }] },
    }
    render(
      <ResultsTab
        controller={controller({
          status: 'ready',
          result: { records: [{ context: { title: 'Current' } }] },
          evidenceLinks: [],
          ungroundedCount: 0,
        })}
        inspectedAttempt={historicalAttempt}
        readOnly
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="historical.pdf"
        exportSchema={historicalExportSchema}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'CSV' }))

    expect(exportExtractionResult).toHaveBeenCalledWith(
      { findings: [{ value: 'Historical' }] },
      {
        format: 'csv',
        filename: 'historical.pdf',
        columns: ['findings.0.value'],
      },
    )
  })
})
