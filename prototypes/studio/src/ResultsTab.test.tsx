// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useCallback, useLayoutEffect, useState, type ComponentProps } from 'react'
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exportExtractionResult } from 'extraction-result-export'
import type { ParsedDocument } from 'extraction/parsed-document'
import ResultsTab from './ResultsTab'
import { partialFromProgress } from 'extraction'
import { partialResultSchema, type PartialResult } from '../shared/extraction.contract'
import progressFixture from '../../parsing_service/tests/fixtures/contracts/extract.progress.json'
import type { ExtractionController } from './useExtraction'
import type { ExtractionAttempt, ReviewDecisionInput } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { SchemaDefinition } from 'extraction/schema'
import type { ArticleSettings } from 'extraction/extraction-method'
import { REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import { resultPathKey } from './reviewDecisions'

vi.mock('extraction-result-export', async (importOriginal) => ({
  ...await importOriginal<typeof import('extraction-result-export')>(),
  exportExtractionResult: vi.fn(async () => {}),
}))

afterEach(cleanup)

beforeEach(() => {
  vi.mocked(exportExtractionResult).mockReset()
  vi.mocked(exportExtractionResult).mockResolvedValue(undefined)
})

type Review = ExtractionController['review']
type Path = (string | number)[]

function controller(
  state: ExtractionController['state'],
  attempt: ExtractionAttempt | null = null,
  reviewOverrides: Partial<Review> = {},
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
      draftAvailable: false, decidedOn: new Map(), changedAfterReview: new Set(), settlement: null, discarded: null, draftRefused: null,
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
      setDecision: () => ({ last: false }),
      undo: () => ({ last: false }),
      reload: () => {},
      approveAll: () => {},
      accept: async () => true,
      ...reviewOverrides,
    },
  }
}

/** The Results tab starts no Extraction of its own (decision 03): every run is the tab strip's "▶ Run extraction". */
const PANEL_RUN = /^(Run (Article |Catalog )?extraction|Generate a schema first)/

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
const runningAttempt: ExtractionAttempt = {
  ...articleAttempt, strategy: 'CATALOG', executionStatus: 'RUNNING', outcome: null, complete: null,
  modelAttribution: null, diagnostics: null, resultPayload: null, evidenceLinks: null, reviewable: false,
}
const queuedAttempt: ExtractionAttempt = { ...runningAttempt, executionStatus: 'QUEUED' }
const failedAttempt: ExtractionAttempt = {
  ...runningAttempt, executionStatus: 'FAILED',
  failure: { code: 'catalog_no_records', message: 'Catalog discovery returned no records.' },
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
  return { startBlockId: `h${index}`, startContentIndex: index * 2, endContentIndex: index * 2 + 2, headingText: heading, headingLevel: 2 }
}

const currentExportSchema: SchemaDefinition = {
  recordDescription: 'Current findings',
  schemaNodes: [{
    id: 'context', name: 'context', type: 'object',
    children: [{ id: 'title', name: 'title', type: 'string' }, { id: 'tags', name: 'tags', type: 'array', itemType: 'string' }],
  }],
}

const historicalExportSchema: SchemaDefinition = {
  recordDescription: 'Historical findings',
  schemaNodes: [{ id: 'findings', name: 'findings', type: 'array', children: [{ id: 'value', name: 'value', type: 'string' }] }],
}

const placeSchema: SchemaDefinition = { recordDescription: 'One place.', schemaNodes: [{ id: 'place', name: 'place', type: 'string' }] }
const usedSchema = { ...placeSchema, schemaRevisionId: articleAttempt.schemaRevisionId, revisionNumber: 3 }
const currentRevision = { schemaRevisionId: '99999999-9999-4999-8999-999999999999', revisionNumber: 4 }

const parsedDocument = {
  content_stream: [{ kind: 'paragraph', block_id: 'b1', text: 'Graven var orienteret NØ-SV i Ravenna.' }],
  tables: [],
  evidence_index: { anchors: [{ kind: 'text', anchor_id: 'a1', block_id: 'b1' }] },
} as unknown as ParsedDocument

const ready = (result: unknown, evidenceLinks: EvidenceLink[] = []): ExtractionController['state'] =>
  ({ status: 'ready', result: result as Record<string, unknown>, evidenceLinks, ungroundedCount: 0 })
const decided = (resultPath: Path, anchor: string, action: ReviewDecisionInput['action'] = 'APPROVED',
  reviewedValue: ReviewDecisionInput['reviewedValue'] = null): ReviewDecisionInput =>
  ({ resultPath, evidenceAnchorId: anchor, reviewedOccurrenceIds: [`o-${anchor}`], action, reviewedValue })
const withAttempt = (resultPayload: ExtractionAttempt['resultPayload'], evidenceLinks: EvidenceLink[], extra: Partial<ExtractionAttempt> = {}): ExtractionAttempt =>
  ({ ...articleAttempt, complete: true, resultPayload, evidenceLinks, ...extra })

