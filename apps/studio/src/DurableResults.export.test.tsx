// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DurableResults } from './DurableResults'
import { durableRequest, readDurable, readDurableHistory } from './durableExtractionApi'
import { downloadDurableExport } from './durableExport'
import type { ExtractionAttempt } from '../shared/extraction.contract'

vi.mock('./durableExtractionApi', () => ({
  durableRequest: vi.fn(), readDurable: vi.fn(), readDurableHistory: vi.fn(),
  readValues: vi.fn(), durableRoot: (id: string) => `/api/extractions/${id}/durable`,
}))
vi.mock('./durableExport', () => ({ downloadDurableExport: vi.fn() }))
afterEach(() => { cleanup(); vi.resetAllMocks() })

const title = { id: 'title', recordId: 'record', fieldId: 'title', path: ['records', 0, 'title'], selectionId: 'selection', schemaRevisionId: 'schema',
  node: { id: 'title', name: 'title', type: 'string' }, modelValue: 'Grave 8', evidence: [], links: [], grounding: 'ungrounded', processing: 'saved', lineage: [], correction: null, historicalCorrection: null }
const finds = { ...title, id: 'finds', fieldId: 'finds', path: ['records', 0, 'finds'], node: { id: 'finds', name: 'finds', type: 'array', children: [{ id: 'name', name: 'name', type: 'string' }] }, modelValue: [{ name: 'Nadel' }] }

function renderResults(values: unknown[] = [title, finds]) {
  const page = { snapshotVersion: 1, feedbackVersion: 0, status: 'PAUSED', finalization: null,
    reviewCounts: { required: values.length, toCheck: values.length, approved: 0, edited: 0, rejected: 0 },
    values, total: values.length, next: null, coverage: {} }
  const state = { extractionId: 'extraction', projectId: 'project', status: 'PAUSED', strategy: 'CATALOG',
    controlVersion: 1, snapshotVersion: 1, feedbackVersion: 0,
    selection: { id: 'selection', ordinal: 1, schemaTree: { schemaNodes: [title.node, finds.node] }, resolved: {} },
    pendingSelection: null, counts: { saved: values.length, inFlight: 0 }, records: null, reading: [] }
  vi.mocked(readDurable).mockResolvedValue({ state, page } as never)
  vi.mocked(durableRequest).mockResolvedValue([])
  return render(<DurableResults attempt={{ extractionId: 'extraction', strategy: 'CATALOG' } as ExtractionAttempt}
    document={null} currentSchema={null} sourceDocumentName="Beretning.pdf" onEvidence={() => {}} />)
}

async function openOptions() {
  fireEvent.click(await screen.findByRole('button', { name: 'More result actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }))
  return screen.getByRole('dialog', { name: 'Export options' })
}

it.each(['a', 'r', 'e', 'j', 'k', 'z'])('the export dialog owns %s instead of changing the open review', async key => {
  renderResults()
  fireEvent.click(await screen.findByRole('button', { name: 'One by one' }))
  await openOptions()
  const excel = screen.getByRole('button', { name: 'Excel' })
  excel.focus()
  fireEvent.keyDown(excel, { key })
  expect(durableRequest).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Export options' })).toBeVisible()
  fireEvent.keyDown(excel, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Export options' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Leave one-by-one review, back to the list' })).toBeVisible()
})

it('Escape closes the export dialog while preserving an unsaved review edit', async () => {
  renderResults([title])
  fireEvent.click(await screen.findByRole('button', { name: 'One by one' }))
  fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Reviewed value' }), { target: { value: 'Keep this draft' } })
  await openOptions()
  const excel = screen.getByRole('button', { name: 'Excel' })
  excel.focus()
  fireEvent.keyDown(excel, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Export options' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Reviewed value' })).toHaveValue('Keep this draft')
  expect(durableRequest).not.toHaveBeenCalled()
})

