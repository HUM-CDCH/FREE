// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportExtractionResult } from 'extraction-result-export'
import ResultsTab from './ResultsTab'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt, ReviewDecisionInput } from '../shared/extraction.contract'
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
    stale: false,
    runExtraction: async () => {},
    retryExtraction: async () => null,
    requestCancellation: async () => {},
    cancellationRequested: false,
    cancellationError: null,
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
  outcome: 'SUCCEEDED',
  complete: false,
  modelAttribution: { provider: 'ollama', modelId: 'fixture' },
  diagnostics: {
    phase: 'grounding', durationMs: 42, modelCalls: 4,
    finishReason: 'length', inputTokens: 10, outputTokens: 20,
    grounding: null,
    catalog: null,
    retry: null,
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

  it('renders Catalog diagnostics with targeted retry controls behind Run details', () => {
    const catalogAttempt: ExtractionAttempt = {
      ...articleAttempt,
      strategy: 'CATALOG',
      diagnostics: {
        ...articleAttempt.diagnostics,
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
    const retryExtraction = vi.fn(async () => null)
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={{
          ...controller({
            status: 'ready',
            result: catalogAttempt.resultPayload!,
            evidenceLinks: [],
            ungroundedCount: 0,
          }, catalogAttempt),
          retryExtraction,
        }}
        schemaReady
        documentMarkdown="# Source" sourceDocumentName="Catalog.pdf"
      />,
    )

    // Incomplete banner is visible without opening diagnostics.
    expect(screen.getByText('Incomplete Extraction')).toBeInTheDocument()
    // No generic rerun for a Catalog attempt.
    expect(screen.queryByRole('button', { name: 'Rerun' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    // Stage and record diagnostics render inside the bounded disclosure.
    expect(screen.getByTestId('catalog-record-diagnostics')).toBeInTheDocument()
    expect(screen.getByText(/Record 2 · failed · executed · Second entry/)).toBeInTheDocument()
    expect(screen.getByText(/Record 3 · not attempted · executed · Third entry/)).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog stage discovery: succeeded, reused')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog record 1: succeeded, reused, First entry')).toBeInTheDocument()

    // Retry controls offer only failed or limit-skipped components.
    expect(screen.queryByLabelText('Retry failed or truncated document metadata')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Rediscover Catalog record boundaries')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Retry record 1: First entry')).not.toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Retry record 2: Second entry'))
    fireEvent.click(screen.getByLabelText('Retry record 3: Third entry'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry selected components' }))
    expect(retryExtraction).toHaveBeenCalledWith({
      retryDocument: false,
      rediscover: false,
      retryRecordStartBlockIds: ['h1', 'h2'],
    })

    // Grounding only submits the empty selection for a succeeded parent.
    fireEvent.click(screen.getByRole('button', { name: 'Grounding only' }))
    expect(retryExtraction).toHaveBeenLastCalledWith({
      retryDocument: false,
      rediscover: false,
      retryRecordStartBlockIds: [],
    })
  })

  it('offers rediscovery after an empty failed discovery', () => {
    const attempt: ExtractionAttempt = {
      ...articleAttempt,
      extractionId: '55555555-5555-4555-8555-555555555555',
      strategy: 'CATALOG',
      outcome: 'FAILED',
      complete: null,
      diagnostics: {
        ...articleAttempt.diagnostics,
        catalog: {
          stages: [
            { ...catalogCall, stage: 'document-values', provenance: 'reused', calls: 0, inputTokens: null, outputTokens: null, durationMs: 0 },
            { ...catalogCall, stage: 'discovery', outcome: 'failed', failureCode: 'catalog_no_records' },
            { ...catalogCall, stage: 'record-values', outcome: 'not_attempted', calls: 0, finishReason: null },
            { ...catalogCall, stage: 'grounding', outcome: 'not_attempted', calls: 0, finishReason: null },
          ],
          records: [],
        },
      },
      failure: {
        code: 'catalog_no_records',
        message: 'Catalog discovery returned no records.',
      },
      resultPayload: null,
      evidenceLinks: null,
      reviewable: false,
    }
    render(
      <ResultsTab
        {...defaultRunProps}
        controller={controller(
          { status: 'error', message: attempt.failure!.message },
          attempt,
        )}
        schemaReady
        documentMarkdown="# Source"
        sourceDocumentName="Catalog.pdf"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
    expect(screen.getByLabelText('Catalog stage discovery: failed, executed')).toBeInTheDocument()
    expect(screen.getByLabelText('Rediscover Catalog record boundaries')).toBeInTheDocument()
    expect(screen.queryByLabelText('Retry failed or truncated document metadata')).not.toBeInTheDocument()
  })

  it('renders executed and reused provenance for an inspected Catalog child', () => {
    const child: ExtractionAttempt = {
      ...articleAttempt,
      extractionId: '66666666-6666-4666-8666-666666666666',
      strategy: 'CATALOG',
      complete: true,
      diagnostics: {
        ...articleAttempt.diagnostics,
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
        retry: {
          retryOfId: '55555555-5555-4555-8555-555555555555',
          retryDocument: false,
          rediscover: false,
          retryRecordStartBlockIds: ['h1'],
        },
      },
      resultPayload: {
        records: [{ place: 'First place' }, { place: 'Second place' }],
      },
      retryOfId: '55555555-5555-4555-8555-555555555555',
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
    expect(screen.queryByLabelText('Retry record 1: First entry')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Retry record 2: Second entry')).not.toBeInTheDocument()
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
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed value for age' }))
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number.')
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save reviewed value for age' }))
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

    fireEvent.click(screen.getByRole('button', { name: 'Approve all (1)' }))
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

  it('exports reviewed edits and shows the exact pinned Schema Revision read-only', () => {
    const setDecision = vi.fn()
    const schema: SchemaDefinition = {
      recordDescription: 'Pinned result.',
      schemaNodes: [{ id: 'place', name: 'place', type: 'string' }],
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
    fireEvent.click(screen.getByRole('tab', { name: 'Pinned schema' }))
    expect(screen.getByText(new RegExp(articleAttempt.schemaRevisionId)).closest('p')).toHaveTextContent('read-only')
    expect(screen.getByText(/"place": "string"/)).toBeInTheDocument()
  })
})