/** A value's row: its name in the mono line, the row the button around it. */
const rowOf = (name: string) => screen.getByText(name, { selector: 'span.font-mono' }).closest('button')!
const live = () => document.querySelector('p[aria-live="polite"]')!
const breakdown = () => document.querySelector('p[aria-live="off"]')!
function menu(item: string) {
  fireEvent.click(screen.getByRole('button', { name: 'More result actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: item }))
}
function exportAs(format: 'CSV' | 'Excel') {
  menu('Export…')
  fireEvent.click(screen.getByRole('button', { name: format }))
}
const openDetails = () => fireEvent.click(screen.getByRole('button', { name: 'Run details' }))
const drawer = () => within(screen.getByRole('dialog', { name: 'Run details' }))
function showMethod() {
  openDetails()
  fireEvent.click(screen.getByRole('button', { name: 'Show the method used' }))
}
const chip = (label: string) => within(screen.getByRole('group', { name: 'Show values' })).getByRole('button', { name: new RegExp(`^${label}`) })

/** A review the tab drives: `setDecision` records the call, marks the path touched (or not) and answers `{ last }`. */
function Reviewing({ attempt, initial, spy, last = () => false, review = {}, ...props }: {
  attempt: ExtractionAttempt
  initial: ReviewDecisionInput[]
  spy: (...args: unknown[]) => void
  last?: (touched: number) => boolean
  review?: Partial<Review>
} & Omit<ComponentProps<typeof ResultsTab>, 'controller' | 'schemaReady' | 'sourceDocumentName'>) {
  const [decisions, setDecisions] = useState(initial)
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set())
  const setDecision: Review['setDecision'] = (path, action, reviewedValue = null, evidence = null, touch = true) => {
    spy(path, action, reviewedValue, evidence, touch)
    const key = resultPathKey(path)
    const next = new Set(touched)
    if (touch) next.add(key)
    else next.delete(key)
    setTouched(next)
    setDecisions((current) => current.map((decision) => resultPathKey(decision.resultPath) === key ? { ...decision, action, reviewedValue } : decision))
    return { last: last(next.size) }
  }
  return (
    <ResultsTab schemaReady sourceDocumentName="review.pdf" {...props}
      controller={controller(ready(attempt.resultPayload, attempt.evidenceLinks ?? []), attempt, {
        available: true, decisions, isTouched: (path) => touched.has(resultPathKey(path)), setDecision,
        canAccept: touched.size === initial.length, ...review,
      })} />
  )
}

describe('ResultsTab header (§2.1)', () => {
  const catalogPartial = partialResultSchema.parse(partialFromProgress(progressFixture))
  const articlePartial: PartialResult = {
    strategy: 'ARTICLE', startedAtPage: null, discovered: 0, finished: 0, records: [],
    document: { contextsAnswered: 1, contexts: 3, groundingBatches: 0 },
  }
  const running = (partial: PartialResult | null): ExtractionController['state'] => ({ status: 'running', step: 'extraction', partial })
  const twoRecords = { records: [{ place: 'Oslo' }, { place: 'Bergen' }] }
  const reviewed = withAttempt({ records: [{ place: 'Oslo' }] }, [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'a' }], {
    reviewedAt: '2026-08-10T01:00:00.000Z', reviewDecisions: [{ ...decided(['records', 0, 'place'], 'a'), createdAt: '2026-08-10T01:00:00.000Z' }],
  })
  const states: Array<{ state: string; tab: ExtractionController; word: string; rest: string | null; link?: string }> = [
    { state: 'starting, no attempt yet', tab: controller(running(null)), word: 'Starting', rest: null },
    { state: 'starting, the previous attempt shown', tab: controller(running(null), articleAttempt), word: 'Starting', rest: null },
    { state: 'queued', tab: controller(running(null), queuedAttempt), word: 'Queued', rest: '· waiting for the extraction worker' },
    { state: 'running, no partial yet', tab: controller(running(null), runningAttempt), word: 'Starting', rest: '· finding records…' },
    { state: 'reading a Catalog', tab: controller(running(catalogPartial), runningAttempt), word: 'Reading records', rest: '· 2 of 5 · from page 1' },
    { state: 'reading an Article', tab: controller(running(articlePartial), { ...runningAttempt, strategy: 'ARTICLE' }), word: 'Reading the document', rest: '· 1 of 3 contexts' },
    { state: 'stopping', tab: { ...controller(running(catalogPartial), runningAttempt), cancellationRequested: true }, word: 'Stopping', rest: '· the run ends after the current call' },
    { state: 'stopped', tab: controller({ status: 'cancelled' }), word: 'Stopped', rest: '· nothing to review' },
    { state: 'failed', tab: controller({ status: 'error', message: 'Catalog discovery returned no records.' }, failedAttempt), word: 'Failed', rest: '· nothing to review', link: 'Show details' },
    { state: 'completed Catalog', tab: controller(ready(twoRecords), withAttempt(twoRecords, [], { strategy: 'CATALOG' })), word: 'Completed', rest: '· Catalog · 2 records ·', link: 'Schema rev 3' },
    { state: 'completed empty Catalog', tab: controller(ready({ records: [] }), withAttempt({ records: [] }, [], { strategy: 'CATALOG' })), word: 'Completed', rest: '· Catalog · no records found ·', link: 'Schema rev 3' },
    { state: 'completed Article', tab: controller(ready(twoRecords), withAttempt(twoRecords, [])), word: 'Completed', rest: '· Article ·', link: 'Schema rev 3' },
    { state: 'completed, not all of it', tab: controller(ready(twoRecords), { ...articleAttempt, resultPayload: twoRecords }), word: 'Completed, not all of it', rest: '·', link: 'Why?' },
    { state: 'review saved', tab: controller(ready(reviewed.resultPayload), reviewed), word: 'Review saved', rest: '· 1 decision · read-only' },
  ]

  it.each(states)('$state: $word $rest', ({ tab, word, rest, link }) => {
    render(<ResultsTab controller={tab} schemaReady sourceDocumentName="run.pdf" pinnedSchema={usedSchema} />)
    const line = screen.getByText(word, { selector: 'b' }).parentElement!
    if (rest === null) expect(line.querySelector('span')).toBeNull()
    else expect(within(line).getByText(rest)).toBeInTheDocument()
    if (link) expect(screen.getByRole('button', { name: link })).toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: PANEL_RUN })).toEqual([])
  })

  it('a failed run gives its message on a second line, and Show details opens the drawer at Extraction', () => {
    render(<ResultsTab controller={controller({ status: 'error', message: 'Catalog discovery returned no records.' }, failedAttempt)}
      schemaReady sourceDocumentName="failed.pdf" />)
    expect(screen.getByRole('button', { name: 'Show details' }).closest('p')).toHaveTextContent('Catalog discovery returned no records. Show details')
    expect(screen.getByText('Failed · Catalog discovery returned no records.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
    expect(drawer().getByText('Failed · Catalog strategy · 0 records found')).toBeInTheDocument()
  })

  it('a stopped run has nothing to review, and its draft decisions are discarded with a toast', () => {
    render(<ResultsTab controller={controller({ status: 'cancelled' }, null, { discarded: 2 })} schemaReady sourceDocumentName="stopped.pdf" />)
    expect(screen.getByText('Stopped · nothing to review')).toBeInTheDocument()
    expect(screen.getByText('Run stopped · your 2 decisions on it are discarded')).toBeInTheDocument()
  })

  it('a saved review dates its line and says what was not part of it', () => {
    render(<ResultsTab controller={controller(ready(reviewed.resultPayload), reviewed)} schemaReady sourceDocumentName="saved.pdf" />)
    expect(screen.getByText('Review saved', { selector: 'b' }).parentElement).toHaveAttribute('title', new Date(reviewed.reviewedAt!).toLocaleString())
    // Saved: Export is the status line's own button, no longer behind ⋯.
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument()
  })

  it('a previous-schema result carries the stale pill and the note line; the same revision carries neither', () => {
    const attempt = withAttempt({ records: [{ place: 'Rome' }] }, [])
    const { rerender } = render(<ResultsTab controller={controller(ready(attempt.resultPayload), attempt)} schemaReady sourceDocumentName="previous.pdf"
      pinnedSchema={usedSchema} currentSchemaRevision={currentRevision} />)
    expect(screen.getByText('Rev 3 · current is 4')).toBeInTheDocument()
    expect(screen.getByText('This review applies to Schema revision 3. Run extraction again to use revision 4; this review stays saved.')).toBeInTheDocument()
    rerender(<ResultsTab controller={controller(ready(attempt.resultPayload), attempt)} schemaReady sourceDocumentName="current.pdf"
      pinnedSchema={usedSchema} currentSchemaRevision={{ ...currentRevision, schemaRevisionId: articleAttempt.schemaRevisionId, revisionNumber: 3 }} />)
    expect(screen.queryByText(/current is/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Schema rev 3' }))
    expect(drawer().getByText('Revision 3 · the current revision')).toBeInTheDocument()
  })

  it('keeps the last known status and offers Reconnect after a lost connection', () => {
    const reconnect = vi.fn()
    render(<ResultsTab controller={{ ...controller(running(null), runningAttempt), reconnect,
      monitorError: 'Unable to update status. The extraction may still be running.' }} schemaReady sourceDocumentName="running.pdf" />)
    expect(screen.getByText('Starting', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent('Unable to update status. The extraction may still be running.')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(reconnect).toHaveBeenCalledOnce()
  })

  it('shows a cancellation failure apart, on the alert line', () => {
    render(<ResultsTab controller={{ ...controller(running(null), runningAttempt), cancellationError: 'Cancellation failed (HTTP 500)' }}
      schemaReady sourceDocumentName="running.pdf" />)
    expect(screen.getByRole('alert')).toHaveTextContent('Cancellation failed: Cancellation failed (HTTP 500)')
  })

  it('keeps the revision comparison and the used schema readable while queued, without inventing a loading revision', () => {
    const { rerender } = render(<ResultsTab controller={controller(running(null), queuedAttempt)} schemaReady sourceDocumentName="queued.pdf"
      pinnedSchema={usedSchema} currentSchemaRevision={currentRevision} />)
    expect(screen.getByText('Rev 3 · current is 4')).toBeInTheDocument()
    openDetails()
    expect(drawer().getByText('Revision 3 · current is 4')).toBeInTheDocument()
    fireEvent.click(drawer().getByRole('button', { name: 'View schema used' }))
    expect(drawer().getByText(/"place": "string"/)).toBeInTheDocument()
    fireEvent.click(drawer().getByRole('button', { name: 'Close run details' }))

    rerender(<ResultsTab controller={controller(running(null), runningAttempt)} schemaReady sourceDocumentName="running.pdf"
      currentSchemaRevision={{ ...currentRevision, schemaRevisionId: articleAttempt.schemaRevisionId }} />)
    expect(screen.queryByText(/current is/)).not.toBeInTheDocument()
    openDetails()
    expect(drawer().getByText('Revision … · current is 4')).toBeInTheDocument()
    expect(drawer().getByRole('button', { name: 'View schema used' })).toBeDisabled()
  })
})

describe('ResultsTab during a run and at settlement (§2.2, §2.3, §5.2, §5.3)', () => {
  const partial = partialResultSchema.parse(partialFromProgress(progressFixture))
  const finished = partial.records.filter((record) => record.state === 'finished')
  const links = finished.flatMap((record) => record.evidenceLinks)
  const decisions = links.map((link) => decided(link.resultPath, link.evidenceAnchorId))
  const schema: SchemaDefinition = { recordDescription: 'A find.', schemaNodes: [
    { id: 'label', name: 'label', type: 'string' }, { id: 'site', name: 'site', type: 'string' }, { id: 'material', name: 'material', type: 'string' },
    { id: 'gilded', name: 'gilded', type: 'boolean' },
    { id: 'finds', name: 'finds', type: 'array', children: [{ id: 'name', name: 'name', type: 'string' }, { id: 'count', name: 'count', type: 'integer' }] },
  ] }
  const settled = { records: finished.map((record) => record.record!) }
  const settledAttempt = withAttempt(settled, links, { strategy: 'CATALOG' })

  it('counts what is readable so far, by record, and keeps the filter and the selection across settlement', () => {
    const onResultPathChange = vi.fn()
    const accept = vi.fn(async () => true)
    const props = { schemaReady: true, sourceDocumentName: 'running.pdf', pinnedSchema: schema, onResultPathChange }
    const { rerender } = render(<ResultsTab {...props} controller={controller({ status: 'running', step: 'extraction', partial }, runningAttempt,
      { draftAvailable: true, decisions, isTouched: () => false, accept })} />)

    expect(screen.getByText('to check so far')).toBeInTheDocument()
    expect(screen.getByText('to check so far').querySelector('b')).toHaveTextContent('8')
    expect(screen.getByRole('img', { name: '0 approved, 0 edited, 0 rejected, 8 to check, of 8' })).toBeInTheDocument()
    expect(breakdown()).toHaveTextContent('0 approved · 0 edited · 0 rejected · draft until the run finishes')
    expect(screen.getByRole('button', { name: 'Approve rest…' })).toHaveAttribute('title', 'Available when the run finishes')
    // Chips count the readable records only: the read one and the read-and-checked one, not those still read or queued.
    expect(chip('Doubtful')).toHaveTextContent('Doubtful1')
    expect(chip('Not reviewable')).toHaveTextContent('Not reviewable2')
    expect(screen.getByRole('region', { name: '1, 5 to check' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '2, 3 to check' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: /^3, Checking \d+ values$/ })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '4, Reading…' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Record 5, Queued' })).toBeInTheDocument()
    expect(onResultPathChange).toHaveBeenLastCalledWith([])
    expect(live()).toHaveTextContent('2 read.')

    fireEvent.click(chip('To check'))
    fireEvent.click(within(screen.getByRole('region', { name: '1, 5 to check' })).getByText('Adorf'))
    const selected = () => within(screen.getByRole('region', { name: /^1, / })).getByText('Adorf').closest('button')!

    expect(selected()).toHaveAttribute('aria-expanded', 'true')

    rerender(<ResultsTab {...props} controller={controller(ready(settled, links), settledAttempt,
      { available: true, decisions, isTouched: () => false, accept, settlement: { kept: 0, changed: 0 } })} />)
    expect(screen.getByText('to check')).toBeInTheDocument()
    expect(chip('To check')).toHaveAttribute('aria-pressed', 'true')
    expect(selected()).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Run finished · 8 to check.', { selector: 'span' })).toBeInTheDocument()
    expect(live()).toHaveTextContent('Run finished · 8 to check.')
    expect(onResultPathChange).toHaveBeenLastCalledWith([])
    expect(accept).not.toHaveBeenCalled()
  })

  it('never saves at settlement when every value is already decided; it offers Save review', () => {
    const accept = vi.fn(async () => true)
    const props = { schemaReady: true, sourceDocumentName: 'running.pdf', pinnedSchema: schema }
    const { rerender } = render(<ResultsTab {...props} controller={controller({ status: 'running', step: 'extraction', partial }, runningAttempt,
      { draftAvailable: true, decisions, accept })} />)
    rerender(<ResultsTab {...props} controller={controller(ready(settled, links), settledAttempt,
      { available: true, decisions, canAccept: true, accept, settlement: { kept: 8, changed: 0 } })} />)
    expect(live()).toHaveTextContent('Run finished · your 8 decisions kept · nothing left to check.')
    expect(accept).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
    expect(accept).toHaveBeenCalledOnce()
  })
})

describe('ResultsTab rows and the selected row (§3.1–§3.3)', () => {
  const links: EvidenceLink[] = [
    { resultPath: ['records', 0, 'orientation'], evidenceAnchorId: 'a1', verbatim: true, lexicalHits: 1 },
    { resultPath: ['records', 0, 'place'], evidenceAnchorId: 'a1', linkedBy: 'lexical', verbatim: false, lexicalHits: 0 },
    { resultPath: ['records', 0, 'year'], evidenceAnchorId: 'a1', verbatim: false, lexicalHits: 0 },
  ]
  const attempt = withAttempt({ records: [{ orientation: 'NØ-SV', place: 'Ravenna', year: 1901, note: 'unlinked' }] }, links)
  const decisions = [decided(['records', 0, 'orientation'], 'a1'), decided(['records', 0, 'place'], 'a1'), decided(['records', 0, 'year'], 'a1', 'EDITED', 1902)]
  const yearTouched = (path: Path) => path[2] === 'year'
  const tab = (props: Partial<ComponentProps<typeof ResultsTab>> = {}) => (
    <ResultsTab controller={controller(ready(attempt.resultPayload, links), attempt, { available: true, decisions, isTouched: yearTouched })}
      schemaReady sourceDocumentName="rows.pdf" parsedDocument={parsedDocument} evidencePages={new Map([['a1', 4]])} {...props} />
  )

  it('selects one value at a time and opens its expansion: source line, quote with the value marked', () => {
    const onSelectEvidence = vi.fn()
    render(tab({ onSelectEvidence }))
    expect(rowOf('orientation')).toHaveTextContent('p.4')
    fireEvent.click(rowOf('orientation'))
    expect(onSelectEvidence).toHaveBeenCalledWith('a1')
    expect(rowOf('orientation')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('p.4 · Verifier-supported')).toBeInTheDocument()
    const mark = document.querySelector('mark')!
    expect(mark).toHaveTextContent('NØ-SV')
    expect(mark.parentElement).toHaveTextContent('Graven var orienteret NØ-SV i Ravenna.')
    expect(screen.getByRole('group', { name: 'Decision for orientation' })).toBeInTheDocument()
    // An unlinked value navigates nowhere.
    onSelectEvidence.mockClear()
    fireEvent.click(rowOf('note'))
    expect(onSelectEvidence).not.toHaveBeenCalled()
    expect(rowOf('orientation')).toHaveAttribute('aria-expanded', 'false')
  })

  it('a rule-linked doubtful value says so, by who linked it and why it is doubtful', () => {
    render(tab())
    expect(rowOf('place')).toHaveTextContent('p.4 · doubtful')
    fireEvent.click(rowOf('place'))
    expect(screen.getByText('p.4 · Linked by rule; no verifier checked it')).toBeInTheDocument()
    expect(screen.getByText('Doubtful link.').parentElement).toHaveTextContent('Doubtful link. Value not found in the linked passage.')
    expect(screen.queryByText('p.4 · Verifier-supported')).not.toBeInTheDocument()
  })

  it('an edited value shows its reviewed value, the extracted one struck, Evidence for the extracted value and no doubt', () => {
    const onSelectEvidence = vi.fn()
    render(tab({ onSelectEvidence }))
    expect(rowOf('year')).toHaveTextContent('1902')
    expect(chip('Doubtful')).toHaveTextContent('Doubtful1')
    fireEvent.click(rowOf('year'))
    expect(screen.getByText('1901', { selector: 's' }).parentElement).toHaveTextContent('Extracted value: 1901')
    expect(screen.getByText('Evidence for the extracted value · p.4 · Verifier-supported')).toBeInTheDocument()
    expect(screen.queryByText('Doubtful link.')).not.toBeInTheDocument()
    expect(onSelectEvidence).toHaveBeenCalledWith('a1')
    expect(screen.getByText('Edited', { selector: 'span.font-semibold' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('a not reviewable value gives its label, its detail and why it never blocks the review', () => {
    render(tab())
    expect(rowOf('note')).toHaveTextContent('no evidence')
    fireEvent.click(rowOf('note'))
    expect(screen.getByText('No evidence', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByText('This run kept no claim accounting, so whether its checks finished is not known.')).toBeInTheDocument()
    expect(screen.getByText('Not part of the review. It stays in the result and the export as extracted.')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /^Decision for/ })).not.toBeInTheDocument()
  })

  it('a rejected decision clears the doubt; approving it again brings the doubt back', () => {
    const doubtful = [decided(['records', 0, 'place'], 'a1')]
    const scene = (decision: ReviewDecisionInput) => (
      <ResultsTab controller={controller(ready(attempt.resultPayload, links), attempt, { decisions: [decision] })}
        schemaReady sourceDocumentName="rows.pdf" />
    )
    const { rerender } = render(scene(doubtful[0]!))
    expect(chip('Doubtful')).toHaveTextContent('Doubtful1')
    rerender(scene({ ...doubtful[0]!, action: 'REJECTED' }))
    expect(chip('Doubtful')).toHaveTextContent('Doubtful0')
    fireEvent.click(rowOf('place'))
    expect(screen.getByText(/^Evidence for the extracted value · /)).toBeInTheDocument()
    rerender(scene(doubtful[0]!))
    expect(chip('Doubtful')).toHaveTextContent('Doubtful1')
  })

  it('a filter hides other values, keeps the selected one pinned, and names a record with nothing left', () => {
    render(tab())
    fireEvent.click(rowOf('note'))
    fireEvent.click(chip('Doubtful'))
    expect(chip('Doubtful')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('orientation', { selector: 'span.font-mono' })).not.toBeInTheDocument()
    expect(rowOf('place')).toBeInTheDocument()
    expect(rowOf('note')).toHaveTextContent('outside the current filter')
  })

  it('opens one record of several, the first with a value to check, on its header with its page', () => {
    const result = { records: [{ place: 'Oslo' }, { place: 'Bergen' }] }
    const bergen: EvidenceLink[] = [{ resultPath: ['records', 1, 'place'], evidenceAnchorId: 'anchor-bergen' }]
    render(<ResultsTab controller={controller(ready(result, bergen), null, { decisions: [decided(['records', 1, 'place'], 'anchor-bergen')], isTouched: () => false })}
      schemaReady sourceDocumentName="Source" evidencePages={new Map([['anchor-bergen', 6]])} />)
    const oslo = screen.getByRole('region', { name: 'Oslo, all checked' })
    const second = screen.getByRole('region', { name: 'Bergen, 1 to check' })
    expect(within(second).getByRole('button', { expanded: true })).toHaveTextContent('Record 2 · p.6')
    expect(within(oslo).getByRole('button', { expanded: false })).toHaveTextContent(/Record 1(?! ·)/)
    expect(within(oslo).queryByText('place', { selector: 'span.font-mono' })).not.toBeInTheDocument()
    fireEvent.click(within(oslo).getByRole('button', { expanded: false }))
    expect(within(oslo).getByText('place', { selector: 'span.font-mono' })).toBeInTheDocument()
    expect(screen.queryByText('records', { exact: true })).not.toBeInTheDocument()
  })

  it('a single-record Catalog has its record header and page; an Article result has none', () => {
    const result = { records: [{ place: 'Oslo' }] }
    const evidenceLinks = [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-oslo' }]
    const tabFor = (strategy: 'ARTICLE' | 'CATALOG') => (
      <ResultsTab controller={controller(ready(result, evidenceLinks), withAttempt(result, evidenceLinks, { strategy }))}
        schemaReady sourceDocumentName="Source" evidencePages={new Map([['anchor-oslo', 3]])} />
    )
    const { rerender } = render(tabFor('CATALOG'))
    expect(screen.getByRole('region', { name: /^Oslo, / })).toHaveTextContent('Record 1 · p.3')
    rerender(tabFor('ARTICLE'))
    expect(screen.queryByRole('region', { name: /^Oslo, / })).not.toBeInTheDocument()
    expect(screen.queryByText(/Record 1/)).not.toBeInTheDocument()
    expect(rowOf('place')).toHaveTextContent('Oslo')
  })

  it('hides the Article records envelope while keeping Evidence paths', () => {
    const onSelectEvidence = vi.fn()
    const onResultPathChange = vi.fn()
    const evidenceLinks = [{ resultPath: ['records', 0, 'title'], evidenceAnchorId: 'anchor-1' }]
    render(<ResultsTab controller={controller(ready({ records: [{ title: 'Report' }] }, evidenceLinks))} schemaReady
      sourceDocumentName="Ravenna letters.pdf" onSelectEvidence={onSelectEvidence} onResultPathChange={onResultPathChange} />)
    expect(screen.queryByText('records', { exact: true })).not.toBeInTheDocument()
    expect(onResultPathChange).toHaveBeenLastCalledWith([])
    fireEvent.click(rowOf('title'))
    expect(onSelectEvidence).toHaveBeenCalledWith('anchor-1')
    menu('Values as code')
    expect(screen.getByText(/"title": "Report"/)).toBeInTheDocument()
    expect(screen.queryByText(/"records"/)).not.toBeInTheDocument()
  })

  it('renders markup-like schema names and extracted values as inert text', () => {
    const fieldName = '<script>field-secret</script>'
    const value = '<img src=x onerror="value-secret">'
    const markup = withAttempt({ records: [{ [fieldName]: value }] }, [{ resultPath: ['records', 0, fieldName], evidenceAnchorId: 'anchor-markup' }])
    render(<ResultsTab controller={controller(ready(markup.resultPayload, markup.evidenceLinks!), markup)} schemaReady
      pinnedSchema={{ recordDescription: '<b>record-secret</b>', schemaNodes: [{ id: 'markup', name: fieldName, type: 'string' }] }}
      sourceDocumentName="<svg onload='source-secret'>.pdf" />)
    expect(screen.getByText(value, { exact: true, selector: 'span' })).toBeVisible()
    expect(screen.getByText(fieldName, { exact: true })).toBeVisible()
    expect(document.querySelector('script')).toBeNull()
    expect(document.querySelector('img[src="x"]')).toBeNull()
    // Icons are real <svg> elements; the guard is that nothing from the injected strings became markup.
    expect(document.querySelector('[onload]')).toBeNull()
    menu('Values as code')
    expect(screen.getByText(/value-secret/, { selector: 'pre' })).toBeVisible()
    expect(document.querySelector('img[src="x"]')).toBeNull()
  })
})

describe('ResultsTab decisions, undo and saving (§3.3–§3.6, §6)', () => {
  const links: EvidenceLink[] = [
    { resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place' },
    { resultPath: ['records', 0, 'year'], evidenceAnchorId: 'anchor-year' },
  ]
  const twoValues = withAttempt({ records: [{ place: 'Original', year: 2000 }] }, links)
  const twoDecisions = [decided(['records', 0, 'place'], 'anchor-place'), decided(['records', 0, 'year'], 'anchor-year')]
  const schema: SchemaDefinition = { recordDescription: 'One place.', schemaNodes: [{ id: 'place', name: 'place', type: 'string' }, { id: 'year', name: 'year', type: 'integer' }] }

  it('a decision is pushed as a toast with Undo, said in the live region, and counted in the bar', () => {
    const spy = vi.fn()
    render(<Reviewing attempt={twoValues} initial={twoDecisions} spy={spy} pinnedSchema={schema} />)
    expect(screen.getByRole('img', { name: '0 approved, 0 edited, 0 rejected, 2 to check, of 2' })).toBeInTheDocument()
    fireEvent.click(rowOf('place'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(spy).toHaveBeenLastCalledWith(['records', 0, 'place'], 'APPROVED', null, null, true)
    expect(screen.getByText('Approved place.', { selector: 'span' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Undo ⌨Z' })).toBeInTheDocument()
    expect(live()).toHaveTextContent('Approved place. 1 to check.')
    expect(screen.getByRole('img', { name: '1 approved, 0 edited, 0 rejected, 1 to check, of 2' })).toBeInTheDocument()
    // The fixture's controller never acknowledges a draft: nothing is called saved yet.
    expect(breakdown()).toHaveTextContent(/^1 approved · 0 edited · 0 rejected$/)
    expect(document.activeElement).toBe(rowOf('place'))
  })

  // Production defect: `decide()` hands the toast the `undo` of the render before its own history entry was pushed, so the
  // toast's Undo reads a stale history (ResultsTab.tsx, decide → showToast … onAction: undo). Flip to `it` once fixed.
  it('the toast\'s Undo restores the decision as it was before, untouched', () => {
    const spy = vi.fn()
    render(<Reviewing attempt={twoValues} initial={twoDecisions} spy={spy} pinnedSchema={schema} />)
    fireEvent.click(rowOf('place'))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    fireEvent.click(screen.getByRole('button', { name: 'Undo ⌨Z' }))
    expect(spy).toHaveBeenLastCalledWith(['records', 0, 'place'], 'APPROVED', null, null, false)
    expect(live()).toHaveTextContent('Undone. place is to check again.')
  })

  it('rejects and edits a nested value by its type, and the row\'s Undo returns it to To check', () => {
    const spy = vi.fn()
    const nestedLinks = [
      { resultPath: ['records', 0, 'person', 'age'], evidenceAnchorId: 'anchor-age' },
      { resultPath: ['records', 0, 'person', 'name'], evidenceAnchorId: 'anchor-name' },
    ]
    const nested = withAttempt({ records: [{ person: { age: 5, name: 'Ada' } }] }, nestedLinks)
    const nestedSchema: SchemaDefinition = { recordDescription: 'One person.', schemaNodes: [{ id: 'person', name: 'person', type: 'object', children: [
      { id: 'age', name: 'age', type: 'integer' }, { id: 'name', name: 'name', type: 'string' },
    ] }] }
    render(<Reviewing attempt={nested} initial={nestedLinks.map((link) => decided(link.resultPath, link.evidenceAnchorId))} spy={spy}
      pinnedSchema={nestedSchema} />)
    const age = ['records', 0, 'person', 'age']
    fireEvent.click(rowOf('person › age'))
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(spy).toHaveBeenLastCalledWith(age, 'REJECTED', null, null, true)
    expect(screen.getByText('Rejected', { selector: 'span.font-semibold' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(spy).toHaveBeenLastCalledWith(age, 'APPROVED', null, null, false)
    expect(live()).toHaveTextContent('person › age is to check again.')

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const input = screen.getByLabelText('Reviewed value')
    expect(input).toHaveAttribute('type', 'number')
    fireEvent.change(input, { target: { value: '1.5' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number.')
    fireEvent.change(input, { target: { value: '7' } })
    // No silent save on blur (§3.5).
    fireEvent.blur(input)
    expect(spy).toHaveBeenLastCalledWith(age, 'APPROVED', null, null, false)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(spy).toHaveBeenLastCalledWith(age, 'EDITED', 7, null, true)
    expect(rowOf('person › age')).toHaveTextContent('7')
  })

  it('edits one item of a scalar array as one value of the item type', () => {
    const spy = vi.fn()
    const path = ['records', 0, 'grave_goods', 2]
    const graveLinks = [{ resultPath: path, evidenceAnchorId: 'anchor-sherd' }, { resultPath: ['records', 0, 'grave_goods', 0], evidenceAnchorId: 'anchor-pin' }]
    const grave = withAttempt({ records: [{ grave_goods: ['pin', 'bead', 'sherd'] }] }, graveLinks)
    render(<Reviewing attempt={grave} initial={graveLinks.map((link) => decided(link.resultPath, link.evidenceAnchorId))} spy={spy}
      pinnedSchema={{ recordDescription: 'One grave.', schemaNodes: [{ id: 'grave_goods', name: 'grave_goods', type: 'array', itemType: 'string' }] }} />)
    fireEvent.click(rowOf('grave_goods › 3'))
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    const input = screen.getByLabelText('Reviewed value')
    fireEvent.change(input, { target: { value: 'bronze pin, broken' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(spy).toHaveBeenLastCalledWith(path, 'EDITED', 'bronze pin, broken', null, true)
  })

  it('the last value warns that its decision saves the review, and saving it says so', async () => {
    const accept = vi.fn(async () => true)
    const spy = vi.fn()
    const one = withAttempt({ records: [{ place: 'Original' }] }, [links[0]!])
    render(<Reviewing attempt={one} initial={[twoDecisions[0]!]} spy={spy} last={(touched) => touched === 1} review={{ accept }} pinnedSchema={placeSchema} />)
    fireEvent.click(rowOf('place'))
    expect(screen.getByText('This is the last value to check. Your decision saves the review, and the review becomes read-only.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject and save review' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Save edit and save review' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Approve and save review' }))
    expect(accept).toHaveBeenCalledOnce()
    expect(await screen.findByText('Approved place. Review saved; it is now read-only.', { selector: 'span' })).toBeInTheDocument()
    expect(live()).toHaveTextContent('Approved place. Review saved; it is now read-only.')
  })

  it('an untouched, server-defaulted decision reads To check, never Approved', () => {
    render(<ResultsTab controller={controller(ready(twoValues.resultPayload, links), twoValues, { available: true, decisions: twoDecisions, isTouched: () => false })}
      schemaReady sourceDocumentName="untouched.pdf" />)
    expect(rowOf('place')).toHaveTextContent(/^To check/)
    expect(screen.queryByText('Approved', { selector: '.sr-only' })).not.toBeInTheDocument()
    fireEvent.click(rowOf('place'))
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  describe('Approve rest…', () => {
    const threeRecords = { records: [{ place: 'Oslo', year: 1901 }, { place: 'Bergen', year: 1902 }, { place: 'Tromsø', year: 1903 }] }
    const recordLinks: EvidenceLink[] = threeRecords.records.flatMap((_, index) => [
      { resultPath: ['records', index, 'place'], evidenceAnchorId: `p${index}`, verbatim: index === 0 ? false : true, lexicalHits: 1 },
      { resultPath: ['records', index, 'year'], evidenceAnchorId: `y${index}` },
    ])
    const recordDecisions = recordLinks.map((link) => decided(link.resultPath, link.evidenceAnchorId))
    const catalog = withAttempt(threeRecords, recordLinks, { strategy: 'CATALOG' })
    const scene = (review: Partial<Review>) => (
      <ResultsTab controller={controller(ready(threeRecords, recordLinks), catalog, { available: true, decisions: recordDecisions, ...review })}
        schemaReady sourceDocumentName="catalog.pdf" pinnedSchema={schema} />
    )
    const dialog = () => screen.getByRole('dialog', { name: 'Approve the rest and save the review' })

    it('says what it covers across records, then approves all and saves in one act', async () => {
      const calls: string[] = []
      const accept = vi.fn(async () => { calls.push('accept'); return true })
      render(scene({ isTouched: () => false, approveAll: () => { calls.push('approveAll') }, accept }))
      fireEvent.click(screen.getByRole('button', { name: 'Approve rest…' }))
      expect(within(dialog()).getByText('Approve the 6 values still to check and save the review?')).toBeInTheDocument()
      expect(within(dialog()).getByText('6 values across 3 records, including 1 with a doubtful link.')).toBeInTheDocument()
      expect(within(dialog()).getByText('Filters don’t limit this. Your edits and rejections stay as they are. Saving makes the review read-only, so this can’t be undone.')).toBeInTheDocument()
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Approve 6 and save review' }))
      expect(calls).toEqual(['approveAll', 'accept'])
      expect(await screen.findByText('Approved 6 values. Review saved; it is now read-only.', { selector: 'span' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Undo ⌨Z' })).not.toBeInTheDocument()
    })

    it('names the one record left, and the others as already checked', () => {
      render(scene({ isTouched: (path) => path[1] !== 0 }))
      fireEvent.click(screen.getByRole('button', { name: 'Approve rest…' }))
      expect(within(dialog()).getByText('2 values in Oslo, including 1 with a doubtful link. The other 2 records are already checked.')).toBeInTheDocument()
    })

    it('refuses while an edit is open', () => {
      const approveAll = vi.fn()
      render(scene({ isTouched: () => false, approveAll }))
      fireEvent.click(screen.getByRole('button', { name: 'Approve rest…' }))
      // The dialog is not modal in jsdom: open an edit behind it.
      fireEvent.click(within(screen.getByRole('region', { name: 'Oslo, 2 to check' })).getByText('1901'))
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
      expect(within(dialog()).getByText('Finish or cancel the edit in progress first.')).toBeInTheDocument()
      expect(within(dialog()).getByRole('button', { name: 'Approve 6 and save review' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Approve rest…' })).toBeDisabled()
      expect(approveAll).not.toHaveBeenCalled()
    })
  })

  it.each([
    { scene: 'every value decided', result: twoValues.resultPayload, evidenceLinks: links, decisions: twoDecisions, empty: null },
    { scene: 'no linked values', result: { records: [{ title: 'Report', place: 'Unknown' }] }, evidenceLinks: [], decisions: [], empty: null },
    { scene: 'an empty Catalog', result: { records: [] }, evidenceLinks: [], decisions: [], empty: 'No records were found in the source.' },
  ])('with nothing to check ($scene), Save review saves only when clicked', async ({ result, evidenceLinks, decisions, empty }) => {
    const accept = vi.fn(async () => true)
    render(<ResultsTab controller={controller(ready(result, evidenceLinks), withAttempt(result, evidenceLinks, { strategy: 'CATALOG' }),
      { available: true, canAccept: true, decisions, accept })} schemaReady sourceDocumentName="save.pdf" />)
    expect(screen.getByText('to check').querySelector('b')).toHaveTextContent('0')
    if (empty) expect(screen.getByText(empty)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve rest…' })).not.toBeInTheDocument()
    expect(accept).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Save review' }))
    expect(accept).toHaveBeenCalledOnce()
    expect(await screen.findByText('Review saved. It is now read-only.', { selector: 'span' })).toBeInTheDocument()
  })

  it('counts values without a link as not reviewable, never as to check', () => {
    const result = { records: [{ title: 'Report', place: 'Unknown' }] }
    render(<ResultsTab controller={controller(ready(result), withAttempt(result, []))} schemaReady sourceDocumentName="none.pdf" />)
    expect(chip('Not reviewable')).toHaveTextContent('Not reviewable2')
    expect(screen.getByRole('img', { name: '0 approved, 0 edited, 0 rejected, 0 to check, of 0' })).toBeInTheDocument()
  })

  it.each([
    { review: { draftSaving: true }, text: 'Saving draft…', action: null },
    { review: { draftSaved: true }, text: 'draft saved', action: null },
    { review: { draftError: 'Offline' }, text: 'Draft not saved', action: 'Retry draft' },
    { review: { draftError: REVIEW_DRAFT_CONFLICT }, text: 'The review changed elsewhere', action: 'Reload server review' },
    { review: { saving: true }, text: 'Saving review…', action: null },
    { review: { error: 'Offline' }, text: 'Review not saved', action: 'Retry' },
  ])('the breakdown line reads "$text"', ({ review, text, action }) => {
    const retryDraft = vi.fn()
    const accept = vi.fn(async () => true)
    render(<ResultsTab controller={controller(ready(twoValues.resultPayload, links), twoValues,
      { available: true, decisions: twoDecisions, isTouched: () => false, retryDraft, accept, ...review })} schemaReady sourceDocumentName="draft.pdf" />)
    expect(breakdown()).toHaveTextContent(`0 approved · 0 edited · 0 rejected · ${text}${action ? ` · ${action}` : ''}`)
    if (!action) return
    fireEvent.click(within(breakdown() as HTMLElement).getByRole('button', { name: action }))
    if (action === 'Retry') expect(accept).toHaveBeenCalledOnce()
    else expect(retryDraft).toHaveBeenCalledOnce()
  })
})

describe('ResultsTab read-only reviews (§2.2, §6)', () => {
  const place = [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place' }]
  const saved = (action: ReviewDecisionInput['action'], reviewedValue: ReviewDecisionInput['reviewedValue'] = null) => withAttempt(
    { records: [{ place: 'Original' }] }, place,
    { reviewedAt: '2026-08-10T01:00:00.000Z', reviewDecisions: [{ ...decided(['records', 0, 'place'], 'anchor-place', action, reviewedValue), createdAt: '2026-08-10T01:00:00.000Z' }] },
  )

  it('an inspected saved review shows its decisions as made, read-only', () => {
    // The live controller's untouched set belongs to a newer attempt: the inspected review's decisions count as made.
    render(<ResultsTab controller={controller(ready({ records: [{ place: 'Newer' }] }), { ...articleAttempt, extractionId: '22222222-2222-4222-8222-222222222222' }, { isTouched: () => false })}
      inspectedAttempt={saved('EDITED', 'Revised place')} readOnly schemaReady pinnedSchema={usedSchema} currentSchemaRevision={currentRevision} sourceDocumentName="historical.pdf" />)
    expect(rowOf('place')).toHaveTextContent(/^Edited.*Revised place/)
    expect(screen.queryByText('To check', { selector: '.sr-only' })).not.toBeInTheDocument()
    expect(screen.getByText('Rev 3 · current is 4')).toBeInTheDocument()
    fireEvent.click(rowOf('place'))
    expect(screen.getByText('Edited · saved')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: /^Decision for/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument()
  })

  it('its own saved attempt offers no decision, even with a leftover pending one', () => {
    const setDecision = vi.fn(() => ({ last: false }))
    const attempt = saved('APPROVED')
    render(<ResultsTab controller={controller(ready(attempt.resultPayload, place), attempt, {
      available: true, reviewedExtractionId: attempt.extractionId, decisions: [decided(['records', 0, 'place'], 'anchor-place', 'REJECTED')], setDecision,
    })} schemaReady pinnedSchema={placeSchema} sourceDocumentName="already-saved.pdf" />)
    expect(rowOf('place')).toHaveTextContent('Original')
    fireEvent.click(rowOf('place'))
    expect(screen.getByText('Approved · saved')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reject/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('reports one result path when a parent stores it', () => {
    const onResultPathChange = vi.fn<(path: string[] | null) => void>()
    function Fixture() {
      const [, setResultPath] = useState<string[] | null>(null)
      const store = useCallback((path: string[] | null) => {
        onResultPathChange(path)
        // Bound a regression so the test fails instead of exhausting React.
        if (onResultPathChange.mock.calls.length < 3) setResultPath(path)
      }, [])
      return <ResultsTab controller={controller({ status: 'idle' })} inspectedAttempt={saved('EDITED', 'Revised place')} readOnly schemaReady
        pinnedSchema={placeSchema} sourceDocumentName="historical.pdf" onResultPathChange={store} />
    }
    render(<Fixture />)
    expect(onResultPathChange).toHaveBeenCalledOnce()
    expect(onResultPathChange).toHaveBeenLastCalledWith([])
  })

  it('a previous-schema result keeps its review open', () => {
    const setDecision = vi.fn(() => ({ last: false }))
    const attempt = withAttempt({ records: [{ place: 'Original' }] }, place)
    render(<ResultsTab controller={controller(ready(attempt.resultPayload, place), attempt, {
      available: true, decisions: [decided(['records', 0, 'place'], 'anchor-place')], isTouched: () => false, setDecision,
    })} schemaReady pinnedSchema={usedSchema} currentSchemaRevision={currentRevision} sourceDocumentName="previous.pdf" />)
    expect(screen.getByText('Rev 3 · current is 4')).toBeInTheDocument()
    fireEvent.click(rowOf('place'))
    fireEvent.click(screen.getByRole('button', { name: /^Reject/ }))
    expect(setDecision).toHaveBeenCalledWith(['records', 0, 'place'], 'REJECTED', null)
  })
})

describe('ResultsTab ⋯ menu and Run details (§8)', () => {
  const place = [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place' }]
  const attempt = withAttempt({ records: [{ place: 'Original' }] }, place)

  it('shows the reviewed result as code, ordered by the pinned schema, and goes back to review', () => {
    const result = { records: [{ year: 2020, title: 'Grounded' }] }
    const { container } = render(<ResultsTab controller={controller(ready(result))} schemaReady sourceDocumentName="Source"
      pinnedSchema={{ recordDescription: 'Source', schemaNodes: [{ id: 'title', name: 'title', type: 'string' }, { id: 'year', name: 'year', type: 'integer' }] }} />)
    expect(container.textContent!.indexOf('title')).toBeLessThan(container.textContent!.indexOf('year'))
    menu('Values as code')
    expect(container.querySelector('pre')!.textContent).toBe(JSON.stringify({ title: 'Grounded', year: 2020 }, null, 2))
    expect(Object.keys(result.records[0]!)).toEqual(['year', 'title'])
    fireEvent.click(screen.getByRole('button', { name: 'Back to review' }))
    expect(container.querySelector('pre')).toBeNull()
    expect(rowOf('title')).toBeInTheDocument()
  })

  it('orders a historical reviewed result by its pinned schema, else by its payload', () => {
    const historical = { ...articleAttempt, resultPayload: { records: [{ year: 2020, title: 'Grounded' }] }, reviewedAt: '2026-09-06T00:00:00Z', reviewDecisions: [
      { ...decided(['records', 0, 'title'], 'anchor', 'EDITED', 'Corrected'), createdAt: '2026-09-06T00:00:00Z' },
      { ...decided(['records', 0, 'year'], 'anchor', 'REJECTED'), createdAt: '2026-09-06T00:00:00Z' },
    ] }
    const props = { controller: controller({ status: 'idle' }), schemaReady: true, sourceDocumentName: 'Source', inspectedAttempt: historical }
    const { container, rerender } = render(<ResultsTab {...props} pinnedSchema={{ recordDescription: 'Historical', schemaNodes: [
      { id: 'title', name: 'title', type: 'string' }, { id: 'year', name: 'year', type: 'integer' },
    ] }} />)
    menu('Values as code')
    expect(container.querySelector('pre')!.textContent).toBe(JSON.stringify({ title: 'Corrected', year: null }, null, 2))
    rerender(<ResultsTab {...props} />)
    expect(container.querySelector('pre')!.textContent).toBe(JSON.stringify({ year: null, title: 'Corrected' }, null, 2))
    expect(historical.resultPayload.records[0]).toEqual({ year: 2020, title: 'Grounded' })
  })

  it('"Edit field … in the schema" waits for a selection, then edits that field', () => {
    const onEditField = vi.fn()
    render(<ResultsTab controller={controller(ready(attempt.resultPayload, place), attempt)} schemaReady sourceDocumentName="Source"
      pinnedSchema={placeSchema} onEditField={onEditField} />)
    fireEvent.click(screen.getByRole('button', { name: 'More result actions' }))
    expect(screen.getByRole('menuitem', { name: 'Edit field in the schema…' })).toBeDisabled()
    expect(screen.getByRole('menuitem', { name: 'Edit field in the schema…' })).toHaveAttribute('title', 'Select a value first')
    fireEvent.click(screen.getByRole('button', { name: 'More result actions' }))
    fireEvent.click(rowOf('place'))
    menu('Edit field place in the schema…')
    expect(onEditField).toHaveBeenCalledExactlyOnceWith('place', ['records', 0, 'place'])
  })

  it('opens Run details with focus on its heading; Escape closes it and focus returns to ⓘ', () => {
    render(<ResultsTab controller={controller(ready(attempt.resultPayload, place), attempt)} schemaReady sourceDocumentName="Source" />)
    const opener = screen.getByRole('button', { name: 'Run details' })
    fireEvent.click(opener)
    expect(opener).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(drawer().getByRole('heading', { name: 'Run details' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Run details' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('"Why?" opens the drawer at a not-all-of-it Extraction', () => {
    render(<ResultsTab controller={controller(ready(articleAttempt.resultPayload), articleAttempt)} schemaReady sourceDocumentName="Source" />)
    fireEvent.click(screen.getByRole('button', { name: 'Why?' }))
    expect(drawer().getByText('Completed, not all of it · Article strategy · 1 record found')).toBeInTheDocument()
    expect(drawer().getByText('How many records the source holds is not measured, so a missing record would not show here.')).toBeInTheDocument()
  })

  it('shows Catalog diagnostics behind the method used', () => {
    const catalogAttempt: ExtractionAttempt = {
      ...articleAttempt, strategy: 'CATALOG',
      diagnostics: { ...articleAttempt.diagnostics!, catalog: {
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
      } },
    }
    render(<ResultsTab controller={controller(ready(catalogAttempt.resultPayload), catalogAttempt)} schemaReady sourceDocumentName="Catalog.pdf" />)
    expect(screen.getByText('Completed, not all of it', { selector: 'b' })).toBeInTheDocument()
    expect(screen.queryByTestId('catalog-record-diagnostics')).not.toBeInTheDocument()
    showMethod()
    expect(screen.getByTestId('catalog-record-diagnostics')).toBeInTheDocument()
    expect(screen.getByText(/Record 2 · failed · executed · Second entry/)).toBeInTheDocument()
    expect(screen.getByText(/Record 3 · not attempted · executed · Third entry/)).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog stage discovery: succeeded, reused')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog record 1: succeeded, reused, First entry')).toBeInTheDocument()
  })

  it('names the model each role ran on in the technical details, when kei-exp reported them', () => {
    const renderWith = (shown: ExtractionAttempt) =>
      render(<ResultsTab controller={controller(ready(shown.resultPayload), shown)} schemaReady sourceDocumentName="Article.pdf" />)
    renderWith({ ...articleAttempt, requestedModels: { fields: 'nuextract' }, modelAttribution: { provider: 'kei-exp', modelId: 'numind/NuExtract3-FP8' },
      diagnostics: { ...articleAttempt.diagnostics!, models: { fields: 'numind/NuExtract3-FP8', reasoning: 'Qwen/Qwen3.8-27B-FP8' } } })
    showMethod()
    expect(screen.getByText('Field model').nextElementSibling).toHaveTextContent('numind/NuExtract3-FP8')
    expect(screen.getByText('Reasoning model').nextElementSibling).toHaveTextContent('Qwen/Qwen3.8-27B-FP8')
    cleanup()
    renderWith(articleAttempt)
    showMethod()
    expect(screen.getByText('Phase')).toBeInTheDocument()
    expect(screen.queryByText('Field model')).not.toBeInTheDocument()
  })

  it('shows executed and reused provenance for an inspected Catalog child', () => {
    const child: ExtractionAttempt = {
      ...articleAttempt, extractionId: '66666666-6666-4666-8666-666666666666', strategy: 'CATALOG', complete: true,
      diagnostics: { ...articleAttempt.diagnostics!, catalog: {
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
      } },
      resultPayload: { records: [{ place: 'First place' }, { place: 'Second place' }] },
    }
    render(<ResultsTab controller={controller({ status: 'idle' })} inspectedAttempt={child} readOnly schemaReady sourceDocumentName="Catalog.pdf" />)
    showMethod()
    expect(screen.getByLabelText('Catalog stage document-values: succeeded, reused')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog stage record-values: succeeded, executed')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog record 1: succeeded, reused, First entry')).toBeInTheDocument()
    expect(screen.getByLabelText('Catalog record 2: succeeded, executed, Second entry')).toBeInTheDocument()
  })
})

describe('ResultsTab export', () => {
  it('exports the displayed result to Excel with nested and scalar-array schema paths', () => {
    render(<ResultsTab controller={controller(ready({ records: [{ context: { title: 'Current', tags: ['a'] } }] }))} schemaReady
      sourceDocumentName="current.pdf" exportSchema={currentExportSchema} />)
    exportAs('Excel')
    expect(exportExtractionResult).toHaveBeenCalledWith({ context: { title: 'Current', tags: ['a'] } }, {
      format: 'xlsx', filename: 'current.pdf', schemaNodes: currentExportSchema.schemaNodes,
      choices: { rowsRepresent: '$', otherRepeatedFields: 'preserve' },
    })
  })

  it('exports the inspected historical result to CSV with its historical schema', () => {
    const historicalAttempt: ExtractionAttempt = { ...articleAttempt, extractionId: '55555555-5555-4555-8555-555555555555',
      resultPayload: { records: [{ findings: [{ value: 'Historical' }] }] } }
    render(<ResultsTab controller={controller(ready({ records: [{ context: { title: 'Current' } }] }))} inspectedAttempt={historicalAttempt}
      readOnly schemaReady sourceDocumentName="historical.pdf" exportSchema={historicalExportSchema} />)
    menu('Export…')
    fireEvent.change(screen.getByLabelText('Rows represent'), { target: { value: 'findings' } })
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
    expect(exportExtractionResult).toHaveBeenCalledWith({ findings: [{ value: 'Historical' }] }, {
      format: 'csv', filename: 'historical.pdf', schemaNodes: historicalExportSchema.schemaNodes,
      choices: { rowsRepresent: 'findings', otherRepeatedFields: 'preserve' },
    })
  })

  it('exports reviewed edits and shows the exact used Schema Revision read-only in the drawer', () => {
    const place = [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'anchor-place' }]
    const attempt = withAttempt({ records: [{ place: 'Original' }] }, place)
    render(<ResultsTab controller={controller(ready(attempt.resultPayload, place), attempt, {
      available: true, decisions: [decided(['records', 0, 'place'], 'anchor-place', 'EDITED', 'Reviewed')],
    })} schemaReady pinnedSchema={usedSchema} exportSchema={usedSchema} sourceDocumentName="reviewed.pdf" />)
    expect(rowOf('place')).toHaveTextContent('Reviewed')
    exportAs('CSV')
    expect(exportExtractionResult).toHaveBeenCalledWith({ place: 'Reviewed' }, expect.objectContaining({ format: 'csv', schemaNodes: usedSchema.schemaNodes }))
    openDetails()
    const disclosure = drawer().getByRole('button', { name: 'View schema used' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(drawer().getByRole('button', { name: 'Close run details' }))
    // "Schema rev 3" opens the drawer at its Schema section, the used schema shown.
    fireEvent.click(screen.getByRole('button', { name: 'Schema rev 3' }))
    expect(drawer().getByRole('button', { name: 'View schema used' })).toHaveAttribute('aria-expanded', 'true')
    expect(drawer().getByText(/"place": "string"/)).toBeInTheDocument()
  })

  describe('a value the sources disagreed on', () => {
    const contestedAttempt = (resultPayload: ExtractionAttempt['resultPayload'], contested: NonNullable<ExtractionAttempt['diagnostics']>['contested']): ExtractionAttempt =>
      ({ ...articleAttempt, resultPayload, diagnostics: { ...articleAttempt.diagnostics!, contested } })
    const renderContested = (result: NonNullable<ExtractionAttempt['resultPayload']>, contested: NonNullable<ExtractionAttempt['diagnostics']>['contested']) =>
      render(<ResultsTab controller={controller(ready(result), contestedAttempt(result, contested))} schemaReady sourceDocumentName="contested.pdf"
        exportSchema={{ recordDescription: 'A work.', schemaNodes: [{ id: 'place', name: 'place', type: 'string' }, { id: 'year', name: 'year', type: 'integer' }] }} />)

    it('is Contested with its candidates, apart from an ordinary Missing value; both not reviewable', () => {
      renderContested({ records: [{ place: null, year: null }] }, [{ resultPath: ['records', 0, 'year'], candidates: [1901, 1902] }])
      expect(rowOf('year')).toHaveTextContent(/^Contested.*No value.*contested$/)
      expect(rowOf('place')).toHaveTextContent(/^Missing.*No value.*missing$/)
      expect(chip('Not reviewable')).toHaveTextContent('Not reviewable2')
      fireEvent.click(rowOf('year'))
      expect(screen.getByText('Contested', { selector: 'p' })).toBeInTheDocument()
      expect(screen.getByText('Sources disagreed: “1901” · “1902”.')).toBeInTheDocument()
      expect(screen.getByText('Not part of the review. It stays in the result and the export as extracted.')).toBeInTheDocument()
    })

    it('says what a CSV loses and hands the export the contested fields for the workbook notes', () => {
      renderContested({ records: [{ place: 'Oslo', year: null }, { place: null, year: null }] }, [{ resultPath: ['records', 1, 'place'], candidates: ['Bergen', 'Bodø'] }])
      menu('Export…')
      expect(screen.getAllByRole('note').map((note) => note.textContent)).toEqual([
        'This export holds values only; contested fields are listed on the Excel Review notes sheet.',
        'CSV leaves 1 contested field empty; their candidates are only in the Excel Review notes sheet and in Studio.',
      ])
      fireEvent.click(screen.getByRole('button', { name: 'Excel' }))
      expect(exportExtractionResult).toHaveBeenCalledWith([{ place: 'Oslo', year: null }, { place: null, year: null }],
        expect.objectContaining({ format: 'xlsx', contested: [{ record: 1, path: ['place'], candidates: ['Bergen', 'Bodø'] }] }))
    })
  })
})

describe('ResultsTab and the one way to run', () => {
  // Decision 03: the tab strip's "▶ Run extraction" is the only run. The Results tab offers none of its own; its empty
  // state points at that button.
  const catalogAttempt: ExtractionAttempt = { ...articleAttempt, strategy: 'CATALOG', complete: true }
  const completed = ready(catalogAttempt.resultPayload)
  const surfaces = [
    { surface: 'completed result', pointer: null, props: { controller: controller(completed, catalogAttempt) } },
    { surface: 'previous-schema result', pointer: null, props: { controller: controller(completed, catalogAttempt), currentSchemaRevision: currentRevision } },
    { surface: 'failed attempt', pointer: null, props: { controller: controller({ status: 'error', message: 'Catalog discovery returned no records.' }, failedAttempt) } },
    { surface: 'cancelled attempt', pointer: null, props: { controller: controller({ status: 'cancelled' }) } },
    { surface: 'document without results', pointer: /^Press ▶ Run extraction above\.$/, props: { controller: controller({ status: 'idle' }) } },
  ]

  it.each(surfaces)('a $surface offers no run action of its own; only the empty state points at ▶ Run extraction', ({ props, pointer }) => {
    render(<ResultsTab {...props} schemaReady sourceDocumentName="Catalog.pdf" />)
    expect(screen.queryAllByRole('button', { name: PANEL_RUN })).toEqual([])
    if (pointer === null) expect(screen.queryByText(/Press ▶ Run extraction/)).not.toBeInTheDocument()
    else expect(screen.getByText(pointer)).toBeInTheDocument()
  })

  // A read-only view (an earlier attempt) starts no Extraction, so it points at none.
  it.each(surfaces)('a read-only $surface points at no run', ({ props }) => {
    render(<ResultsTab {...props} readOnly schemaReady sourceDocumentName="Catalog.pdf" />)
    expect(screen.queryAllByRole('button', { name: PANEL_RUN })).toEqual([])
    expect(screen.queryByText(/Press ▶ Run extraction/)).not.toBeInTheDocument()
  })

  it('the empty state gives Run\'s unavailable reason instead of the pointer while Run cannot start', () => {
    const { rerender } = render(<ResultsTab controller={controller({ status: 'idle' })} schemaReady sourceDocumentName="Catalog.pdf"
      runUnavailableReason="Choose Article or Catalog in the schema header" />)
    expect(screen.getByText('Choose Article or Catalog in the schema header')).toBeInTheDocument()
    expect(screen.queryByText(/Press ▶ Run extraction/)).not.toBeInTheDocument()
    rerender(<ResultsTab controller={controller({ status: 'idle' })} schemaReady sourceDocumentName="Catalog.pdf" runUnavailableReason={null} />)
    expect(screen.getByText('No results yet')).toBeInTheDocument()
    expect(screen.getByText('Press ▶ Run extraction above.')).toBeInTheDocument()
    expect(screen.queryByText('Choose Article or Catalog in the schema header')).not.toBeInTheDocument()
  })

  it('before a schema is ready the empty state asks for one and points at no run', () => {
    render(<ResultsTab controller={controller({ status: 'idle' })} schemaReady={false} sourceDocumentName="Catalog.pdf" />)
    expect(screen.getByText('No results yet')).toBeInTheDocument()
    expect(screen.getByText('Generate a schema in the Schema tab first, then run extraction.')).toBeInTheDocument()
    expect(screen.queryByText(/Press ▶ Run extraction/)).not.toBeInTheDocument()
  })
})

describe('ResultsTab recipe review material, in Run details', () => {
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
  const recipeReview = (attempt: ExtractionAttempt) => {
    render(<ResultsTab controller={controller({ status: 'idle' })} schemaReady sourceDocumentName="Catalogue" inspectedAttempt={attempt} />)
    openDetails()
    return screen.queryByRole('region', { name: 'Recipe review' })
  }

  it('shows coverage, proposals and rejections apart from the accepted values, with recall unmeasured', () => {
    const panel = recipeReview(groundedAttempt)!
    expect(panel).toHaveTextContent('numbered-catalogue-de@1')
    expect(panel).toHaveTextContent('3 of 40 source lines unresolved')
    expect(panel).toHaveTextContent('Recall is not measured')
    expect(panel).toHaveTextContent('Entry 31 · site_name: Eichdorf')
    expect(panel).toHaveTextContent('Entry 31 · fundart: Siedl. (quote not in entry)')
    expect(panel).not.toHaveTextContent('%')  // no confidence number is derived from these flags
  })

  it('names every reason coverage is incomplete and lists what segmentation could not settle', () => {
    const panel = recipeReview({ ...groundedAttempt, diagnostics: { ...groundedAttempt.diagnostics!, grounded: {
      ...groundedAttempt.diagnostics!.grounded!,
      coverage: { complete: false, unresolved: 0, lines: 40, potential_duplicates: 0, reading_order_issues: 1 },
      segmentationDiagnostics: [{ code: 'reading_order', detail: 'p1_s2 follows p1_s1 against the column order', block: null, spans: [] }],
    } } })!
    expect(panel).toHaveTextContent('reading order disagrees with the page layout in 1 place.')
    expect(panel).not.toHaveTextContent('0 of 40')
    expect(panel).toHaveTextContent('1 segmentation note')
    expect(panel).toHaveTextContent('reading order: 1 — p1_s2 follows p1_s1 against the column order')
  })

  it('shows nothing of the kind for a version 1 result', () => {
    expect(recipeReview(articleAttempt)).toBeNull()
  })

  it('a key-linked value reads as linked by rule; after an edit or rejection its Evidence stays reachable as Evidence for the extracted value', () => {
    const span = { segment: 'p1_s2', start: 4, end: 12 }
    const evidenceLinks: EvidenceLink[] = [{
      resultPath: ['records', 0, 'site_name'], evidenceAnchorId: 'a_site', verbatim: true, lexicalHits: 1,
      grounding: { linkedBy: 'key', provenance: 'token', textSpans: [span], keySpans: [], alternatives: [], heading: null, precision: 'segment', raw: 'Eichdorf', normalized: null },
    }]
    const result = { records: [{ site_name: 'Eichdorf' }] }
    const decision = decided(['records', 0, 'site_name'], 'a_site')
    const onSelectEvidence = vi.fn()
    const scene = (reviewed: ReviewDecisionInput) => <ResultsTab controller={controller(ready(result, evidenceLinks), null, { decisions: [reviewed] })}
      schemaReady sourceDocumentName="Catalogue" onSelectEvidence={onSelectEvidence} />
    const { rerender } = render(scene(decision))
    fireEvent.click(rowOf('site_name'))
    expect(screen.getByText('Linked by rule; no verifier checked it')).toBeInTheDocument()
    for (const reviewed of [{ ...decision, action: 'EDITED' as const, reviewedValue: 'Eichdorf-Süd' }, { ...decision, action: 'REJECTED' as const }]) {
      rerender(scene(reviewed))
      if (reviewed.action === 'EDITED') {
        expect(rowOf('site_name')).toHaveTextContent('Eichdorf-Süd')
        expect(screen.getByText('Eichdorf', { selector: 's' })).toBeInTheDocument()
      }
      expect(screen.getByText('Evidence for the extracted value · Linked by rule; no verifier checked it')).toBeInTheDocument()
    }
    expect(onSelectEvidence).toHaveBeenCalledWith('a_site')
  })
})

describe('Method used, in Run details', () => {
  const SPANS: ArticleSettings = { context: 'bounded', context_tokens: 12288, overlap_passages: 0, identity: 'reference', identity_fields: [],
    prompt: 'schema', grounding: 'spans', grounding_schedule: 'unresolved', evidence_policy: 'schema' }
  const renderWith = (attempt: ExtractionAttempt) => render(
    <ResultsTab controller={controller(attempt.executionStatus === 'FAILED'
      ? { status: 'error', message: attempt.failure!.message } : ready(attempt.resultPayload), attempt)} schemaReady sourceDocumentName="Article.pdf" />)
  const methodUsed = () => { showMethod(); return within(screen.getByRole('region', { name: 'Method used' })) }

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

describe('ResultsTab verification completeness', () => {
  const attempt: ExtractionAttempt = {
    ...articleAttempt,
    resultPayload: { records: [{ publisher: 'Viega', items: [{ sku: '77317', pack_qty: 10 }, { sku: '77318', pack_qty: 5 }] }] },
    evidenceLinks: [{ resultPath: ['records', 0, 'items', 0, 'sku'], evidenceAnchorId: 'a_p1_s3_r3_c2', precision: 'cell', verbatim: true, lexicalHits: 1 }],
    diagnostics: { ...articleAttempt.diagnostics!, grounding: {
      groundedPaths: [['records', 0, 'items', 0, 'sku']],
      ungroundedPaths: [['records', 0, 'publisher'], ['records', 0, 'items', 1, 'pack_qty'], ['records', 0, 'items', 0, 'pack_qty'], ['records', 0, 'items', 1, 'sku']],
      issueCodes: ['grounding_exceeds_budget'], batches: [],
      claims: { claims: 5, excluded: 0, eligible: 5, supported: 1, unsupported: 2, notCompleted: 2, reasons: { grounding_exceeds_budget: 2 }, excludedPolicies: {},
        unfinished: [{ resultPath: ['records', 0, 'publisher'], reasons: ['grounding_exceeds_budget'] }, { resultPath: ['records', 0, 'items', 1, 'pack_qty'], reasons: ['grounding_exceeds_budget'] }] },
    } },
  }
  const sku = decided(['records', 0, 'items', 0, 'sku'], 'a_p1_s3_r3_c2')
  const renderReady = (review: Partial<Review> = {}, props: Partial<ComponentProps<typeof ResultsTab>> = {}) => render(
    <ResultsTab controller={controller(ready(attempt.resultPayload, attempt.evidenceLinks!), attempt, { available: true, decisions: [sku], ...review })}
      schemaReady sourceDocumentName="viega.pdf" onSelectEvidence={() => {}} {...props} />,
  )

  it('the drawer\'s Evidence section gives the claim counts, apart from the review, and claims no verification', () => {
    renderReady()
    openDetails()
    expect(drawer().getByText('Evidence · 5 claims')).toBeInTheDocument()
    expect(drawer().getByText('1 verifier-supported · 0 linked by rule')).toBeInTheDocument()
    expect(drawer().getByText('2 unsupported · 2 not completed · 0 excluded by policy')).toBeInTheDocument()
    expect(drawer().getByText('1 approved · 0 edited · 0 rejected · draft saved')).toBeInTheDocument()
    expect(screen.queryByText(/fully verified|proven|accuracy|confidence/i)).toBeNull()
  })

  it('Show reveals and focuses an unfinished value in a collapsed second Catalog record', () => {
    const laterPath = ['records', 1, 'publisher']
    const catalog: ExtractionAttempt = { ...attempt, strategy: 'CATALOG',
      resultPayload: { records: [{ publisher: 'First' }, { publisher: 'Later' }] },
      evidenceLinks: [{ resultPath: ['records', 0, 'publisher'], evidenceAnchorId: 'first' }],
      diagnostics: { ...attempt.diagnostics!, grounding: { ...attempt.diagnostics!.grounding!,
        groundedPaths: [['records', 0, 'publisher']], ungroundedPaths: [laterPath],
        claims: { claims: 2, excluded: 0, eligible: 2, supported: 1, unsupported: 0, notCompleted: 1,
          reasons: { grounding_exceeds_budget: 1 }, excludedPolicies: {},
          unfinished: [{ resultPath: laterPath, reasons: ['grounding_exceeds_budget'] }] } } } }
    render(<ResultsTab schemaReady sourceDocumentName="catalog.pdf"
      controller={controller(ready(catalog.resultPayload, catalog.evidenceLinks!), catalog,
        { available: true, decisions: [decided(['records', 0, 'publisher'], 'first')], isTouched: () => false })} />)
    expect(screen.queryByRole('button', { name: /Not completed publisher Later/ })).toBeNull()
    openDetails()
    fireEvent.click(drawer().getByText('Checks not completed (1)'))
    fireEvent.click(drawer().getByRole('button', { name: 'Show Item 2 · publisher' }))
    const target = screen.getByRole('button', { name: /Not completed publisher Later/ })
    expect(target).toHaveAttribute('aria-expanded', 'true')
    expect(target).toHaveFocus()
  })

  it('clears the changed-after-review note and accessible warning when the value is decided again', () => {
    const path = ['records', 0, 'publisher']
    const linked: ExtractionAttempt = { ...articleAttempt, resultPayload: { records: [{ publisher: 'Changed' }] },
      evidenceLinks: [{ resultPath: path, evidenceAnchorId: 'publisher' }] }
    render(<Reviewing attempt={linked} initial={[decided(path, 'publisher')]} spy={vi.fn()}
      review={{ changedAfterReview: new Set([resultPathKey(path)]) }} />)
    expect(screen.getByText('changed after you reviewed it')).toBeInTheDocument()
    fireEvent.click(rowOf('publisher'))
    fireEvent.click(screen.getByRole('button', { name: 'Approve and save review' }))
    expect(screen.queryByText('changed after you reviewed it')).toBeNull()
    expect(rowOf('publisher')).not.toHaveAccessibleName(/changed after you reviewed it/)
  })

  it('lists each check that never completed, with its reason, and Show selects that value', () => {
    renderReady()
    openDetails()
    fireEvent.click(drawer().getByText('Checks not completed (2)'))
    expect(drawer().getByText('items[2].pack_qty')).toBeInTheDocument()
    expect(drawer().getAllByText(/its evidence did not fit the model’s context/)).toHaveLength(2)
    fireEvent.click(drawer().getByRole('button', { name: 'Show items[2].pack_qty' }))
    expect(screen.queryByRole('dialog', { name: 'Run details' })).not.toBeInTheDocument()
    expect(rowOf('items › 2 › pack_qty')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Not completed', { selector: 'p' })).toBeInTheDocument()
    expect(screen.getByText('The check did not finish: its evidence did not fit the model’s context.')).toBeInTheDocument()
  })

  it('an unsupported value is checked and unsupported, not missing; the linked cell says where', () => {
    renderReady()
    expect(rowOf('items › 1 › pack_qty')).toHaveTextContent(/unsupported$/)
    expect(rowOf('items › 2 › sku')).toHaveTextContent(/unsupported$/)
    expect(rowOf('publisher')).toHaveTextContent(/not completed$/)
    fireEvent.click(rowOf('items › 1 › sku'))
    expect(screen.getByText('Verifier-supported · a table cell')).toBeInTheDocument()
  })

  it('a generic Catalog attempt whose record-level call failed without a path shows that record\'s values not completed', () => {
    const genericCatalog: ExtractionAttempt = {
      ...articleAttempt, strategy: 'CATALOG', resultPayload: { records: [{ place: 'First place', year: 1901 }] }, evidenceLinks: [],
      diagnostics: { ...articleAttempt.diagnostics!, catalog: null, grounding: {
        groundedPaths: [], ungroundedPaths: [['records', 0, 'place'], ['records', 0, 'year']], issueCodes: ['call_failed'], batches: [],
        claims: { claims: 2, excluded: 0, eligible: 2, supported: 0, unsupported: 0, notCompleted: 2, reasons: { call_failed_unattributed: 2 }, excludedPolicies: {},
          unfinished: [{ resultPath: ['records', 0, 'place'], reasons: ['call_failed_unattributed'] }, { resultPath: ['records', 0, 'year'], reasons: ['call_failed_unattributed'] }] },
      } },
    }
    render(<ResultsTab controller={controller(ready(genericCatalog.resultPayload), genericCatalog, { available: true })} schemaReady sourceDocumentName="catalog.pdf" />)
    expect(rowOf('place')).toHaveTextContent(/^Not completed.*First place.*not completed$/)
    expect(rowOf('year')).toHaveTextContent(/not completed$/)
    fireEvent.click(rowOf('place'))
    expect(screen.getByText(/^The check did not finish: a call for this record failed and could not be attributed to a value, so its checks may not have finished/)).toBeInTheDocument()
    expect(screen.queryByText(/^Unsupported/)).toBeNull()
  })

  it('a saved review with unfinished checks says what was not part of it', () => {
    render(<ResultsTab controller={controller(ready(attempt.resultPayload, attempt.evidenceLinks!), {
      ...attempt, reviewedAt: '2026-10-02T07:27:36.243Z', reviewDecisions: [{ ...sku, createdAt: '2026-10-02T07:27:36.243Z' }],
    }, { available: true, reviewedExtractionId: attempt.extractionId })} schemaReady sourceDocumentName="viega.pdf" />)
    expect(screen.getByText('Review saved', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByText('Read-only. 4 values without a link were not part of the review.')).toBeInTheDocument()
  })

  it('hands the export one Evidence row per claim, extracted and reviewed values apart, and the Extraction identity', () => {
    const exportSchema: SchemaDefinition = { recordDescription: 'A price list.', schemaNodes: [
      { id: 'publisher', name: 'publisher', type: 'string', valueSource: 'document' },
      { id: 'items', name: 'items', type: 'array', children: [{ id: 'sku', name: 'sku', type: 'string' }, { id: 'pack_qty', name: 'pack_qty', type: 'integer' }] },
    ] }
    renderReady({ decisions: [{ ...sku, action: 'EDITED', reviewedValue: '77317-B' }] }, { exportSchema, evidencePages: new Map([['a_p1_s3_r3_c2', 4]]) })
    menu('Export…')
    expect(within(screen.getByRole('dialog', { name: 'Export options' })).getByRole('note')).toHaveTextContent('CSV holds the values only. The Excel workbook adds an Extraction sheet (identities, versions, completion) and an Evidence sheet (extracted and reviewed values, verifier outcomes, evidence anchors).')
    fireEvent.click(screen.getByRole('button', { name: 'Excel' }))
    const { provenance } = vi.mocked(exportExtractionResult).mock.calls[0]![1]
    expect(provenance!.claims).toHaveLength(5)
    expect(provenance!.claims).toEqual(expect.arrayContaining([
      { path: ['items', 0, 'sku'], extracted: '77317', decision: 'EDITED', reviewed: '77317-B', outcome: 'supported', linkedBy: 'verifier', reasons: [],
        anchorId: 'a_p1_s3_r3_c2', page: 4, precision: 'cell', verbatim: true, lexicalHits: 1 },
      { path: ['publisher'], extracted: 'Viega', outcome: 'not_completed', reasons: ['grounding_exceeds_budget'] },
      { path: ['items', 1, 'pack_qty'], extracted: 5, outcome: 'not_completed', reasons: ['grounding_exceeds_budget'] },
      { path: ['items', 0, 'pack_qty'], extracted: 10, outcome: 'unsupported', reasons: [] },
      { path: ['items', 1, 'sku'], extracted: '77318', outcome: 'unsupported', reasons: [] },
    ]))
    const identity = new Map(provenance!.identity)
    expect(identity.get('Extraction ID')).toBe(attempt.extractionId)
    expect(identity.get('Source Document')).toBe('viega.pdf')
    expect(identity.get('Reviewed at')).toBe('Not finalized')
    expect(identity.get('Decisions')).toBe(1)
    expect(identity.get('Extraction complete')).toBe('Not shown complete: record recall unmeasured')
    expect([identity.get('Claims'), identity.get('Verifier-supported'), identity.get('Unsupported'), identity.get('Not completed'), identity.get('Excluded by policy')]).toEqual([5, 1, 2, 2, 0])
    expect(identity.get('Document-level fields (not verified)')).toBe('publisher')
    expect(identity.get('Exported at')).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('before the review is saved, the export reports only the decisions the researcher made, never a seeded approval', () => {
    renderReady({ isTouched: () => false }, { exportSchema: { recordDescription: 'A list.', schemaNodes: [{ id: 'publisher', name: 'publisher', type: 'string' }] } })
    exportAs('Excel')
    const { provenance } = vi.mocked(exportExtractionResult).mock.calls[0]![1]
    expect(new Map(provenance!.identity).get('Decisions')).toBe(0)
    const claim = provenance!.claims.find(({ path }) => JSON.stringify(path) === JSON.stringify(['items', 0, 'sku']))
    expect(claim).toMatchObject({ outcome: 'supported' })
    expect(claim).not.toHaveProperty('decision')
  })

  it('a complete Extraction still names record recall unmeasured in the Extraction sheet', () => {
    const complete: ExtractionAttempt = { ...attempt, complete: true }
    render(<ResultsTab controller={controller(ready(complete.resultPayload, complete.evidenceLinks!), complete)} schemaReady sourceDocumentName="viega.pdf"
      exportSchema={{ recordDescription: 'A list.', schemaNodes: [{ id: 'publisher', name: 'publisher', type: 'string' }] }} />)
    exportAs('Excel')
    const { provenance } = vi.mocked(exportExtractionResult).mock.calls[0]![1]
    expect(new Map(provenance!.identity).get('Extraction complete')).toBe('Yes (record recall unmeasured)')
  })

  it('with several records, names each claim\'s record apart from its field path', () => {
    const records: ExtractionAttempt = {
      ...articleAttempt,
      resultPayload: { records: [{ place: 'Oslo' }, { place: 'Bergen' }] },
      evidenceLinks: [{ resultPath: ['records', 1, 'place'], evidenceAnchorId: 'a_p2_s1' }],
      diagnostics: { ...articleAttempt.diagnostics!, grounding: {
        groundedPaths: [['records', 1, 'place']], ungroundedPaths: [['records', 0, 'place']], issueCodes: [], batches: [],
        claims: { claims: 2, excluded: 0, eligible: 2, supported: 1, unsupported: 1, notCompleted: 0, reasons: {}, excludedPolicies: {}, unfinished: [] },
      } },
    }
    render(<ResultsTab controller={controller(ready(records.resultPayload, records.evidenceLinks!), records)} schemaReady sourceDocumentName="places.pdf"
      exportSchema={{ recordDescription: 'A place.', schemaNodes: [{ id: 'place', name: 'place', type: 'string' }] }} />)
    exportAs('CSV')
    const { provenance } = vi.mocked(exportExtractionResult).mock.calls[0]![1]
    expect(provenance!.claims).toEqual([
      { record: 0, path: ['place'], extracted: 'Oslo', outcome: 'unsupported', reasons: [] },
      { record: 1, path: ['place'], extracted: 'Bergen', outcome: 'supported', linkedBy: 'verifier', reasons: [], anchorId: 'a_p2_s1' },
    ])
    expect(new Map(provenance!.identity).get('Document-level fields (not verified)')).toBe('None')
  })

  describe('a value a rule linked, not the verifier', () => {
    const ruled: ExtractionAttempt = {
      ...articleAttempt,
      resultPayload: { records: [{ title: 'Price list', publisher: 'Viega' }] },
      evidenceLinks: [
        { resultPath: ['records', 0, 'title'], evidenceAnchorId: 'a_p1_s1', precision: 'segment' },
        { resultPath: ['records', 0, 'publisher'], evidenceAnchorId: 'a_p1_s2', precision: 'segment', linkedBy: 'lexical' },
      ],
    }
    const accounted: ExtractionAttempt = { ...ruled, diagnostics: { ...ruled.diagnostics!, grounding: {
      groundedPaths: [['records', 0, 'title'], ['records', 0, 'publisher']], ungroundedPaths: [], issueCodes: [], batches: [],
      claims: { claims: 2, excluded: 0, eligible: 2, supported: 2, unsupported: 0, notCompleted: 0, reasons: {}, excludedPolicies: {}, unfinished: [] },
    } } }
    const renderRuled = (shown: ExtractionAttempt) => render(
      <ResultsTab controller={controller(ready(shown.resultPayload, shown.evidenceLinks!), shown, {
        decisions: shown.evidenceLinks!.map((link) => decided(link.resultPath, link.evidenceAnchorId)),
      })} schemaReady sourceDocumentName="ruled.pdf"
        exportSchema={{ recordDescription: 'A list.', schemaNodes: [{ id: 'title', name: 'title', type: 'string' }, { id: 'publisher', name: 'publisher', type: 'string' }] }} />,
    )

    it.each([
      { accounting: 'with', shown: accounted, note: 'Linked by rule: a key or structure rule linked it, and no verifier checked it. A link is never a judgement that the value is right; that is your decision.' },
      { accounting: 'without', shown: ruled, note: 'This run kept no claim accounting.' },
    ])('counts verifier links and rule links apart, $accounting a claim accounting', ({ shown, note }) => {
      renderRuled(shown)
      openDetails()
      expect(drawer().getByText('1 verifier-supported · 1 linked by rule')).toBeInTheDocument()
      expect(drawer().getByText(note)).toBeInTheDocument()
    })

    it('never calls the rule-linked value verifier-supported', () => {
      renderRuled(accounted)
      expect(rowOf('publisher')).toHaveTextContent(/linked · rule$/)
      fireEvent.click(rowOf('publisher'))
      expect(screen.getByText('Linked by rule; no verifier checked it')).toBeInTheDocument()
      expect(screen.queryByText(/Verifier-supported/)).not.toBeInTheDocument()
      fireEvent.click(rowOf('title'))
      expect(screen.getByText('Verifier-supported')).toBeInTheDocument()
    })

    it('hands the export the rule-linked claim as rule-linked', () => {
      renderRuled(accounted)
      exportAs('Excel')
      const { provenance } = vi.mocked(exportExtractionResult).mock.calls[0]![1]
      expect(provenance!.claims.map(({ path, linkedBy }) => [path, linkedBy])).toEqual(expect.arrayContaining([[['title'], 'verifier'], [['publisher'], 'rule']]))
      const identity = new Map(provenance!.identity)
      expect([identity.get('Verifier-supported'), identity.get('Linked by rule')]).toEqual([1, 1])
    })
  })
})

describe('ResultsTab one by one (§4)', () => {
  const fields = ['place', 'year', 'site'] as const
  const links: EvidenceLink[] = fields.map((field) => ({ resultPath: ['records', 0, field], evidenceAnchorId: `anchor-${field}`,
    ...(field === 'site' ? { verbatim: true, lexicalHits: 2 } : {}) }))
  const three = withAttempt({ records: [{ place: 'Oslo', year: '1900', site: 'Grav 8' }] }, links, { strategy: 'CATALOG' })
  const initial = fields.map((field) => decided(['records', 0, field], `anchor-${field}`))
  const schema: SchemaDefinition = { recordDescription: 'Graves.', schemaNodes: fields.map((field) => ({ id: field, name: field, type: 'string' as const })) }
  const heading = () => screen.getByRole('heading', { level: 2 })
  const key = (name: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(document.activeElement ?? document.body, { key: name, ...init })
  function enter() {
    const spy = vi.fn()
    render(<Reviewing attempt={three} initial={initial} spy={spy} pinnedSchema={schema} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    return spy
  }

  it('starts at the doubtful link, shows its record queue and position, and focuses the value', () => {
    enter()
    expect(heading()).toHaveTextContent('Grav 8')
    expect(document.activeElement).toBe(heading())
    expect(screen.getByRole('list', { name: 'Record 1, values in review order' }).querySelectorAll('li')).toHaveLength(3)
    expect(screen.getByRole('button', { name: 'site, to check, doubtful link' })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByText('Record 1 of 1 · 1 of 3 in this record')).toBeInTheDocument()
    expect(screen.getByText(/Doubtful link\./).closest('div')).toHaveTextContent('Check that this is the right passage.')
    expect(screen.queryByRole('group', { name: 'Show values' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Leave one-by-one review, back to the list' })).toBeInTheDocument()
  })

  it('A approves and moves on, saying so; J skips without deciding; K steps back; Z undoes', () => {
    const spy = enter()
    key('a')
    expect(spy).toHaveBeenLastCalledWith(['records', 0, 'site'], 'APPROVED', null, null, true)
    expect(heading()).toHaveTextContent('Oslo')
    expect(document.activeElement).toBe(heading())
    expect(live()).toHaveTextContent('Approved site. 2 to check. Next: place, Oslo.')
    key('j')
    expect(heading()).toHaveTextContent('1900')
    expect(spy).toHaveBeenCalledTimes(1)
    key('k')
    expect(heading()).toHaveTextContent('Oslo')
    key('k')
    expect(heading()).toHaveTextContent('Grav 8')
    expect(screen.getByText('Approved', { selector: 'b' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next to check/ })).toBeInTheDocument()
    key('z')
    expect(spy).toHaveBeenLastCalledWith(['records', 0, 'site'], 'APPROVED', null, null, false)
    expect(heading()).toHaveTextContent('Grav 8')
  })

  it('ignores keys on repeat, with a modifier and while typing; E edits and Escape cancels the edit first', () => {
    const spy = enter()
    key('a', { repeat: true })
    key('a', { ctrlKey: true })
    expect(spy).not.toHaveBeenCalled()
    key('e')
    const input = screen.getByLabelText('Reviewed value')
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(input, { key: 'a' })
    expect(spy).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByLabelText('Reviewed value')).toBeNull()
    expect(screen.getByRole('button', { name: 'Leave one-by-one review, back to the list' })).toBeInTheDocument()
  })

  it('the document follows the current value once per value, never again on a re-render', () => {
    const first = vi.fn()
    const { rerender } = render(<Reviewing attempt={three} initial={initial} spy={vi.fn()} pinnedSchema={schema} onSelectEvidence={first} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    expect(first.mock.calls).toEqual([['anchor-site']])
    const second = vi.fn()
    rerender(<Reviewing attempt={three} initial={initial} spy={vi.fn()} pinnedSchema={schema} onSelectEvidence={second} />)
    expect(second).not.toHaveBeenCalled()
    key('j')
    expect(second.mock.calls).toEqual([['anchor-place']])
  })

  it('Escape leaves to the list with the current value selected and focused', () => {
    enter()
    key('Escape')
    expect(screen.getByRole('group', { name: 'Show values' })).toBeInTheDocument()
    expect(rowOf('site')).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(rowOf('site'))
  })

  it('leaving after advancing into a collapsed record reveals and focuses the current row', () => {
    const result = { records: [{ place: 'Oslo' }, { place: 'Bergen' }] }
    const evidence = [0, 1].map((i) => ({ resultPath: ['records', i, 'place'], evidenceAnchorId: `anchor-${i}` }))
    render(<Reviewing attempt={withAttempt(result, evidence, { strategy: 'CATALOG' })}
      initial={evidence.map((link) => decided(link.resultPath, link.evidenceAnchorId))} spy={vi.fn()} pinnedSchema={placeSchema} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    key('j')
    expect(heading()).toHaveTextContent('Bergen')
    key('Escape')
    const current = screen.getByRole('button', { name: /^To check place Bergen/ })
    expect(current).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(current)
  })

  it('Article shows a flat queue and position without a Catalog record level', () => {
    render(<Reviewing attempt={{ ...three, strategy: 'ARTICLE' }} initial={initial} spy={vi.fn()} pinnedSchema={schema} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    expect(screen.getByRole('list', { name: 'Values in review order' })).toBeInTheDocument()
    expect(screen.getByText('1 of 3')).toBeInTheDocument()
    expect(screen.queryByText(/Record 1/)).toBeNull()
  })

  it('Article end cards keep the flat document scope', () => {
    const evidence = [{ resultPath: ['records', 0, 'place'], evidenceAnchorId: 'a' }]
    render(<Reviewing attempt={withAttempt({ records: [{ place: 'Oslo' }] }, evidence)}
      initial={[decided(evidence[0]!.resultPath, 'a')]} spy={vi.fn()} pinnedSchema={placeSchema} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    key('a')
    expect(heading()).toHaveTextContent('Document is checked')
    expect(screen.queryByText(/records?\b/i)).toBeNull()
  })

  it('the card retains the changed-after-review warning until a new decision is made', () => {
    render(<Reviewing attempt={three} initial={initial} spy={vi.fn()} pinnedSchema={schema}
      review={{ changedAfterReview: new Set([resultPathKey(['records', 0, 'site'])]) }} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    expect(screen.getByText('changed after you reviewed it')).toBeInTheDocument()
    key('a')
    key('k')
    expect(screen.queryByText('changed after you reviewed it')).toBeNull()
  })

  it.each(['input', 'cell'] as const)('the card states %s evidence precision', (precision) => {
    const evidence = links.map((link) => ({ ...link, precision }))
    render(<Reviewing attempt={withAttempt(three.resultPayload, evidence, { strategy: 'CATALOG' })}
      initial={initial} spy={vi.fn()} pinnedSchema={schema} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    expect(screen.getByText(precision === 'input' ? /located to the whole page only/ : /a table cell/)).toBeInTheDocument()
  })

  it('Run details owns keyboard focus and suspends decisions until it closes', () => {
    const spy = enter()
    openDetails()
    fireEvent.keyDown(screen.getByRole('button', { name: 'Close run details' }), { key: 'a' })
    expect(spy).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Close run details' }))
    key('a')
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('keeps the leave focus request when Escape arrives during the saved render commit', () => {
    function SavedBoundary({ saved }: { saved: boolean }) {
      useLayoutEffect(() => {
        if (saved) screen.getByRole('heading', { level: 2 }).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      }, [saved])
      const attempt = { ...three, reviewedAt: saved ? '2026-10-04T00:00:00Z' : null,
        reviewDecisions: saved ? initial.map((decision) => ({ ...decision, createdAt: '2026-10-04T00:00:00Z' })) : [] }
      return <Reviewing attempt={attempt} initial={initial} spy={vi.fn()} pinnedSchema={schema} />
    }
    const { rerender } = render(<SavedBoundary saved={false} />)
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    key('a')
    key('a')
    key('a')
    rerender(<SavedBoundary saved />)
    expect(rowOf('year')).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(rowOf('year'))
  })

  it('keeps heading focus when entry arrives before passive effects from the list', () => {
    function EnterBoundary() {
      useLayoutEffect(() => { screen.getByRole('button', { name: /One by one/ }).click() }, [])
      return <Reviewing attempt={three} initial={initial} spy={vi.fn()} pinnedSchema={schema} />
    }
    render(<EnterBoundary />)
    expect(document.activeElement).toBe(heading())
  })

  it('when the record runs out, says so and offers the list', () => {
    enter()
    key('a')
    key('a')
    key('a')
    expect(heading()).toHaveTextContent(/is checked$/)
    expect(screen.getByText('0 values are left to check in 0 more records.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back to list' }))
    expect(screen.getByRole('group', { name: 'Show values' })).toBeInTheDocument()
    expect(rowOf('year')).toHaveAttribute('aria-expanded', 'true')
    expect(document.activeElement).toBe(rowOf('year'))
  })

  it('"Review from here" enters at that value; One by one is unavailable with nothing to check', () => {
    render(<Reviewing attempt={three} initial={initial} spy={vi.fn()} pinnedSchema={schema} />)
    fireEvent.click(rowOf('year'))
    fireEvent.click(screen.getByRole('button', { name: /Review from here/ }))
    expect(heading()).toHaveTextContent('1900')
    cleanup()
    render(<Reviewing attempt={three} initial={initial} spy={vi.fn()} pinnedSchema={schema} review={{ isTouched: () => true }} />)
    expect(screen.getByRole('button', { name: /One by one/ })).toHaveAttribute('title', 'Nothing left to check here')
  })
})

describe('ResultsTab one by one while the run reads (§4.5)', () => {
  const record = (index: number, state: 'finished' | 'reading'): PartialResult['records'][number] => ({
    index, label: `Grav ${index + 8}`, page: 1, state,
    record: state === 'finished' ? { place: `Place ${index}` } : null,
    values: state === 'finished' ? { '["place"]': { value: `Place ${index}`, state: 'grounded' } } : {},
    evidenceLinks: state === 'finished' ? [{ resultPath: ['records', index, 'place'], evidenceAnchorId: `anchor-${index}` }] : [],
  })
  const partial = (states: Array<'finished' | 'reading'>): PartialResult => ({
    strategy: 'CATALOG', startedAtPage: 1, discovered: states.length, finished: states.filter((each) => each === 'finished').length,
    records: states.map((state, index) => record(index, state)), document: null,
  })
  const runningAttempt = { ...articleAttempt, strategy: 'CATALOG' as const, executionStatus: 'RUNNING' as const, outcome: null, resultPayload: null,
    evidenceLinks: null, reviewable: false, complete: null }
  const tab = (shown: PartialResult) => <ResultsTab schemaReady sourceDocumentName="run.pdf" pinnedSchema={placeSchema}
    controller={controller({ status: 'running', step: 'extraction', partial: shown }, runningAttempt, {
      draftAvailable: true, decisions: [decided(['records', 0, 'place'], 'anchor-0'), decided(['records', 1, 'place'], 'anchor-1')],
      isTouched: () => false,
    })} />

  it('once what is read is checked, each record read says its values can be reviewed now', () => {
    const { rerender } = render(tab(partial(['finished', 'reading', 'reading'])))
    fireEvent.click(screen.getByRole('button', { name: /One by one/ }))
    fireEvent.click(screen.getByRole('button', { name: /Approve and next/ }))
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Grav 8 is checked')
    expect(screen.getByText(/still being read, and their values join this queue as each one finishes\.$/)).toBeInTheDocument()
    rerender(tab(partial(['finished', 'finished', 'reading'])))
    expect(live()).toHaveTextContent('Grav 9 read: its values can be reviewed now.')
  })
})