it.each([['Excel', 'xlsx'], ['CSV', 'csv']] as const)('builds the %s export from the shown results with the chosen rows, never reading history', async (label, format) => {
  let finishDownload!: () => void
  vi.mocked(downloadDurableExport).mockImplementation(() => new Promise(resolve => { finishDownload = resolve }))
  renderResults()
  await openOptions()
  expect(screen.getByRole('combobox', { name: 'Rows represent' })).toHaveDisplayValue('Root result')
  fireEvent.change(screen.getByRole('combobox', { name: 'Rows represent' }), { target: { value: 'finds' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Other repeated fields' }), { target: { value: 'omit' } })
  fireEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.queryByRole('dialog', { name: 'Export options' })).not.toBeInTheDocument()
  await waitFor(() => expect(downloadDurableExport).toHaveBeenCalledOnce())
  expect(downloadDurableExport).toHaveBeenCalledWith(
    expect.objectContaining({ page: expect.objectContaining({ snapshotVersion: 1, values: [title, finds] }), state: expect.objectContaining({ extractionId: 'extraction' }) }),
    format, { rowsRepresent: 'finds', otherRepeatedFields: 'omit' }, 'Beretning.pdf', expect.any(AbortSignal))
  expect(vi.mocked(downloadDurableExport).mock.calls[0]![0]).not.toHaveProperty('history')
  expect(readDurableHistory).not.toHaveBeenCalled()
  expect(screen.getByRole('status', { name: 'Export progress' })).toHaveTextContent(`Preparing ${label} export of results 1…`)
  fireEvent.click(screen.getByRole('button', { name: 'More result actions' }))
  expect(screen.getByRole('menuitem', { name: 'Export…' })).toBeDisabled()
  await act(async () => finishDownload())
  expect(screen.getByRole('status', { name: 'Export progress' })).toHaveTextContent('Download started')
  expect(screen.getByRole('menuitem', { name: 'Export…' })).toBeEnabled()
  expect(readDurableHistory).not.toHaveBeenCalled()
})

it('keeps the chosen options for the next export and starts one download per choice', async () => {
  vi.mocked(downloadDurableExport).mockResolvedValue(undefined)
  renderResults()
  await openOptions()
  fireEvent.change(screen.getByRole('combobox', { name: 'Rows represent' }), { target: { value: 'finds' } })
  fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
  await waitFor(() => expect(screen.getByRole('status', { name: 'Export progress' })).toHaveTextContent('Download started'))
  await openOptions()
  expect(screen.getByRole('combobox', { name: 'Rows represent' })).toHaveDisplayValue('finds[]')
  fireEvent.click(screen.getByRole('button', { name: 'Excel' }))
  await waitFor(() => expect(downloadDurableExport).toHaveBeenCalledTimes(2))
  expect(vi.mocked(downloadDurableExport).mock.calls.map(call => [call[1], call[2].rowsRepresent])).toEqual([['csv', 'finds'], ['xlsx', 'finds']])
})

it('keeps an interrupted export visible across result reads and lets the researcher retry', async () => {
  vi.mocked(downloadDurableExport).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(undefined)
  renderResults()
  await openOptions()
  fireEvent.click(screen.getByRole('button', { name: 'Excel' }))
  expect(await screen.findByRole('alert')).toHaveTextContent(/export.*connection.*try again/i)
  const calls = vi.mocked(readDurable).mock.calls.length
  fireEvent.focus(window)
  await waitFor(() => expect(readDurable).toHaveBeenCalledTimes(calls + 1))
  expect(screen.getByRole('alert')).toHaveTextContent(/export.*connection.*try again/i)
  await openOptions()
  fireEvent.click(screen.getByRole('button', { name: 'Excel' }))
  await waitFor(() => expect(downloadDurableExport).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  expect(readDurableHistory).not.toHaveBeenCalled()
})

it('cancels the export when the researcher leaves its results', async () => {
  let finishDownload!: () => void
  vi.mocked(downloadDurableExport).mockImplementation(() => new Promise(resolve => { finishDownload = resolve }))
  const view = renderResults()
  await openOptions()
  fireEvent.click(screen.getByRole('button', { name: 'CSV' }))
  await waitFor(() => expect(downloadDurableExport).toHaveBeenCalledOnce())
  const signal = vi.mocked(downloadDurableExport).mock.calls[0]![4]!
  expect(signal.aborted).toBe(false)
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => finishDownload())
})

it('offers no export while nothing is saved yet', async () => {
  renderResults([])
  fireEvent.click(await screen.findByRole('button', { name: 'More result actions' }))
  expect(screen.getByRole('menuitem', { name: 'Export…' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: 'Export…' })).toHaveAttribute('title', 'Nothing saved to export yet')
})
