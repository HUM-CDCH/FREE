// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DocumentHistory as History } from '../shared/documentHistory.contract'
import DocumentHistory from './DocumentHistory'
import { readDocumentHistory } from './durableExtractionApi'

vi.mock('./durableExtractionApi', () => ({ readDocumentHistory: vi.fn() }))
afterEach(() => { cleanup(); vi.clearAllMocks() })

const ids = ['51000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000003']
const revision = (n: number) => ({ schemaRevisionId: `52000000-0000-4000-8000-00000000000${n}`, revisionNumber: n })
const extraction = (id: string, overrides: Partial<History['extractions'][number]> = {}): History['extractions'][number] => ({
  extractionId: id, createdAt: '2026-10-28T10:00:00.000Z', status: 'COMPLETED', strategy: 'CATALOG', batchExtractionId: null,
  sourceRevisionNumber: 2, currentSource: true, schemaRevisions: [revision(5)], pendingSchemaRevision: null, finalizations: [], ...overrides,
})
const history: History = { truncated: false, extractions: [
  extraction(ids[0]!, { status: 'RUNNING', schemaRevisions: [revision(5)], pendingSchemaRevision: revision(6) }),
  extraction(ids[1]!, { batchExtractionId: '53000000-0000-4000-8000-000000000001', schemaRevisions: [revision(4), revision(5)],
    finalizations: [{ snapshotVersion: 3, feedbackVersion: 7, createdAt: '2026-10-29T09:00:00.000Z' }] }),
  extraction(ids[2]!, { currentSource: false, sourceRevisionNumber: 1, schemaRevisions: [revision(3)] }),
] }
const props = {
  projectContextId: '50000000-0000-4000-8000-000000000001', sourceDocumentId: '50000000-0000-4000-8000-000000000002',
  visible: true, refreshKey: 'a', shown: { extractionId: ids[1]!, cut: null }, currentSchemaRevision: revision(7),
}

describe('document History', () => {
  it('lists each Extraction with its tags, schema revisions and finalized reviews, and opens one or its review', async () => {
    vi.mocked(readDocumentHistory).mockResolvedValue(history)
    const onOpen = vi.fn()
    render(<DocumentHistory {...props} onOpen={onOpen} />)
    const rows = within(await screen.findByRole('list', { name: 'Extractions of this document' })).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent(/Latest.*Running · Catalog · schema rev 5 · rev 6 pending/)
    expect(rows[1]).toHaveTextContent(/Batch.*Completed · Catalog · schema revs 4, 5.*Review finalized.*results 3/)
    expect(rows[1]).toHaveAttribute('aria-current', 'true')
    expect(within(rows[1]!).getByText('Shown')).toBeVisible()
    expect(rows[2]).toHaveTextContent(/Earlier source text \(rev 1\).*schema rev 3/)
    expect(rows[0]).not.toHaveTextContent('Earlier source text')
    // The current revision is the Project's, used by none of them.
    expect(screen.getByText(/Not run yet with the current schema revision \(rev 7, shared across the Project\)/)).toBeVisible()
    fireEvent.click(within(rows[0]!).getByRole('button', { name: /^Open Extraction of / }))
    expect(onOpen).toHaveBeenLastCalledWith(ids[0])
    fireEvent.click(within(rows[1]!).getByRole('button', { name: /^Open the review finalized / }))
    expect(onOpen).toHaveBeenLastCalledWith(ids[1], { snapshotVersion: 3, feedbackVersion: 7 })
    expect(screen.queryByText(/Showing the newest/)).not.toBeInTheDocument()
  })

  it('marks a shown finalized review, says when older Extractions are not listed, and stays quiet about a used current revision', async () => {
    vi.mocked(readDocumentHistory).mockResolvedValue({ ...history, truncated: true })
    render(<DocumentHistory {...props} shown={{ extractionId: ids[1]!, cut: { snapshotVersion: 3, feedbackVersion: 7 } }}
      currentSchemaRevision={revision(5)} onOpen={vi.fn()} />)
    const rows = within(await screen.findByRole('list', { name: 'Extractions of this document' })).getAllByRole('listitem')
    expect(rows[1]).not.toHaveAttribute('aria-current')
    expect(within(rows[1]!).getByRole('button', { name: /^Open Extraction of / })).toBeVisible()
    expect(within(rows[1]!).getByText(/Review finalized/).parentElement).toHaveAttribute('aria-current', 'true')
    expect(screen.getByText('Showing the newest 3 Extractions.')).toBeVisible()
    expect(screen.queryByText(/Not run yet/)).not.toBeInTheDocument()
  })

  it('reads only while shown, again when told to, and reports a failed read', async () => {
    vi.mocked(readDocumentHistory).mockResolvedValue(history)
    const view = render(<DocumentHistory {...props} visible={false} onOpen={vi.fn()} />)
    expect(readDocumentHistory).not.toHaveBeenCalled()
    view.rerender(<DocumentHistory {...props} onOpen={vi.fn()} />)
    await screen.findByRole('list', { name: 'Extractions of this document' })
    expect(readDocumentHistory).toHaveBeenCalledWith(props.projectContextId, props.sourceDocumentId, expect.any(AbortSignal))
    vi.mocked(readDocumentHistory).mockRejectedValue(new Error('Stored research state could not be read.'))
    view.rerender(<DocumentHistory {...props} refreshKey="b" onOpen={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Stored research state could not be read.')
    expect(readDocumentHistory).toHaveBeenCalledTimes(2)
  })

  it('says when the document has no Extractions, and ignores a read answered after it was left', async () => {
    const late = Promise.withResolvers<History>()
    vi.mocked(readDocumentHistory).mockReturnValueOnce(late.promise).mockResolvedValueOnce({ truncated: false, extractions: [] })
    const view = render(<DocumentHistory {...props} onOpen={vi.fn()} />)
    view.rerender(<DocumentHistory {...props} refreshKey="b" onOpen={vi.fn()} />)
    expect(await screen.findByText('No Extractions of this document yet.')).toBeVisible()
    late.resolve(history)
    await late.promise
    expect(screen.getByText('No Extractions of this document yet.')).toBeVisible()
  })
})
