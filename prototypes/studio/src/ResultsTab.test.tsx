// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCallback, useState } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportExtractionResult } from 'extraction-result-export'
import ResultsTab from './ResultsTab'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt, ReviewDecisionInput } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { SchemaDefinition } from 'extraction/schema'

vi.mock('extraction-result-export', async (importOriginal) => ({
  ...await importOriginal<typeof import('extraction-result-export')>(),
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
  reviewOverrides: Partial<ExtractionController['review']> = {},
): ExtractionController {
  return {
    state,
    attempt,
    canRun: true,
    hasResults: state.status === 'ready',
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
      isTouched: () => true,
      reviewedExtractionId: null,
      error: null,
      draftError: null,
      draftSaving: false,
      retryDraft: () => {},
      setDecision: () => {},
      approveAll: () => {},
      accept: async () => {},
      ...reviewOverrides,
    },
  }
}

const defaultRunProps = {
  onRunExtraction: async () => undefined,
  runExtractionDisabled: false,
}

const articleAttempt: ExtractionAttempt = {
  extractionId: '11111111-1111-4111-8111-111111111111',
  sourceDocumentId: '44444444-4444-4444-8444-444444444444',
  sourceRepresentationRevisionId: '22222222-2222-4222-8222-222222222222',
  schemaRevisionId: '33333333-3333-4333-8333-333333333333',
  strategy: 'ARTICLE',
  executionStatus: 'COMPLETED',
  outcome: 'SUCCEEDED',
  complete: false,
  modelAttribution: { provider: 'ollama', modelId: 'fixture' },
  diagnostics: {
    phase: 'grounding', durationMs: 42, modelCalls: 4,
    finishReason: 'length', inputTokens: 10, outputTokens: 20,
    grounding: null,
    catalog: null,
  },
  failure: null,
  resultPayload: { records: [{ place: 'First place' }] },
  evidenceLinks: [],
  reviewable: true,
  batchExtractionId: null,
  createdAt: '2026-08-10T00:00:00.000Z',
  reviewedAt: null,
  reviewDecisions: [],
}
const catalogCall = {
  provenance: 'executed' as const,
  outcome: 'succeeded' as const,
  finishReason: 'stop',
  calls: 1,
  inputTokens: 1,
  outputTokens: 1,
  durationMs: 1,
  failureCode: null,
}

function catalogBoundary(index: number, heading: string) {
  return {
    startBlockId: `h${index}`,
    startContentIndex: index * 2,
    endContentIndex: index * 2 + 2,
    headingText: heading,
    headingLevel: 2,
  }
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
  it('orders historical reviewed values by their pinned schema, falling back to payload order without it', () => {
    const historical = { ...articleAttempt, resultPayload: { records: [{ year: 2020, title: 'Grounded' }] },
      reviewedAt: '2026-09-06T00:00:00Z', reviewDecisions: [
        { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor', reviewedOccurrenceIds: [], action: 'EDITED' as const, reviewedValue: 'Corrected', createdAt: '2026-09-06T00:00:00Z' },
        { resultPath: ['records', 0, 'year'], evidenceAnchorId: 'anchor', reviewedOccurrenceIds: [], action: 'REJECTED' as const, reviewedValue: null, createdAt: '2026-09-06T00:00:00Z' },
      ] }
    const props = { ...defaultRunProps, controller: controller({ status: 'idle' }), schemaReady: true,
      documentMarkdown: '', sourceDocumentName: 'Source', inspectedAttempt: historical,
      exportSchema: { recordDescription: 'Current', schemaNodes: [{ id: 'year', name: 'year', type: 'integer' as const }] } }
    const { container, rerender } = render(<ResultsTab {...props} pinnedSchema={{ recordDescription: 'Historical', schemaNodes: [
      { id: 'title', name: 'title', type: 'string' }, { id: 'year', name: 'year', type: 'integer' },
    ] }} />)
    fireEvent.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(container.querySelector('pre')!.textContent).toBe(JSON.stringify({ title: 'Corrected', year: null }, null, 2))
    rerender(<ResultsTab {...props} />)
    expect(container.querySelector('pre')!.textContent).toBe(JSON.stringify({ year: null, title: 'Corrected' }, null, 2))
    expect(historical.resultPayload.records[0]).toEqual({ year: 2020, title: 'Grounded' })
  })

  it('uses the pinned schema order in Review and Raw JSON', () => {
    const result = { records: [{ year: 2020, title: 'Grounded' }] }
    const { container } = render(<ResultsTab {...defaultRunProps}
      controller={controller({ status: 'ready', result, evidenceLinks: [], ungroundedCount: 0 })}
      schemaReady documentMarkdown="" sourceDocumentName="Source"
      pinnedSchema={{ recordDescription: 'Source', schemaNodes: [
        { id: 'title', name: 'title', type: 'string' },
        { id: 'year', name: 'year', type: 'integer' },
      ] }} />)
    expect(container.textContent!.indexOf('title')).toBeLessThan(container.textContent!.indexOf('year'))
    fireEvent.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(container.querySelector('pre')!.textContent).toBe(JSON.stringify({ title: 'Grounded', year: 2020 }, null, 2))
    expect(Object.keys(result.records[0])).toEqual(['year', 'title'])
  })

  it('shows checkpointed values while Evidence linking keeps export and review disabled', () => {
    const provisional: ExtractionAttempt = {
      ...articleAttempt,
      executionStatus: 'RUNNING',
      outcome: null,
      evidenceLinks: null,
      reviewable: false,
      reviewedAt: null,
      reviewDecisions: [],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({
          status: 'ready',
          result: provisional.resultPayload!,
          evidenceLinks: [],
          ungroundedCount: 0,
        }, provisional)}
        schemaReady
        exportSchema={currentExportSchema}
        documentMarkdown="# Source"
        sourceDocumentName="source.pdf"
      />,
    )

    expect(screen.getByText('Values extracted · linking Evidence…')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Rerun' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save Review' })).not.toBeInTheDocument()
  })

  it('renders markup-like schema names and extracted values as inert text', () => {
    const fieldName = '<script>field-secret</script>'
    const value = '<img src=x onerror="value-secret">'
    const attempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ [fieldName]: value }] },
      evidenceLinks: [
        {
          resultPath: ['records', 0, fieldName],
          evidenceAnchorId: 'anchor-markup',
        },
      ],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          {
            status: 'ready',
            result: attempt.resultPayload!,
            evidenceLinks: attempt.evidenceLinks!,
            ungroundedCount: 0,
          },
          attempt,
        )}
        schemaReady
        pinnedSchema={{
          recordDescription: '<b>record-secret</b>',
          schemaNodes: [{ id: 'markup', name: fieldName, type: 'string' }],
        }}
        documentMarkdown="# Source"
        sourceDocumentName="<svg onload='source-secret'>.pdf"
      />,
    )

    expect(screen.getByText(value, { exact: true })).toBeVisible()
    expect(screen.getByText(fieldName, { exact: true })).toBeVisible()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    // Button icons are real <svg> elements, so the guard is that nothing from
    // the injected strings became markup: no element carries their handler.
    expect(document.querySelector('[onload]')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(screen.getByText(new RegExp('value-secret'))).toBeVisible()
    expect(document.querySelector('img[src="x"]')).toBeNull()
  })

  it('shows one server-owned progress state without raw output', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({
          status: 'running',
          step: 'extraction',
        })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(screen.getByText('Running extraction…')).toBeInTheDocument()
    expect(screen.queryByText('Report')).not.toBeInTheDocument()
  })

  it('labels queued work before the worker starts it', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          { status: 'running', step: 'extraction' },
          {
            ...articleAttempt,
            executionStatus: 'QUEUED',
            outcome: null,
            resultPayload: null,
            evidenceLinks: null,
            reviewable: false,
          },
        )}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(screen.getByText('Queued extraction…')).toBeInTheDocument()
    expect(screen.queryByText('Running extraction…')).not.toBeInTheDocument()
  })

  it('offers canonical Evidence navigation only for linked scalar paths', () => {
    const onSelectEvidence = vi.fn()
    render(
      <ResultsTab
        {...defaultRunProps}
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

  it('marks links whose value is absent from, or not unique to, the passage', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({
          status: 'ready',
          result: { title: 'Report', place: 'Ravenna', year: 1901, legacy: 'Old' },
          evidenceLinks: [
            { resultPath: ['title'], evidenceAnchorId: 'anchor-1', verbatim: true, lexicalHits: 1 },
            { resultPath: ['place'], evidenceAnchorId: 'anchor-2', verbatim: true, lexicalHits: 3 },
            { resultPath: ['year'], evidenceAnchorId: 'anchor-3', verbatim: false, lexicalHits: 0 },
            { resultPath: ['legacy'], evidenceAnchorId: 'anchor-4' },
          ],
          ungroundedCount: 0,
        })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
        onSelectEvidence={vi.fn()}
      />,
    )

    expect(screen.getByRole('note', { name: 'Value also appears in 2 other passages' })).toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'Value not found in the linked passage' })).toBeInTheDocument()
    expect(screen.getAllByRole('note')).toHaveLength(2)
    expect(screen.getByText('To check:')).toBeInTheDocument()
  })

  it.each(['EDITED', 'REJECTED'] as const)('clears original-value warnings for %s decisions and restores them when reversed', (action) => {
    const result = { records: [{ material: 'iron' }] }
    const evidenceLinks = [{
      resultPath: ['records', 0, 'material'], evidenceAnchorId: 'anchor-material',
      verbatim: false, lexicalHits: 0,
    }]
    const initialDecision: ReviewDecisionInput = {
      resultPath: ['records', 0, 'material'], evidenceAnchorId: 'anchor-material',
      reviewedOccurrenceIds: ['occurrence-material'], action: 'APPROVED', reviewedValue: null,
    }
    const props = {
      ...defaultRunProps, schemaReady: true,
      documentMarkdown: 'bronze', sourceDocumentName: 'source.pdf',
    }
    const withDecision = (decision: ReviewDecisionInput) => controller(
      { status: 'ready', result, evidenceLinks, ungroundedCount: 0 },
      null,
      { decisions: [decision] },
    )
    const { rerender } = render(<ResultsTab {...props} controller={withDecision(initialDecision)} />)
    expect(screen.getByRole('note', { name: 'Value not found in the linked passage' })).toBeInTheDocument()
    expect(screen.getByText('To check:')).toHaveTextContent('To check: 1')

    rerender(<ResultsTab {...props} controller={withDecision({
      ...initialDecision, action, reviewedValue: action === 'EDITED' ? 'bronze' : null,
    })} />)
    if (action === 'EDITED') expect(screen.getByText('bronze')).toBeInTheDocument()
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(screen.queryByText('To check:')).not.toBeInTheDocument()

    rerender(<ResultsTab {...props} controller={withDecision(initialDecision)} />)
    expect(screen.getByText('iron')).toBeInTheDocument()
    expect(screen.getByRole('note', { name: 'Value not found in the linked passage' })).toBeInTheDocument()
    expect(screen.getByText('To check:')).toHaveTextContent('To check: 1')
  })

  it('reports the persisted ungrounded value count', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
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
        '2 values could not be grounded. No Review Decisions can be saved; they will remain recorded without Evidence.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('No reviewable result')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save Review' })).not.toBeInTheDocument()
  })

  it('hides the Article records envelope while preserving Evidence paths', () => {
    const onSelectEvidence = vi.fn()
    const onResultPathChange = vi.fn()
    render(
      <ResultsTab
        {...defaultRunProps}
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

    fireEvent.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(screen.getByText(/"title": "Report"/)).toBeInTheDocument()
    expect(screen.queryByText(/"records"/)).not.toBeInTheDocument()
  })

  it('hides the Article envelope for multiple returned records', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
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

  it('offers a new run after cancellation', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({ status: 'cancelled' })}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(screen.getByText('Extraction cancelled')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run a new extraction' })).toBeInTheDocument()
  })

  it('renders Catalog diagnostics behind Run details and offers a generic rerun', () => {
    const catalogAttempt: ExtractionAttempt = {
      ...articleAttempt,
      strategy: 'CATALOG',
      diagnostics: {
        ...articleAttempt.diagnostics!,
        catalog: {
          stages: [
            { ...catalogCall, stage: 'document-values', outcome: 'not_attempted', calls: 0, finishReason: null },
            { ...catalogCall, stage: 'discovery', provenance: 'reused', calls: 0, inputTokens: null, outputTokens: null, durationMs: 0 },
            { ...catalogCall, stage: 'record-values', outcome: 'failed', failureCode: 'extraction_failed' },
            { ...catalogCall, stage: 'grounding' },
          ],
          records: [
            { ...catalogCall, provenance: 'reused', calls: 0, inputTokens: null, outputTokens: null, durationMs: 0, ordinal: 0, boundary: catalogBoundary(0, 'First entry') },
            { ...catalogCall, ordinal: 1, outcome: 'failed', failureCode: 'extraction_failed', boundary: catalogBoundary(1, 'Second entry') },
            { ...catalogCall, ordinal: 2, outcome: 'not_attempted', calls: 0, failureCode: 'not_attempted_limit', boundary: catalogBoundary(2, 'Third entry') },
          ],
        },
      },
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({
          status: 'ready',
          result: catalogAttempt.resultPayload!,
          evidenceLinks: [],
          ungroundedCount: 0,
        }, catalogAttempt)}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Catalog.pdf"
      />,
    )

    // Incomplete banner is visible without opening diagnostics.
    expect(screen.getByText('Incomplete Extraction')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rerun' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    // Stage and record diagnostics render inside the bounded disclosure.
    expect(screen.getByTestId('catalog-record-diagnostics')).toBeInTheDocument()
    expect(screen.getByText(/Record 2 · failed · executed · Second entry/)).toBeInTheDocument()
    expect(screen.getByText(/Record 3 · not attempted · executed · Third entry/)).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog stage discovery: succeeded, reused')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog record 1: succeeded, reused, First entry')).toBeInTheDocument()
  })

  it('names the model each role ran on in the run\'s technical details, when kei-exp reported them', () => {
    const renderWith = (attempt: ExtractionAttempt) => render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({
          status: 'ready', result: attempt.resultPayload!, evidenceLinks: [], ungroundedCount: 0,
        }, attempt)}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Article.pdf"
      />,
    )
    renderWith({
      ...articleAttempt,
      requestedModels: { fields: 'nuextract' },
      modelAttribution: { provider: 'kei-exp', modelId: 'numind/NuExtract3-FP8' },
      diagnostics: { ...articleAttempt.diagnostics!, models: { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' } },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    expect(screen.getByText('Field model').nextElementSibling).toHaveTextContent('numind/NuExtract3-FP8')
    expect(screen.getByText('Reasoning model').nextElementSibling).toHaveTextContent('Qwen/Qwen3.8-27B-FP8')
    cleanup()

    renderWith(articleAttempt)
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    expect(screen.getByText('Phase')).toBeInTheDocument()
    expect(screen.queryByText('Field model')).not.toBeInTheDocument()
  })

  it('offers Retry extraction for a failed Catalog attempt', () => {
    const failed: ExtractionAttempt = {
      ...articleAttempt,
      strategy: 'CATALOG',
      executionStatus: 'COMPLETED',
      outcome: 'FAILED',
      complete: null,
      failure: { code: 'catalog_no_records', message: 'Catalog discovery returned no records.' },
      resultPayload: null,
      evidenceLinks: null,
      reviewable: false,
    }
    const onRunExtraction = vi.fn()
    render(
      <ResultsTab
        {...defaultRunProps}
        onRunExtraction={onRunExtraction}
        controller={controller({ status: 'error', message: 'Catalog discovery returned no records.' }, failed)}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="Catalog.pdf"
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry extraction' }))
    expect(onRunExtraction).toHaveBeenCalledOnce()
  })

  it('renders executed and reused provenance for an inspected Catalog child', () => {
    const child: ExtractionAttempt = {
      ...articleAttempt,
      extractionId: '66666666-6666-4666-8666-666666666666',
      strategy: 'CATALOG',
      complete: true,
      diagnostics: {
        ...articleAttempt.diagnostics!,
        catalog: {
          stages: [
            { ...catalogCall, stage: 'document-values', provenance: 'reused', calls: 0, inputTokens: null, outputTokens: null, durationMs: 0 },
            { ...catalogCall, stage: 'discovery', provenance: 'reused', calls: 0, inputTokens: null, outputTokens: null, durationMs: 0 },
            { ...catalogCall, stage: 'record-values' },
            { ...catalogCall, stage: 'grounding' },
          ],
          records: [
            { ...catalogCall, provenance: 'reused', calls: 0, inputTokens: null, outputTokens: null, durationMs: 0, ordinal: 0, boundary: catalogBoundary(0, 'First entry') },
            { ...catalogCall, ordinal: 1, boundary: catalogBoundary(1, 'Second entry') },
          ],
        },
      },
      resultPayload: {
        records: [{ place: 'First place' }, { place: 'Second place' }],
      },
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({ status: 'idle' })}
        inspectedAttempt={child}
        readOnly
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="Catalog.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    expect(screen.getByLabelText('Catalog stage document-values: succeeded, reused')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog stage record-values: succeeded, executed')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog record 1: succeeded, reused, First entry')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog record 2: succeeded, executed, Second entry')).toBeInTheDocument()
  })

  it('exports the current displayed result to Excel with nested and scalar-array schema paths', () => {
    const currentResult = { records: [{ context: { title: 'Current', tags: ['a'] } }] }
    render(
      <ResultsTab
        {...defaultRunProps}
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
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))

    expect(exportExtractionResult).toHaveBeenCalledWith(
      { context: { title: 'Current', tags: ['a'] } },
      {
        format: 'xlsx',
        filename: 'current.pdf',
        schemaNodes: currentExportSchema.schemaNodes,
        choices: { rowsRepresent: '$', otherRepeatedFields: 'preserve' },
      },
    )
  })

  it('exports the inspected historical result to CSV with its historical schema', () => {
    const historicalAttempt: ExtractionAttempt = {
      ...articleAttempt,
      extractionId: '55555555-5555-4555-8555-555555555555',
      resultPayload: { records: [{ findings: [{ value: 'Historical' }] }] },
    }
    render(
      <ResultsTab
        {...defaultRunProps}
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
    fireEvent.change(screen.getByLabelText('Rows represent'), { target: { value: 'findings' } })
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))

    expect(exportExtractionResult).toHaveBeenCalledWith(
      { findings: [{ value: 'Historical' }] },
      {
        format: 'csv',
        filename: 'historical.pdf',
        schemaNodes: historicalExportSchema.schemaNodes,
        choices: { rowsRepresent: 'findings', otherRepeatedFields: 'preserve' },
      },
    )
  })

  it('supports type-aware edit, reject, and reverse decisions on nested grounded values', () => {
    const setDecision = vi.fn()
    const attempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ person: { age: 5 } }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'person', 'age'],
        evidenceAnchorId: 'anchor-age',
      }],
    }
    const schema: SchemaDefinition = {
      recordDescription: 'One person.',
      schemaNodes: [{
        id: 'person', name: 'person', type: 'object', children: [
          { id: 'age', name: 'age', type: 'integer' },
        ],
      }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          {
            status: 'ready', result: attempt.resultPayload!,
            evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0,
          },
          attempt,
          {
            available: true,
            canAccept: true,
            decisions: [{
              resultPath: ['records', 0, 'person', 'age'],
              evidenceAnchorId: 'anchor-age',
              reviewedOccurrenceIds: ['occurrence-age'],
              action: 'APPROVED',
              reviewedValue: null,
            }],
            reviewedCount: 1,
            setDecision,
          },
        )}
        schemaReady
        pinnedSchema={schema}
        exportSchema={schema}
        documentMarkdown="# Source"
        sourceDocumentName="nested.pdf"
      />,
    )

    fireEvent.click(screen.getByText('person', { exact: true }))
    fireEvent.click(screen.getByRole('button', { name: 'Reject age' }))
    expect(setDecision).toHaveBeenLastCalledWith(
      ['records', 0, 'person', 'age'], 'REJECTED', null,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit age' }))
    const input = screen.getByLabelText('Reviewed value for age')
    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number.')
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.blur(input)
    expect(setDecision).toHaveBeenLastCalledWith(
      ['records', 0, 'person', 'age'], 'EDITED', 7,
    )
  })

  it('reverses a rejected value back to its original approved value', () => {
    const attempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ place: 'Original' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place',
      }],
    }
    const initialDecision = {
      resultPath: ['records', 0, 'place'] as (string | number)[],
      evidenceAnchorId: 'anchor-place',
      reviewedOccurrenceIds: ['occurrence-place'],
      action: 'APPROVED' as const,
      reviewedValue: null,
    }
    function Fixture() {
      const [decisions, setDecisions] = useState<ReviewDecisionInput[]>([initialDecision])
      return (
        <ResultsTab
          {...defaultRunProps}
          controller={controller(
            {
              status: 'ready', result: attempt.resultPayload!,
              evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0,
            },
            attempt,
            {
              available: true,
              canAccept: true,
              decisions,
              reviewedCount: 1,
              setDecision: (path, action, reviewedValue = null) =>
                setDecisions((current) => current.map((decision) => ({
                  ...decision,
                  ...(JSON.stringify(decision.resultPath) === JSON.stringify(path)
                    ? { action, reviewedValue }
                    : {}),
                }))),
            },
          )}
          schemaReady
          pinnedSchema={{
            recordDescription: 'One place.',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          }}
          documentMarkdown="# Source"
          sourceDocumentName="reverse.pdf"
        />
      )
    }
    render(<Fixture />)

    fireEvent.click(screen.getByRole('button', { name: 'Reject place' }))
    expect(screen.getByTitle('Rejected')).toBeInTheDocument()
    expect(screen.getByText('Missing')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reverse decision for place' }))
    expect(screen.getByTitle('Approved')).toBeInTheDocument()
    expect(screen.getByText('Original')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reverse decision for place' })).not.toBeInTheDocument()
  })

  it('hides the review badge and pressed state for an untouched, server-defaulted decision', () => {
    const attempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ place: 'Original' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place',
      }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          {
            status: 'ready', result: attempt.resultPayload!,
            evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0,
          },
          attempt,
          {
            available: true,
            canAccept: true,
            decisions: [{
              resultPath: ['records', 0, 'place'],
              evidenceAnchorId: 'anchor-place',
              reviewedOccurrenceIds: ['occurrence-place'],
              action: 'APPROVED',
              reviewedValue: null,
            }],
            reviewedCount: 1,
            untouchedCount: 1,
            isTouched: () => false,
          },
        )}
        schemaReady
        pinnedSchema={{
          recordDescription: 'One place.',
          schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
        }}
        documentMarkdown="# Source"
        sourceDocumentName="untouched.pdf"
      />,
    )

    expect(screen.queryByTitle('Approved')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve place' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('button', { name: 'Reverse decision for place' })).not.toBeInTheDocument()
  })

  it('lets the researcher bulk-approve every untouched field without disturbing explicit decisions', () => {
    const approveAll = vi.fn()
    const attempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ place: 'Original' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place',
      }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          {
            status: 'ready', result: attempt.resultPayload!,
            evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0,
          },
          attempt,
          {
            available: true,
            canAccept: true,
            decisions: [{
              resultPath: ['records', 0, 'place'],
              evidenceAnchorId: 'anchor-place',
              reviewedOccurrenceIds: ['occurrence-place'],
              action: 'APPROVED',
              reviewedValue: null,
            }],
            reviewedCount: 1,
            untouchedCount: 1,
            isTouched: () => false,
            approveAll,
          },
        )}
        schemaReady
        pinnedSchema={{
          recordDescription: 'One place.',
          schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
        }}
        documentMarkdown="# Source"
        sourceDocumentName="approve-all.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Approve remaining (1)' }))
    expect(approveAll).toHaveBeenCalledTimes(1)
  })

  it('renders saved Review Decisions read-only with their timestamp', () => {
    const historicalAttempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      reviewedAt: '2026-08-10T01:00:00.000Z',
      resultPayload: { records: [{ place: 'Revised place' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'place'],
        evidenceAnchorId: 'anchor-place',
      }],
      reviewDecisions: [{
        resultPath: ['records', 0, 'place'],
        evidenceAnchorId: 'anchor-place',
        reviewedOccurrenceIds: ['occurrence-place'],
        action: 'EDITED',
        reviewedValue: 'Revised place',
        createdAt: '2026-08-10T01:00:00.000Z',
      }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({ status: 'idle' })}
        inspectedAttempt={historicalAttempt}
        readOnly
        schemaReady
        pinnedSchema={{
          recordDescription: 'One place.',
          schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
        }}
        documentMarkdown="# Source"
        sourceDocumentName="historical.pdf"
      />,
    )

    expect(screen.getByTitle(/^Edited · /)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reject / })).not.toBeInTheDocument()
  })

  it('reports one result path when a parent stores a reviewed inspection path', () => {
    const inspectedAttempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      reviewedAt: '2026-08-10T01:00:00.000Z',
      evidenceLinks: [{
        resultPath: ['records', 0, 'place'],
        evidenceAnchorId: 'anchor-place',
      }],
      reviewDecisions: [{
        resultPath: ['records', 0, 'place'],
        evidenceAnchorId: 'anchor-place',
        reviewedOccurrenceIds: ['occurrence-place'],
        action: 'EDITED',
        reviewedValue: 'Revised place',
        createdAt: '2026-08-10T01:00:00.000Z',
      }],
    }
    const onResultPathChange = vi.fn<(path: string[] | null) => void>()
    const inspectionController = controller({ status: 'idle' })

    function Fixture() {
      const [, setResultPath] = useState<string[] | null>(null)
      const storeResultPath = useCallback((path: string[] | null) => {
        onResultPathChange(path)
        // Bound a regression so the test fails instead of exhausting React.
        if (onResultPathChange.mock.calls.length < 3) setResultPath(path)
      }, [])
      return (
        <ResultsTab
          {...defaultRunProps}
          controller={inspectionController}
          inspectedAttempt={inspectedAttempt}
          readOnly
          schemaReady
          pinnedSchema={{
            recordDescription: 'One place.',
            schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
          }}
          documentMarkdown="# Source"
          sourceDocumentName="historical.pdf"
          onResultPathChange={storeResultPath}
        />
      )
    }

    render(<Fixture />)

    expect(onResultPathChange).toHaveBeenCalledTimes(1)
    expect(onResultPathChange).toHaveBeenLastCalledWith(['records', '0'])
  })

  it('stops offering field-level review controls once its own attempt is already saved', () => {
    const setDecision = vi.fn()
    const savedAttempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      reviewedAt: '2026-08-10T01:00:00.000Z',
      resultPayload: { records: [{ place: 'Saved place' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place',
      }],
      reviewDecisions: [{
        resultPath: ['records', 0, 'place'],
        evidenceAnchorId: 'anchor-place',
        reviewedOccurrenceIds: ['occurrence-place'],
        action: 'APPROVED',
        reviewedValue: null,
        createdAt: '2026-08-10T01:00:00.000Z',
      }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          {
            status: 'ready', result: savedAttempt.resultPayload!,
            evidenceLinks: savedAttempt.evidenceLinks!, ungroundedCount: 0,
          },
          savedAttempt,
          {
            // A leftover pending decision from before "Save Review" was
            // clicked — must not still be reachable through the UI now
            // that the attempt itself is saved and read-only.
            available: true,
            canAccept: false,
            reviewedExtractionId: savedAttempt.extractionId,
            decisions: [{
              resultPath: ['records', 0, 'place'],
              evidenceAnchorId: 'anchor-place',
              reviewedOccurrenceIds: ['occurrence-place'],
              action: 'REJECTED',
              reviewedValue: null,
            }],
            reviewedCount: 1,
            setDecision,
          },
        )}
        schemaReady
        pinnedSchema={{
          recordDescription: 'One place.',
          schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
        }}
        documentMarkdown="# Source"
        sourceDocumentName="already-saved.pdf"
      />,
    )

    expect(screen.getByText('Saved place')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reject place' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit place' })).not.toBeInTheDocument()
  })

  it('exports reviewed edits and expands the exact used Schema Revision read-only', () => {
    const setDecision = vi.fn()
    const schema = {
      schemaRevisionId: articleAttempt.schemaRevisionId,
      revisionNumber: 3,
      recordDescription: 'Pinned result.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' as const }],
    }
    const attempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ place: 'Original' }] },
      evidenceLinks: [{
        resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place',
      }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          {
            status: 'ready', result: attempt.resultPayload!,
            evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0,
          },
          attempt,
          {
            available: true,
            canAccept: true,
            decisions: [{
              resultPath: ['records', 0, 'place'],
              evidenceAnchorId: 'anchor-place',
              reviewedOccurrenceIds: ['occurrence-place'],
              action: 'EDITED',
              reviewedValue: 'Reviewed',
            }],
            reviewedCount: 1,
            setDecision,
          },
        )}
        schemaReady
        pinnedSchema={schema}
        exportSchema={schema}
        documentMarkdown="# Source"
        sourceDocumentName="reviewed.pdf"
      />,
    )

    expect(screen.getByText('Reviewed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Export' }))
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
    expect(exportExtractionResult).toHaveBeenCalledWith(
      { place: 'Reviewed' },
      expect.objectContaining({ format: 'csv', schemaNodes: schema.schemaNodes }),
    )
    expect(screen.getByText('Using Schema Revision 3')).toBeInTheDocument()
    const disclosure = screen.getByRole('button', { name: 'View used schema' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(disclosure)
    expect(screen.getByRole('button', { name: 'Hide used schema' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText(new RegExp(articleAttempt.schemaRevisionId)).closest('p')).toHaveTextContent('Schema Revision 3 · ')
    expect(screen.getByText(new RegExp(articleAttempt.schemaRevisionId)).closest('p')).toHaveTextContent('read-only')
    expect(screen.getByText(/"place": "string"/)).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: 'Pinned schema' })).not.toBeInTheDocument()
  })
})

