// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import type { SchemaNode } from 'extraction/schema'
import type { BatchExtraction } from '../../shared/batchExtraction.contract'
import type { GridValue } from '../batchReviewGrid'
import { durableRequest, readDurable } from '../durableExtractionApi'
import BatchReviewGrid from './BatchReviewGrid'

vi.mock('../durableExtractionApi', () => ({ durableRequest: vi.fn(), readDurable: vi.fn(), durableRoot: (id: string) => `/api/extractions/${id}/durable` }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const nodes = [{ id: 'title', name: 'title', type: 'string' }, { id: 'year', name: 'year', type: 'string' }] as SchemaNode[]
const value = (id: string, field: string, record: number, extra: Record<string, unknown> = {}) => ({
  id, recordId: `record-${record}`, fieldId: field, path: ['records', record, field], selectionId: 'selection', schemaRevisionId: 'schema',
  node: nodes.find((node) => node.id === field), modelValue: `${field} ${record}`, evidence: [], links: [], grounding: 'ungrounded',
  processing: 'saved', lineage: [], correction: null, historicalCorrection: null, correctionCompatibility: 'compatible', ...extra,
}) as unknown as GridValue
const page = (values: GridValue[], finalization: unknown = null) => ({
  extractionId: 'first', snapshotVersion: 4, feedbackVersion: 9, finalization, status: 'COMPLETED', values, total: values.length, next: null,
  reviewCounts: { required: values.length, toCheck: values.filter((each) => !each.correction).length, approved: 0, edited: 0, rejected: 0 },
  coverage: null, schemaRevisionId: 'schema', schemaRevisions: [],
}) as unknown as DurablePage
const approved = { revision: 1, decision: { action: 'APPROVED', included: true, evidence: [] } }

const member = (extractionId: string, sourceDocumentId: string, extra: Partial<BatchExtraction['members'][number]> = {}) => ({
  extractionId, sourceDocumentId, sourceRepresentationRevisionId: '00000000-0000-4000-8000-000000000009',
  executionStatus: 'COMPLETED' as const, completed: true, reviewable: true, currentReview: null, ...extra,
})
const batch = {
  batchExtractionId: 'batch', projectContextId: 'project', schemaRevisionId: 'schema', extractionSchemaId: 'family',
  extractionSchemaName: 'Sites', schemaRevisionNumber: 1, strategy: 'CATALOG', executionStatus: 'RUNNING', createdAt: '2026-11-01T00:00:00.000Z',
  members: [member('first', 'doc-a'), member('second', 'doc-b', { executionStatus: 'RUNNING', completed: false })],
} as BatchExtraction

function renderGrid(onOpenMember = vi.fn(), onFinalized = vi.fn()) {
  render(<BatchReviewGrid batch={batch} schemaNodes={nodes} documentName={(id) => id === 'doc-a' ? 'a.pdf' : 'b.pdf'}
    onBack={vi.fn()} onOpenMember={onOpenMember} onFinalized={onFinalized} />)
}

it('shows a completed member one row per record and a running one outside the grid', async () => {
  vi.mocked(readDurable).mockResolvedValue({ state: {} as never, page: page([value('t0', 'title', 0), value('y0', 'year', 0), value('t1', 'title', 1)]) })
  const onOpenMember = vi.fn()
  renderGrid(onOpenMember)
  expect(await screen.findByRole('button', { name: 'a.pdf · Record 1' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'a.pdf · Record 2' })).toBeVisible()
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Documents', 'title', 'year'])
  expect(screen.getByText(/Still running: shown here once it stops/)).toBeVisible()
  // Only the completed member is read: a running one's values still change.
  expect(readDurable).toHaveBeenCalledTimes(1)
  expect(vi.mocked(readDurable).mock.calls[0]![0]).toBe('first')
  fireEvent.click(screen.getByRole('button', { name: 'b.pdf' }))
  expect(onOpenMember).toHaveBeenCalledWith('doc-b', 'second')
})

it('shows a member stopped or failed partway with its saved values, as the document reviews it', async () => {
  vi.mocked(readDurable).mockResolvedValue({ state: {} as never, page: page([value('t0', 'title', 0)]) })
  const settled = { ...batch, members: [member('first', 'doc-a', { executionStatus: 'STOPPED', completed: false }),
    member('second', 'doc-b', { executionStatus: 'FAILED', completed: false })] } as BatchExtraction
  render(<BatchReviewGrid batch={settled} schemaNodes={nodes} documentName={(id) => id === 'doc-a' ? 'a.pdf' : 'b.pdf'}
    onBack={vi.fn()} onOpenMember={vi.fn()} onFinalized={vi.fn()} />)
  // Each is read and shown with its values: one record each.
  await waitFor(() => expect(screen.getAllByText('title 0')).toHaveLength(2))
  expect(readDurable).toHaveBeenCalledTimes(2)
  expect(screen.queryByText(/Still running/)).not.toBeInTheDocument()
  expect(screen.queryByText(/No saved values to review/)).not.toBeInTheDocument()
})

it('says a member whose document was run again since, and leaves it out of the review', async () => {
  vi.mocked(readDurable).mockResolvedValue({ state: {} as never, page: page([value('t0', 'title', 0)]) })
  const both = { ...batch, members: [member('first', 'doc-a'), member('second', 'doc-b')] } as BatchExtraction
  const onOpenMember = vi.fn()
  // doc-b's newest run is another Extraction than this member.
  render(<BatchReviewGrid batch={both} schemaNodes={nodes} documentName={(id) => id === 'doc-a' ? 'a.pdf' : 'b.pdf'}
    onBack={vi.fn()} onOpenMember={onOpenMember} onFinalized={vi.fn()} newest={new Set(['first', 'later-b'])} />)
  expect(await screen.findByText('This document has a newer run. Open it to review that one.')).toBeVisible()
  await waitFor(() => expect(screen.getAllByText('title 0')).toHaveLength(1))
  // Only the member still shown by its document is read and counted.
  expect(readDurable).toHaveBeenCalledExactlyOnceWith('first', expect.anything())
  expect(screen.getByRole('button', { name: /Needs review \(1\)/ })).toBeInTheDocument()
  // Its name opens the document on its newest run.
  fireEvent.click(screen.getByRole('button', { name: 'b.pdf' }))
  expect(onOpenMember).toHaveBeenCalledWith('doc-b', undefined)
})

it('saves one cell’s decision at once and reads the member again', async () => {
  vi.mocked(readDurable).mockResolvedValueOnce({ state: {} as never, page: page([value('t0', 'title', 0)]) })
    .mockResolvedValueOnce({ state: {} as never, page: page([value('t0', 'title', 0, { correction: approved })]) })
  vi.mocked(durableRequest).mockResolvedValue({})
  renderGrid()
  fireEvent.click(await screen.findByRole('button', { name: 'To check title title 0' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Decision for title' })).getByRole('button', { name: 'Approve' }))
  await waitFor(() => expect(durableRequest).toHaveBeenCalledWith('/api/extractions/first/durable/values/t0',
    { expectedRevision: 0, snapshotVersion: 4, action: 'APPROVED', value: 'title 0', included: true, evidence: [] }))
  expect(await screen.findByRole('button', { name: 'Approved title title 0' })).toBeVisible()
  expect(readDurable).toHaveBeenCalledTimes(2)
})

it('approves only values still To check with one reading, then saves the member’s review by name', async () => {
  const disagreement = [{ path: [], alternatives: [{ value: 'a', segments: ['s1'] }, { value: 'b', segments: ['s2'] }] }]
  const before = [value('t0', 'title', 0), value('y0', 'year', 0, { disagreement }), value('t1', 'title', 1, { correction: approved })]
  vi.mocked(readDurable).mockResolvedValueOnce({ state: {} as never, page: page(before) })
    .mockResolvedValueOnce({ state: {} as never, page: page(before.map((each) => ({ ...each, correction: approved }) as GridValue)) })
  vi.mocked(durableRequest).mockResolvedValue({})
  const onFinalized = vi.fn()
  renderGrid(vi.fn(), onFinalized)
  fireEvent.click(await screen.findByRole('button', { name: 'Approve remaining (1)' }))
  await waitFor(() => expect(readDurable).toHaveBeenCalledTimes(2))
  expect(durableRequest).toHaveBeenCalledTimes(1)
  expect(vi.mocked(durableRequest).mock.calls[0]![0]).toBe('/api/extractions/first/durable/values/t0')

  const save = await screen.findByRole('button', { name: 'Save review' })
  await waitFor(() => expect(save).toBeEnabled())
  vi.mocked(readDurable).mockResolvedValueOnce({ state: {} as never, page: page(before.map((each) => ({ ...each, correction: approved }) as GridValue), { id: 'f' }) })
  fireEvent.click(save)
  await waitFor(() => expect(durableRequest).toHaveBeenLastCalledWith('/api/extractions/first/durable/finalize', { snapshotVersion: 4, feedbackVersion: 9 }))
  await waitFor(() => expect(onFinalized).toHaveBeenCalledOnce())
  expect(await screen.findByText('Reviewed')).toBeVisible()
})

it('keeps a refused decision’s reason on its row', async () => {
  vi.mocked(readDurable).mockResolvedValue({ state: {} as never, page: page([value('t0', 'title', 0)]) })
  vi.mocked(durableRequest).mockRejectedValue(new Error('Another view saved a newer correction.'))
  renderGrid()
  fireEvent.click(await screen.findByRole('button', { name: 'To check title title 0' }))
  fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Another view saved a newer correction.')
})
