// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ValueHistory as History } from '../shared/documentHistory.contract'
import ValueHistory from './ValueHistory'
import { readValueHistory } from './durableExtractionApi'

vi.mock('./durableExtractionApi', () => ({ readValueHistory: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const ids = ['51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000003']
const node = { id: 'title-node', name: 'title', type: 'string' as const }
const reading = (extractionId: string, overrides: Partial<History['readings'][number]> = {}): History['readings'][number] => ({
  extractionId, createdAt: '2026-10-28T10:00:00.000Z', status: 'COMPLETED', snapshotVersion: 2,
  schemaRevision: { schemaRevisionId: '52000000-0000-4000-8000-000000000005', revisionNumber: 5 }, node, processing: 'saved',
  modelValue: 'Old title', decision: null, decisionIncompatible: false, ...overrides,
})
const history: History = { truncated: false, untraceableRevisions: 2, unmatched: 1, readings: [
  reading(ids[0]!, { modelValue: 'New titel', decision: { action: 'EDITED', value: 'New title' } }),
  reading(ids[1]!, { node: { ...node, name: 'heading' }, decision: { action: 'APPROVED' }, schemaRevision: { schemaRevisionId: '52000000-0000-4000-8000-000000000004', revisionNumber: 4 } }),
  reading(ids[2]!, { decision: null, decisionIncompatible: true }),
] }
const props = { projectContextId: '50000000-0000-4000-8000-000000000001', sourceDocumentId: '50000000-0000-4000-8000-000000000002',
  extractionId: ids[0]!, valueId: 'v-title', name: 'title', visible: true, shownExtractionId: ids[0]! }

describe('value History', () => {
  it('lists each Extraction\'s latest reading with its decision and historical name, opens one, counts the rest and goes back', async () => {
    vi.mocked(readValueHistory).mockResolvedValue(history)
    const onOpen = vi.fn(), onBack = vi.fn()
    render(<ValueHistory {...props} onOpen={onOpen} onBack={onBack} />)
    expect(screen.getByRole('heading', { name: 'History of title' })).toBeVisible()
    const rows = within(await screen.findByRole('list', { name: 'Readings of title' })).getAllByRole('listitem')
    expect(readValueHistory).toHaveBeenCalledWith(props.projectContextId, props.sourceDocumentId, ids[0], 'v-title', expect.any(AbortSignal))
    expect(rows[0]).toHaveTextContent(/New title.*Extracted: New titel.*Edited · schema rev 5/)
    expect(rows[0]).toHaveAttribute('aria-current', 'true')
    expect(within(rows[0]!).getByText('Shown')).toBeVisible()
    expect(rows[1]).toHaveTextContent(/Old title.*Approved · schema rev 4 · named heading/)
    expect(rows[2]).toHaveTextContent(/Earlier decision no longer fits/)
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Open Extraction of / }))
    expect(onOpen).toHaveBeenCalledWith(ids[1])
    expect(screen.getByText('No matching value in 1 Extraction.')).toBeVisible()
    expect(screen.getByText('Not traceable across 2 different source revisions.')).toBeVisible()
    expect(screen.queryByText(/Searched only the newest/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Whole document' }))
    expect(onBack).toHaveBeenCalled()
  })

  it('reads only while shown, and reports a failed read', async () => {
    vi.mocked(readValueHistory).mockRejectedValue(new Error('Stored research state could not be read.'))
    const view = render(<ValueHistory {...props} visible={false} onOpen={vi.fn()} onBack={vi.fn()} />)
    expect(readValueHistory).not.toHaveBeenCalled()
    view.rerender(<ValueHistory {...props} onOpen={vi.fn()} onBack={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Stored research state could not be read.')
  })
})