describe('ResultsTab extraction status', () => {
  const currentRevision = { schemaRevisionId: '99999999-9999-4999-8999-999999999999', revisionNumber: 4 }
  const usedSchema = {
    schemaRevisionId: articleAttempt.schemaRevisionId,
    revisionNumber: 3,
    recordDescription: 'Used result.',
    schemaNodes: [{ id: 'place', name: 'place', type: 'string' as const }],
  }
  const queuedAttempt: ExtractionAttempt = {
    ...articleAttempt,
    executionStatus: 'QUEUED',
    outcome: null,
    complete: null,
    modelAttribution: null,
    diagnostics: null,
    resultPayload: null,
    evidenceLinks: null,
    reviewable: false,
  }

  it('keeps status, revision comparison and used schema readable while queued', () => {
    const requestCancellation = vi.fn(async () => {})
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={{ ...controller({ status: 'running', step: 'extraction' }, queuedAttempt), requestCancellation }}
        schemaReady
        pinnedSchema={usedSchema}
        currentSchemaRevision={currentRevision}
        documentMarkdown="# Source"
        sourceDocumentName="queued.pdf"
      />,
    )

    expect(screen.getByText('Queued')).toBeInTheDocument()
    expect(screen.getByText('Previous schema')).toBeInTheDocument()
    expect(screen.getByText('Using Schema Revision 3 · Current revision: 4')).toBeInTheDocument()
    expect(screen.getByText('You can continue working on other documents.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'View used schema' }))
    expect(screen.getByText(/"place": "string"/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel extraction' }))
    expect(requestCancellation).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: 'Run with current schema' })).not.toBeInTheDocument()
  })

  it('disables both cancellation controls once requested and shows a cancellation failure apart', () => {
    const { rerender } = render(
      <ResultsTab
        {...defaultRunProps}
        controller={{ ...controller({ status: 'running', step: 'extraction' }, { ...queuedAttempt, executionStatus: 'RUNNING' }), cancellationRequested: true }}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="running.pdf"
      />,
    )
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancellation requested…' })).toBeDisabled()

    rerender(
      <ResultsTab
        {...defaultRunProps}
        controller={{ ...controller({ status: 'running', step: 'extraction' }, { ...queuedAttempt, executionStatus: 'RUNNING' }), cancellationError: 'Cancellation failed (HTTP 500)' }}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="running.pdf"
      />,
    )
    expect(screen.getByRole('button', { name: 'Cancel extraction' })).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Cancellation failed: Cancellation failed (HTTP 500)')
  })

  it('avoids inventing a revision while the used schema is still loading', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({ status: 'running', step: 'extraction' }, { ...queuedAttempt, executionStatus: 'RUNNING' })}
        schemaReady
        currentSchemaRevision={{ ...currentRevision, schemaRevisionId: articleAttempt.schemaRevisionId }}
        documentMarkdown="# Source"
        sourceDocumentName="running.pdf"
      />,
    )
    expect(screen.getByText('Using Schema Revision (loading…) · Current revision: 4')).toBeInTheDocument()
    expect(screen.queryByText('Previous schema')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'View used schema' })).toBeDisabled()
  })

  it('keeps the last known status and offers Reconnect after a lost connection', () => {
    const reconnect = vi.fn()
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={{
          ...controller({ status: 'ready', result: { records: [{ place: 'Rome' }] }, evidenceLinks: [], ungroundedCount: 0 }, { ...articleAttempt, executionStatus: 'RUNNING', outcome: null, resultPayload: { records: [{ place: 'Rome' }] }, evidenceLinks: null, reviewable: false }),
          monitorError: 'Unable to update status. The extraction may still be running.',
          reconnect,
        }}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="provisional.pdf"
      />,
    )

    expect(screen.getByText('Running · provisional results')).toBeInTheDocument()
    expect(screen.getByText('Values extracted · linking Evidence…')).toBeInTheDocument()
    expect(screen.getByText('Unable to update status. The extraction may still be running.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('offers one Run with current schema action for a completed previous-schema result and keeps review open', () => {
    const onRunExtraction = vi.fn()
    const setDecision = vi.fn()
    const attempt: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ place: 'Original' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place' }],
    }
    render(
      <ResultsTab
        onRunExtraction={onRunExtraction}
        runExtractionDisabled={false}
        controller={controller(
          { status: 'ready', result: attempt.resultPayload!, evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0 },
          attempt,
          {
            available: true,
            decisions: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place', reviewedOccurrenceIds: ['occurrence-place'], action: 'APPROVED', reviewedValue: null }],
            reviewedCount: 1,
            untouchedCount: 1,
            isTouched: () => false,
            setDecision,
          },
        )}
        schemaReady
        pinnedSchema={usedSchema}
        currentSchemaRevision={currentRevision}
        documentMarkdown="# Source"
        sourceDocumentName="previous.pdf"
      />,
    )

    expect(screen.getByText('Completed')).toBeInTheDocument()
    expect(screen.getByText('Previous schema')).toBeInTheDocument()
    expect(screen.getByText('Review applies to Schema Revision 3')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /rerun|run with|re-run/i })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Run with current schema' }))
    expect(onRunExtraction).toHaveBeenCalledOnce()
    expect(screen.queryByText('Extraction Schema updated')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reject place' }))
    expect(setDecision).toHaveBeenCalledWith(['records', 0, 'place'], 'REJECTED', null)
  })

  it('labels a finalized previous-schema review without offering new decisions', () => {
    const reviewed: ExtractionAttempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ place: 'Original' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place' }],
      reviewedAt: '2026-09-06T00:00:00Z',
      reviewDecisions: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place', reviewedOccurrenceIds: [], action: 'APPROVED', reviewedValue: null, createdAt: '2026-09-06T00:00:00Z' }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({ status: 'ready', result: reviewed.resultPayload!, evidenceLinks: reviewed.evidenceLinks!, ungroundedCount: 0 }, reviewed)}
        inspectedAttempt={reviewed}
        readOnly
        schemaReady
        pinnedSchema={usedSchema}
        currentSchemaRevision={currentRevision}
        documentMarkdown="# Source"
        sourceDocumentName="finalized.pdf"
      />,
    )

    expect(screen.getByText('Previous schema')).toBeInTheDocument()
    expect(screen.getByText('Review applies to Schema Revision 3')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Run with current schema' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reject / })).not.toBeInTheDocument()
  })

  it('marks a same-revision result as current and keeps the plain Rerun', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({ status: 'ready', result: { records: [{ place: 'Rome' }] }, evidenceLinks: [], ungroundedCount: 0 }, { ...articleAttempt, complete: true })}
        schemaReady
        pinnedSchema={usedSchema}
        currentSchemaRevision={{ ...currentRevision, schemaRevisionId: articleAttempt.schemaRevisionId, revisionNumber: 3 }}
        documentMarkdown="# Source"
        sourceDocumentName="current.pdf"
      />,
    )
    expect(screen.queryByText('Previous schema')).not.toBeInTheDocument()
    expect(screen.getByText('Using Schema Revision 3 · Current revision: 3')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rerun' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Run with current schema' })).not.toBeInTheDocument()
  })
})

