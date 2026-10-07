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

function renderResults() {
  const page = { snapshotVersion: 1, feedbackVersion: 0, status: 'PAUSED',
    reviewCounts: { required: 0, toCheck: 0, approved: 0, edited: 0, rejected: 0 },
    values: [], total: 0, next: null, coverage: {} }
  const state = { extractionId: 'extraction', projectId: 'project', status: 'PAUSED',
    controlVersion: 1, snapshotVersion: 1, feedbackVersion: 0,
    selection: { id: 'selection', ordinal: 1, schemaTree: { schemaNodes: [] }, resolved: {} },
    pendingSelection: null, counts: { saved: 0, inFlight: 0 }, records: null, reading: [] }
  vi.mocked(readDurable).mockResolvedValue({ state, page } as never)
  vi.mocked(durableRequest).mockResolvedValue([])
  return render(<DurableResults attempt={{ extractionId: 'extraction', strategy: 'ARTICLE' } as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={() => {}} />)
}

async function startExport(label: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'More result actions' }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

it.each(['Export XLSX', 'Export CSV bundle'])('shows progress throughout %s and blocks duplicate downloads', async (label) => {
  let finishHistory!: (history: never) => void
  let finishDownload!: () => void
  vi.mocked(readDurableHistory).mockImplementation(() => new Promise(resolve => { finishHistory = resolve }))
  vi.mocked(downloadDurableExport).mockImplementation(() => new Promise(resolve => { finishDownload = resolve }))
  renderResults()
  await startExport(label)
  expect(screen.getByRole('status', { name: 'Export progress' })).toHaveTextContent(/Preparing .*export/)
  fireEvent.click(screen.getByRole('button', { name: 'More result actions' }))
  expect(screen.getByRole('menuitem', { name: 'Export XLSX' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: 'Export CSV bundle' })).toBeDisabled()
  expect(readDurableHistory).toHaveBeenCalledTimes(1)

  await act(async () => finishHistory({} as never))
  await waitFor(() => expect(downloadDurableExport).toHaveBeenCalledOnce())
  expect(screen.getByRole('status', { name: 'Export progress' })).toHaveTextContent(/Preparing .*export/)
  await act(async () => finishDownload())
  expect(screen.getByRole('status', { name: 'Export progress' })).toHaveTextContent('Download started')
  expect(screen.getByRole('menuitem', { name: 'Export XLSX' })).toBeEnabled()
})

it('keeps an interrupted export visible across result polls and lets the researcher retry', async () => {
  vi.mocked(readDurableHistory).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({} as never)
  vi.mocked(downloadDurableExport).mockResolvedValue(undefined)
  renderResults()
  await startExport('Export XLSX')
  expect(await screen.findByRole('alert')).toHaveTextContent(/export.*connection.*try again/i)
  const calls = vi.mocked(readDurable).mock.calls.length
  await waitFor(() => expect(readDurable).toHaveBeenCalledTimes(calls + 1), { timeout: 2500 })
  expect(screen.getByRole('alert')).toHaveTextContent(/export.*connection.*try again/i)
  await startExport('Export XLSX')
  await waitFor(() => expect(downloadDurableExport).toHaveBeenCalledOnce())
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('cancels the export when the researcher leaves its results', async () => {
  let finishHistory!: (history: never) => void
  vi.mocked(readDurableHistory).mockImplementation(() => new Promise(resolve => { finishHistory = resolve }))
  const view = renderResults()
  await startExport('Export CSV bundle')
  const signal = vi.mocked(readDurableHistory).mock.calls[0]![1]!
  expect(signal.aborted).toBe(false)
  view.unmount()
  expect(signal.aborted).toBe(true)
  await act(async () => finishHistory({} as never))
  expect(downloadDurableExport).not.toHaveBeenCalled()
})
