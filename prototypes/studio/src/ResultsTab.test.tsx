// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useCallback, useState } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportExtractionResult } from 'extraction-result-export'
import ResultsTab, { type RunExtractionStrategy } from './ResultsTab'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt, ReviewDecisionInput } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { SchemaDefinition } from 'extraction/schema'
import type { ArticleSettings } from 'extraction/extraction-method'

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
      requiredCount: 0,
      untouchedCount: 0,
      isTouched: () => true,
      reviewedExtractionId: null,
      error: null,
      draftError: null,
      draftSaving: false,
      draftSaved: false,
      retryDraft: () => {},
      transfer: {},
      pairing: { pairings: [], sources: [], pair: () => {} },
      setDecision: () => {},
      undo: () => {},
      reload: () => {},
      approveAll: () => {},
      accept: async () => {},
      ...reviewOverrides,
    },
  }
}

const articleRun: RunExtractionStrategy = { strategy: 'ARTICLE' }

const defaultRunProps = {
  onRunExtraction: async () => undefined,
  runExtractionDisabled: false,
  runExtractionStrategy: articleRun,
}

const articleAttempt: ExtractionAttempt = {
  extractionId: '11111111-1111-4111-8111-111111111111',
  sourceDocumentId: '44444444-4444-4444-8444-444444444444',
  sourceRepresentationRevisionId: '22222222-2222-4222-8222-222222222222',
  schemaRevisionId: '33333333-3333-4333-8333-333333333333',
  strategy: 'ARTICLE',
  catalogRecipe: null,
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
        controller={controller(
          { status: 'running', step: 'extraction' },
          {
            ...articleAttempt,
            executionStatus: 'RUNNING',
            outcome: null,
            resultPayload: null,
            evidenceLinks: null,
            reviewable: false,
          },
        )}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Ravenna letters.pdf"
      />,
    )

    expect(screen.getByText('Running extraction…')).toBeInTheDocument()
    expect(screen.queryByText('Report')).not.toBeInTheDocument()
  })

  it('shows a run as starting, not running, until the server acknowledges it', () => {
    // While the request is in flight the previous, finished attempt is still the one on screen.
    for (const previous of [null, articleAttempt]) {
      const { unmount } = render(
        <ResultsTab
          {...defaultRunProps}
          controller={controller({ status: 'running', step: 'extraction' }, previous)}
          schemaReady
          documentMarkdown="# Source"
          sourceDocumentName="Ravenna letters.pdf"
        />,
      )
      expect(screen.getByText('Starting extraction…')).toBeInTheDocument()
      expect(screen.queryByText('Running extraction…')).not.toBeInTheDocument()
      expect(screen.queryByText('Queued extraction…')).not.toBeInTheDocument()
      unmount()
    }
  })

  it('offers no cancellation until the server acknowledges the run', () => {
    // While the request is in flight there is nothing to cancel yet: the new run may not exist.
    const requestCancellation = vi.fn(async () => {})
    for (const previous of [null, articleAttempt]) {
      const { unmount } = render(
        <ResultsTab
          {...defaultRunProps}
          controller={{ ...controller({ status: 'running', step: 'extraction' }, previous), requestCancellation }}
          schemaReady
          documentMarkdown="# Source"
          sourceDocumentName="Ravenna letters.pdf"
        />,
      )
      const cancel = screen.getByRole('button', { name: 'Cancel extraction' })
      expect(cancel).toBeDisabled()
      fireEvent.click(cancel)
      unmount()
    }
    expect(requestCancellation).not.toHaveBeenCalled()
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
        '2 ungrounded values are excluded from required review and remain recorded without Evidence.',
      ),
    ).toBeInTheDocument()
    expect(screen.getByText('No grounded values')).toBeInTheDocument()
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
    expect(screen.getByRole('button', { name: 'Run Article extraction' })).toBeInTheDocument()
  })

  it('says an incomplete Extraction omitted source text for a text budget, without claiming what was missed', () => {
    const cutAttempt = (issueCodes: string[]): ExtractionAttempt => ({
      ...articleAttempt,
      strategy: 'CATALOG',
      diagnostics: {
        ...articleAttempt.diagnostics!,
        grounding: { groundedPaths: [], ungroundedPaths: [], issueCodes, batches: [] },
      },
    })
    const renderWith = (attempt: ExtractionAttempt) => render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller({ status: 'ready', result: attempt.resultPayload!, evidenceLinks: [], ungroundedCount: 0 }, attempt)}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Catalog.pdf"
      />,
    )
    const notice = 'Some extraction calls omitted source text because of their text budget; affected values may be missing.'

    const { unmount } = renderWith(cutAttempt(['text_truncated']))
    expect(screen.getByText('Incomplete Extraction')).toBeInTheDocument()
    expect(screen.getByText(notice)).toBeInTheDocument()
    // One call's cut does not establish that no other call read that text.
    expect(screen.queryByText(/was not read|values found only there/)).toBeNull()
    unmount()

    renderWith(cutAttempt(['missing_claim']))
    expect(screen.getByText('Incomplete Extraction')).toBeInTheDocument()
    expect(screen.queryByText(notice)).toBeNull()
  })

  it('renders Catalog diagnostics behind Run details and offers a run of the toolbar strategy', () => {
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
    expect(screen.getByRole('button', { name: 'Run Article extraction' })).toBeInTheDocument()
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

  it('offers a run of the toolbar strategy for a failed Catalog attempt', () => {
    const failed: ExtractionAttempt = {
      ...articleAttempt,
      strategy: 'CATALOG',
      executionStatus: 'FAILED',
      outcome: null,
      complete: null,
      modelAttribution: null,
      diagnostics: null,
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
    fireEvent.click(screen.getByRole('button', { name: 'Run Article extraction' }))
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

  describe('a value the sources disagreed on', () => {
    const contestedAttempt = (resultPayload: ExtractionAttempt['resultPayload'], contested: NonNullable<ExtractionAttempt['diagnostics']>['contested']): ExtractionAttempt =>
      ({ ...articleAttempt, resultPayload, diagnostics: { ...articleAttempt.diagnostics!, contested } })
    const summary = (label: string) =>
      [...document.querySelectorAll('span')].find((element) => element.textContent?.startsWith(`${label}:`))?.textContent
    const renderContested = (result: NonNullable<ExtractionAttempt['resultPayload']>, contested: NonNullable<ExtractionAttempt['diagnostics']>['contested'],
      decisions: ReviewDecisionInput[] = []) =>
      render(
        <ResultsTab
          {...defaultRunProps}
          controller={controller({ status: 'ready', result, evidenceLinks: [], ungroundedCount: 0 },
            contestedAttempt(result, contested), { decisions })}
          schemaReady
          documentMarkdown="# Source"
          sourceDocumentName="contested.pdf"
          exportSchema={{ recordDescription: 'A work.', schemaNodes: [
            { id: 'place', name: 'place', type: 'string' }, { id: 'year', name: 'year', type: 'integer' },
          ] }}
        />,
      )

    it('shows Contested with its candidates, apart from an ordinary Missing value, and counts each apart', () => {
      renderContested({ records: [{ place: null, year: null }] },
        [{ resultPath: ['records', 0, 'year'], candidates: [1901, 1902] }])

      expect(screen.getByText('Contested')).toBeInTheDocument()
      expect(screen.getByRole('note', { name: 'Contested: sources disagreed (1901 · 1902)' })).toBeInTheDocument()
      expect(screen.getByText('Missing')).toBeInTheDocument()
      expect(summary('Missing')).toBe('Missing: 1')
      expect(summary('Contested')).toBe('Contested: 1')
    })

    it('is no longer contested once a review supplied a value', () => {
      renderContested({ records: [{ place: null, year: null }] },
        [{ resultPath: ['records', 0, 'year'], candidates: [1901, 1902] }],
        [{ resultPath: ['records', 0, 'year'], evidenceAnchorId: 'anchor-year', reviewedOccurrenceIds: [], action: 'EDITED', reviewedValue: 1901 }])

      expect(screen.queryByText('Contested')).not.toBeInTheDocument()
      expect(screen.getByText('1901')).toBeInTheDocument()
      expect(summary('Contested')).toBeUndefined()
    })

    it('says what a CSV loses and hands the export the contested fields for the workbook notes', () => {
      renderContested({ records: [{ place: 'Oslo', year: null }, { place: null, year: null }] },
        [{ resultPath: ['records', 1, 'place'], candidates: ['Bergen', 'Bodø'] }])

      fireEvent.click(screen.getByRole('button', { name: 'Export' }))
      expect(screen.getByRole('note')).toHaveTextContent(
        'CSV leaves 1 contested field empty; their candidates are only in the Excel Review notes sheet and in Studio.')
      fireEvent.click(screen.getByRole('button', { name: 'Excel' }))

      expect(exportExtractionResult).toHaveBeenCalledWith(
        [{ place: 'Oslo', year: null }, { place: null, year: null }],
        expect.objectContaining({ format: 'xlsx', contested: [{ record: 1, path: ['place'], candidates: ['Bergen', 'Bodø'] }] }),
      )
    })
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
            requiredCount: 1,
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

  it('saves a review with decisions carried from a sample only when the researcher asks, and counts them', () => {
    const accept = vi.fn(async () => {})
    const schema = { recordDescription: 'Places.', schemaNodes: [{ id: 'place', name: 'place', type: 'string' as const }] }
    const path = ['records', 0, 'place']
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          { status: 'ready', result: articleAttempt.resultPayload!, evidenceLinks: [], ungroundedCount: 0 },
          articleAttempt,
          {
            available: true, canAccept: true, requiredCount: 1, accept,
            decisions: [{ resultPath: path, evidenceAnchorId: 'a_p1_s0', reviewedOccurrenceIds: ['o-1'], action: 'APPROVED',
              reviewedValue: null, carriedFrom: { extractionId: 'sample', sourcePathKey: JSON.stringify(path) } }],
            transfer: { [JSON.stringify(path)]: { status: 'reviewed', kept: 'First place' } },
          },
        )}
        schemaReady
        pinnedSchema={schema}
        exportSchema={schema}
        documentMarkdown="# Source"
        sourceDocumentName="article.pdf"
      />,
    )
    expect(screen.getByText('1 reviewed in sample · 0 changed since sample · 0 to review')).toBeInTheDocument()
    expect(accept).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
    expect(accept).toHaveBeenCalledOnce()
  })

  it('edits one item of a scalar array as one value of the item type', () => {
    const setDecision = vi.fn()
    const path = ['records', 0, 'grave_goods', 2]
    const attempt = {
      ...articleAttempt,
      complete: true,
      resultPayload: { records: [{ grave_goods: ['pin', 'bead', 'sherd'] }] },
      evidenceLinks: [{ resultPath: path, evidenceAnchorId: 'anchor-sherd' }],
    }
    const schema: SchemaDefinition = {
      recordDescription: 'One grave.',
      schemaNodes: [{ id: 'grave_goods', name: 'grave_goods', type: 'array', itemType: 'string' }],
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          { status: 'ready', result: attempt.resultPayload, evidenceLinks: attempt.evidenceLinks, ungroundedCount: 0 },
          attempt,
          {
            available: true,
            canAccept: true,
            decisions: [{ resultPath: path, evidenceAnchorId: 'anchor-sherd', reviewedOccurrenceIds: ['o'],
                          action: 'APPROVED', reviewedValue: null }],
            setDecision,
          },
        )}
        schemaReady
        pinnedSchema={schema}
        exportSchema={schema}
        documentMarkdown="# Source"
        sourceDocumentName="grave.pdf"
      />,
    )

    fireEvent.click(screen.getByText('grave_goods', { exact: true }))
    fireEvent.click(screen.getByRole('button', { name: /^Edit / }))
    const input = screen.getByLabelText(/^Reviewed value for /)
    fireEvent.change(input, { target: { value: 'bronze pin, broken' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(setDecision).toHaveBeenLastCalledWith(path, 'EDITED', 'bronze pin, broken')
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
              requiredCount: 1,
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
            requiredCount: 1,
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
            requiredCount: 1,
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
            requiredCount: 1,
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
            requiredCount: 1,
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
    expect(screen.queryByRole('button', { name: /with current schema$/ })).not.toBeInTheDocument()
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
          ...controller({ status: 'running', step: 'extraction' }, {
            ...articleAttempt, executionStatus: 'RUNNING', outcome: null, complete: null,
            modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false,
          }),
          monitorError: 'Unable to update status. The extraction may still be running.',
          reconnect,
        }}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="running.pdf"
      />,
    )

    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('Unable to update status. The extraction may still be running.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('offers one with-current-schema run action for a completed previous-schema result and keeps review open', () => {
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
        runExtractionStrategy={articleRun}
        controller={controller(
          { status: 'ready', result: attempt.resultPayload!, evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 0 },
          attempt,
          {
            available: true,
            decisions: [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place', reviewedOccurrenceIds: ['occurrence-place'], action: 'APPROVED', reviewedValue: null }],
            requiredCount: 1,
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
    expect(screen.getAllByRole('button', { name: /^Run (Article|Catalog) extraction/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Run Article extraction with current schema' }))
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
    expect(screen.queryByRole('button', { name: /with current schema$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reject / })).not.toBeInTheDocument()
  })

  it('marks a same-revision result as current and keeps the plain run action', () => {
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
    expect(screen.getByRole('button', { name: 'Run Article extraction' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /with current schema$/ })).not.toBeInTheDocument()
  })
})

describe('ResultsTab run actions', () => {
  // Every run action starts the toolbar's current selection afresh, whatever
  // the displayed attempt ran with, so each one names that selection.
  const catalogAttempt: ExtractionAttempt = { ...articleAttempt, strategy: 'CATALOG', complete: true }
  const failedCatalogAttempt: ExtractionAttempt = {
    ...catalogAttempt,
    executionStatus: 'FAILED',
    outcome: null,
    complete: null,
    modelAttribution: null,
    diagnostics: null,
    failure: { code: 'catalog_no_records', message: 'Catalog discovery returned no records.' },
    resultPayload: null,
    evidenceLinks: null,
    reviewable: false,
  }
  const completed: ExtractionController['state'] = {
    status: 'ready', result: catalogAttempt.resultPayload!, evidenceLinks: [], ungroundedCount: 0,
  }
  const surfaces = [
    { surface: 'completed result', suffix: '', props: { controller: controller(completed, catalogAttempt) } },
    {
      surface: 'previous-schema result',
      suffix: ' with current schema',
      props: {
        controller: controller(completed, catalogAttempt),
        currentSchemaRevision: { schemaRevisionId: '99999999-9999-4999-8999-999999999999', revisionNumber: 4 },
      },
    },
    {
      surface: 'failed attempt',
      suffix: '',
      props: { controller: controller({ status: 'error', message: 'Catalog discovery returned no records.' }, failedCatalogAttempt) },
    },
    { surface: 'cancelled attempt', suffix: '', props: { controller: controller({ status: 'cancelled' }) } },
    { surface: 'document without results', suffix: '', props: { controller: controller({ status: 'idle' }) } },
  ]
  const selections: Array<{ selection: string; run: RunExtractionStrategy; name: string; boundaries: string | null }> = [
    { selection: 'Article', run: articleRun, name: 'Run Article extraction', boundaries: null },
    {
      selection: 'Catalog with Model discovery',
      run: { strategy: 'CATALOG', boundaries: 'Model discovery' },
      name: 'Run Catalog extraction',
      boundaries: 'Boundaries: Model discovery',
    },
    {
      selection: 'Catalog with a recipe',
      run: { strategy: 'CATALOG', boundaries: 'Numbered catalogue (German)' },
      name: 'Run Catalog extraction',
      boundaries: 'Boundaries: Numbered catalogue (German)',
    },
  ]

  it.each(surfaces.flatMap((surface) => selections.map((selection) => ({ ...surface, ...selection }))))(
    'names the $selection selection on the run action for a $surface',
    ({ props, suffix, run, name, boundaries }) => {
      const onRunExtraction = vi.fn()
      render(
        <ResultsTab
          {...defaultRunProps}
          {...props}
          onRunExtraction={onRunExtraction}
          runExtractionStrategy={run}
          schemaReady
          documentMarkdown="# Source"
          sourceDocumentName="Catalog.pdf"
        />,
      )

      const action = screen.getByRole('button', { name: name + suffix })
      if (boundaries === null) {
        expect(action).not.toHaveAccessibleDescription()
        expect(screen.queryByText(/^Boundaries:/)).not.toBeInTheDocument()
      } else {
        expect(action).toHaveAccessibleDescription(boundaries)
        expect(screen.getByText(boundaries)).toBeVisible()
      }
      fireEvent.click(action)
      expect(onRunExtraction).toHaveBeenCalledOnce()
    },
  )

  // Without a run handler the view starts no Extraction (its Source
  // Representation is an earlier one), so no surface offers a run.
  it.each(surfaces)('offers no run action for a $surface without a run handler', ({ props }) => {
    render(
      <ResultsTab
        {...defaultRunProps}
        {...props}
        onRunExtraction={undefined}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="Catalog.pdf"
      />,
    )

    expect(screen.queryAllByRole('button', { name: /^Run (Article|Catalog) extraction/ })).toEqual([])
  })

  it('offers no Generate a schema first without a run handler', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        onRunExtraction={undefined}
        controller={controller({ status: 'idle' })}
        schemaReady={false}
        documentMarkdown="# Source"
        sourceDocumentName="Catalog.pdf"
      />,
    )

    expect(screen.getByText('No results yet')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Generate a schema first' })).not.toBeInTheDocument()
  })

  it('keeps Generate a schema first, without boundaries, until a schema is ready', () => {
    render(
      <ResultsTab
        {...defaultRunProps}
        runExtractionStrategy={{ strategy: 'CATALOG', boundaries: 'Model discovery' }}
        controller={controller({ status: 'idle' })}
        schemaReady={false}
        documentMarkdown="# Source"
        sourceDocumentName="Catalog.pdf"
      />,
    )

    expect(screen.getByRole('button', { name: 'Generate a schema first' })).toBeInTheDocument()
    expect(screen.queryByText(/^Boundaries:/)).not.toBeInTheDocument()
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
    const link = (field: string, grounding: Partial<Extract<NonNullable<EvidenceLink['grounding']>, { provenance: unknown }>>): EvidenceLink => ({
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

  it('keeps a grounded value\'s Evidence reachable after an edit or rejection, as Evidence for the extracted value', () => {
    const span = { segment: 'p1_s2', start: 4, end: 12 }
    const evidenceLinks: EvidenceLink[] = [{
      resultPath: ['records', 0, 'site_name'], evidenceAnchorId: 'a_site', verbatim: true, lexicalHits: 1,
      grounding: { linkedBy: 'key', provenance: 'token', textSpans: [span], keySpans: [], alternatives: [],
                   heading: null, precision: 'segment', raw: 'Eichdorf', normalized: null },
    }]
    const result = { records: [{ site_name: 'Eichdorf' }] }
    const decision: ReviewDecisionInput = { resultPath: ['records', 0, 'site_name'], evidenceAnchorId: 'a_site',
                                            reviewedOccurrenceIds: ['o'], action: 'APPROVED', reviewedValue: null }
    const onSelectEvidence = vi.fn()
    const props = { ...defaultRunProps, schemaReady: true, documentMarkdown: '', sourceDocumentName: 'Catalogue', onSelectEvidence }
    const withDecision = (reviewed: ReviewDecisionInput) =>
      controller({ status: 'ready', result, evidenceLinks, ungroundedCount: 0 }, null, { decisions: [reviewed] })
    const { rerender } = render(<ResultsTab {...props} controller={withDecision(decision)} />)
    expect(screen.getByRole('button', { name: 'View Evidence for site_name' })).toBeInTheDocument()
    expect(screen.getByText('Read after its printed key')).toBeInTheDocument()

    for (const reviewed of [
      { ...decision, action: 'EDITED' as const, reviewedValue: 'Eichdorf-Süd' },
      { ...decision, action: 'REJECTED' as const },
    ]) {
      onSelectEvidence.mockClear()
      rerender(<ResultsTab {...props} controller={withDecision(reviewed)} />)
      if (reviewed.action === 'EDITED') expect(screen.getByText('Eichdorf-Süd')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'View Evidence for site_name' })).not.toBeInTheDocument()
      expect(screen.queryByText(/Read after its printed key/)).not.toBeInTheDocument()
      expect(screen.getByText('Extracted value: Eichdorf')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'View Evidence for extracted value of site_name' }))
      expect(onSelectEvidence).toHaveBeenCalledWith('a_site')
    }
    expect(screen.getByText('Missing')).toBeInTheDocument()
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

describe('Method used', () => {
  const SPANS: ArticleSettings = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
  const renderWith = (attempt: ExtractionAttempt) => render(
    <ResultsTab {...defaultRunProps}
      controller={controller(attempt.executionStatus === 'FAILED'
        ? { status: 'error', message: attempt.failure!.message }
        : { status: 'ready', result: attempt.resultPayload!, evidenceLinks: [], ungroundedCount: 0 }, attempt)}
      schemaReady documentMarkdown="# Source" sourceDocumentName="Article.pdf" />)
  const methodUsed = () => { fireEvent.click(screen.getByRole('button', { name: 'Run details' })); return within(screen.getByRole('region', { name: 'Method used' })) }

  it('shows requested and effective methods with the versions the service reported', () => {
    renderWith({ ...articleAttempt, requestedModels: { fields: 'instruct' }, requestedSettings: { article: SPANS },
      diagnostics: { ...articleAttempt.diagnostics!, models: { fields: 'Qwen/Qwen3.8-27B-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' },
        effectiveMethod: { options: { strategy: 'article', article: SPANS }, versions: { prompt: 12, method: 1, spanGrounding: 2 } },
        eligibility: { allRecordLeaves: 5, eligibleRecordLeaves: 0, skipped: [], eligibleGrounding: 'not_applicable' } } })
    const used = methodUsed()
    expect(used.getByText('Bounded source units (12,288 tokens) · Plain text · Source-span verification')).toBeInTheDocument()
    expect(used.getByText('Field values: instruct · Reasoning: deployment default')).toBeInTheDocument()
    expect(used.getByText('Prompt 12 · Method 1 · Span grounding 2')).toBeInTheDocument()
    expect(used.getByText('Not applicable: no value was eligible')).toBeInTheDocument()
  })

  it('a run that failed before a service result keeps its request and has no effective method', () => {
    renderWith({ ...articleAttempt, executionStatus: 'FAILED', outcome: null, complete: null, modelAttribution: null, diagnostics: null,
      resultPayload: null, evidenceLinks: null, reviewable: false, failure: { code: 'extraction_failed', message: 'Refused.' },
      requestedSettings: { article: SPANS } })
    const used = methodUsed()
    expect(used.getByText('Effective method unavailable')).toBeInTheDocument()
    expect(used.getByText('Bounded source units (12,288 tokens) · Plain text · Source-span verification')).toBeInTheDocument()
  })

  it('a historical run is Not recorded, never borrowing today\'s configuration', () => {
    renderWith({ ...articleAttempt, requestedSettings: null })
    expect(methodUsed().getAllByText('Not recorded')).toHaveLength(2)
  })
})

describe('ResultsTab review progress', () => {
  const schema: SchemaDefinition = {
    recordDescription: 'One place.',
    schemaNodes: [{ id: 'place', name: 'place', type: 'string' }, { id: 'year', name: 'year', type: 'integer' }],
  }
  const decisions: ReviewDecisionInput[] = ['place', 'year'].map((field) => ({
    resultPath: ['records', 0, field], evidenceAnchorId: `anchor-${field}`,
    reviewedOccurrenceIds: [`occurrence-${field}`], action: 'APPROVED', reviewedValue: null,
  }))
  const attempt: ExtractionAttempt = {
    ...articleAttempt, resultPayload: { records: [{ place: 'Original', year: 2000, other: 'Ungrounded' }] },
    evidenceLinks: decisions.map(({ resultPath, evidenceAnchorId }) => ({ resultPath, evidenceAnchorId: evidenceAnchorId! })),
  }
  const state: ExtractionController['state'] = {
    status: 'ready', result: attempt.resultPayload!, evidenceLinks: attempt.evidenceLinks!, ungroundedCount: 1,
  }
  function scene(overrides: Partial<ExtractionController['review']> = {}, readOnly = false, displayed = attempt) {
    return <ResultsTab {...defaultRunProps} controller={controller(state, displayed, {
      available: true, decisions, requiredCount: 2, untouchedCount: 2, isTouched: () => false, ...overrides,
    })} readOnly={readOnly} schemaReady pinnedSchema={schema} exportSchema={schema}
      documentMarkdown="# Source" sourceDocumentName="progress.pdf" />
  }

  it('decrements required progress after reject and edit, independently of ungrounded values and result navigation', () => {
    const accept = vi.fn(async () => {})
    function Fixture() {
      const [current, setCurrent] = useState(decisions)
      const [touched, setTouched] = useState<Set<string>>(new Set())
      return scene({
        decisions: current, untouchedCount: 2 - touched.size, isTouched: (path) => touched.has(JSON.stringify(path)),
        canAccept: touched.size === 2, accept,
        setDecision: (path, action, reviewedValue = null) => {
          const key = JSON.stringify(path)
          setTouched((previous) => new Set([...previous, key]))
          setCurrent((previous) => previous.map((decision) => JSON.stringify(decision.resultPath) === key
            ? { ...decision, action, reviewedValue } : decision))
        },
      })
    }
    render(<Fixture />)
    const progress = screen.getByRole('region', { name: 'Review progress' })
    expect(progress).toHaveTextContent('2 of 2 required decisions remaining')
    expect(within(progress).getAllByRole('status')).toHaveLength(1)
    expect(screen.queryByText(/pending/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve remaining (2)' })).toHaveAccessibleDescription(/ungrounded values, are unchanged.*saves automatically/)
    expect(screen.getByText('1 ungrounded value is excluded from required review and remains recorded without Evidence.')).toBeInTheDocument()
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Reject place' }))
    expect(progress).toHaveTextContent('1 of 2 required decisions remaining')
    expect(screen.getByRole('button', { name: 'Approve remaining (1)' })).toBeEnabled()
    fireEvent.click(screen.getByRole('button', { name: 'Reverse decision for place' }))
    expect(progress).toHaveTextContent('1 of 2 required decisions remaining')
    fireEvent.click(screen.getByRole('tab', { name: 'Raw JSON' }))
    expect(progress).toHaveTextContent('1 of 2 required decisions remaining')
    fireEvent.click(screen.getByRole('tab', { name: 'Review' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit year' }))
    const input = screen.getByLabelText('Reviewed value for year')
    fireEvent.change(input, { target: { value: '2001' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(progress).toHaveTextContent('0 of 2 required decisions remaining')
    expect(accept).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Approve remaining' })).toBeDisabled()
  })

  it('separates draft acknowledgement, loading, finalization and failure from decision progress', () => {
    const { rerender } = render(scene({ untouchedCount: 1, draftSaving: true }))
    let progress = screen.getByRole('region', { name: 'Review progress' })
    expect(progress).toHaveTextContent('1 of 2 required decisions remaining · Saving draft…')
    expect(within(progress).getByRole('status')).not.toHaveTextContent('Saving draft')
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument()
    rerender(scene({ untouchedCount: 1, draftSaved: true }))
    expect(progress).toHaveTextContent('1 of 2 required decisions remaining · Draft saved')
    rerender(scene({ loading: true, requiredCount: 0, untouchedCount: 0 }))
    expect(screen.getAllByText('Loading Review Decisions…')).toHaveLength(1)
    expect(progress).not.toHaveTextContent('0 of 0')
    rerender(scene({ requiredCount: 0, untouchedCount: 0, error: 'Offline' }))
    expect(progress).toHaveTextContent('Review Decisions could not be loaded')
    expect(progress).not.toHaveTextContent('0 of 0')
    rerender(scene({ untouchedCount: 0, saving: true, draftSaved: true }))
    expect(progress).toHaveTextContent('0 of 2 required decisions remaining · Saving review…')
    expect(screen.queryByText('Review saved')).not.toBeInTheDocument()
    rerender(scene({ untouchedCount: 0, canAccept: true, error: 'Offline' }))
    expect(progress).toHaveTextContent('0 of 2 required decisions remaining · Review not saved')
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
    rerender(scene({}, true))
    progress = screen.getByRole('region', { name: 'Review progress' })
    expect(progress).toHaveTextContent('Not reviewed · 2 required decisions')
    expect(within(progress).queryByRole('status')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Approve remaining/ })).not.toBeInTheDocument()
    rerender(scene({}, true, { ...attempt, reviewedAt: '2026-10-01T12:00:00Z',
      reviewDecisions: decisions.map((decision) => ({ ...decision, createdAt: '2026-10-01T12:00:00Z' })) }))
    expect(progress).toHaveTextContent('Review saved · 2 decisions')
  })

})