describe('ResultsTab recipe review material', () => {
  const groundedAttempt: ExtractionAttempt = {
    ...articleAttempt,
    strategy: 'CATALOG',
    complete: false,
    resultPayload: { records: [{ entry_no: 31, site_name: null, fundart: null }] },
    diagnostics: {
      ...articleAttempt.diagnostics!,
      grounded: {
        recipe: 'numbered-catalogue-de@1', segmentationFingerprint: 'f',
        budget: { inputTokens: 4096, outputTokens: 1024, tokenizer: { source: 'vllm:/tokenize' } },
        segmentationDiagnostics: [],
        normalization: { version: 1, rules: ['glossary'] },
        recordBlocks: [{ block: 'b1', entry_label: '31' }],
        proposed: [{ path: ['records', 0, 'site_name'], value: 'Eichdorf', quote: 'Eichdorf', key: null,
                     provenance: 'positional', spans: [{ segment: 'p1_s2', start: 4, end: 12 }], alternatives: [],
                     window: 0, raw: 'Eichdorf' }],
        rejected: [{ path: ['records', 0, 'fundart'], value: 'Siedl.', quote: 'FA: Siedl.', key: 'FA:',
                     provenance: 'token', spans: [], alternatives: [], window: 0, reason: 'quote_not_in_entry' }],
        competitors: [],
        coverage: { complete: false, unresolved: 3, lines: 40 },
        completeness: { processing: true, coverage: false, grounding: true, recall: 'unmeasured' },
      },
    },
  }

  it('shows coverage, proposals and rejections apart from the accepted values, with recall unmeasured', () => {
    render(<ResultsTab {...defaultRunProps} controller={controller({ status: 'idle' })} schemaReady
      documentMarkdown="" sourceDocumentName="Catalogue" inspectedAttempt={groundedAttempt} />)
    const panel = screen.getByRole('region', { name: 'Recipe review' })
    expect(panel).toHaveTextContent('numbered-catalogue-de@1')
    expect(panel).toHaveTextContent('3 of 40 source lines unresolved')
    expect(panel).toHaveTextContent('Recall is not measured')
    expect(panel).toHaveTextContent('Entry 31 · site_name: Eichdorf')
    expect(panel).toHaveTextContent('Entry 31 · fundart: Siedl. (quote not in entry)')
    expect(panel).not.toHaveTextContent('%')  // no confidence number is derived from these flags
  })

  it('says what tied each accepted value to its field, and drops it once the value is edited', () => {
    const span = { segment: 'p1_s2', start: 0, end: 2 }
    const link = (field: string, grounding: Partial<NonNullable<EvidenceLink['grounding']>>): EvidenceLink => ({
      resultPath: ['records', 0, field], evidenceAnchorId: `a_${field}`, verbatim: true, lexicalHits: 1,
      grounding: { linkedBy: 'structure', provenance: 'positional', textSpans: [span], keySpans: [], alternatives: [],
                   heading: null, precision: 'segment', raw: 'x', normalized: null, ...grounding },
    })
    const evidenceLinks = [
      link('entry_no', {}),
      link('kreis', { provenance: 'inherited', heading: 'h1', precision: 'input' }),
      link('fundart', { linkedBy: 'key', provenance: 'token', alternatives: [[span]],
                        normalized: { value: 'Grab', rule: 'glossary', keySpan: span, expansionSpan: span } }),
    ]
    const result = { records: [{ entry_no: 31, kreis: 'Heide', fundart: 'G' }] }
    const decision: ReviewDecisionInput = { resultPath: ['records', 0, 'fundart'], evidenceAnchorId: 'a_fundart',
                                            reviewedOccurrenceIds: ['o'], action: 'APPROVED', reviewedValue: null }
    const props = { ...defaultRunProps, schemaReady: true, documentMarkdown: '', sourceDocumentName: 'Catalogue' }
    const withDecision = (reviewed: ReviewDecisionInput) =>
      controller({ status: 'ready', result, evidenceLinks, ungroundedCount: 0 }, null, { decisions: [reviewed] })
    const { rerender } = render(<ResultsTab {...props} controller={withDecision(decision)} />)
    expect(screen.getByText('Entry number from the segmentation')).toBeInTheDocument()
    expect(screen.getByText('Inherited from the heading in force · located to the whole page only')).toBeInTheDocument()
    expect(screen.getByText('Read after its printed key · 1 other match in the entry · glossary: Grab'))
      .toBeInTheDocument()
    expect(screen.getByText('G')).toBeInTheDocument()  // the record keeps the raw value

    rerender(<ResultsTab {...props} controller={withDecision({ ...decision, action: 'EDITED', reviewedValue: 'Grab' })} />)
    expect(screen.queryByText(/Read after its printed key/)).not.toBeInTheDocument()
    expect(screen.getByText('Entry number from the segmentation')).toBeInTheDocument()
  })

  it('names every reason coverage is incomplete and lists what segmentation could not settle', () => {
    const disordered: ExtractionAttempt = { ...groundedAttempt, diagnostics: { ...groundedAttempt.diagnostics!, grounded: {
      ...groundedAttempt.diagnostics!.grounded!,
      coverage: { complete: false, unresolved: 0, lines: 40, potential_duplicates: 0, reading_order_issues: 1 },
      segmentationDiagnostics: [{ code: 'reading_order', detail: 'p1_s2 follows p1_s1 against the column order',
                                  block: null, spans: [] }],
    } } }
    render(<ResultsTab {...defaultRunProps} controller={controller({ status: 'idle' })} schemaReady
      documentMarkdown="" sourceDocumentName="Catalogue" inspectedAttempt={disordered} />)
    const panel = screen.getByRole('region', { name: 'Recipe review' })
    expect(panel).toHaveTextContent('reading order disagrees with the page layout in 1 place.')
    expect(panel).not.toHaveTextContent('0 of 40')
    expect(panel).toHaveTextContent('1 segmentation note')
    expect(panel).toHaveTextContent('reading order: 1 — p1_s2 follows p1_s1 against the column order')
  })

  it('shows nothing of the kind for a version 1 result', () => {
    render(<ResultsTab {...defaultRunProps} controller={controller({ status: 'idle' })} schemaReady
      documentMarkdown="" sourceDocumentName="Catalogue" inspectedAttempt={articleAttempt} />)
    expect(screen.queryByRole('region', { name: 'Recipe review' })).not.toBeInTheDocument()
  })
})
