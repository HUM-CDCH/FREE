import { describe, expect, it } from 'vitest'
import {
  documentReportText,
  partitionDocumentReports,
  type DocumentReport,
} from './BatchExtractionFinishedDialog'

const members = [{ sourceDocumentId: 'a' }, { sourceDocumentId: 'b' }, { sourceDocumentId: 'c' }]

function reportsMap(entries: Record<string, DocumentReport>): ReadonlyMap<string, DocumentReport> {
  return new Map(Object.entries(entries))
}

describe('partitionDocumentReports', () => {
  it('collapses an all-clean batch into zero detail rows and a full clean count', () => {
    const reports = reportsMap({
      a: { status: 'ready', counts: { grounded: 3, ungroundedWithValue: 0, missing: 0 } },
      b: { status: 'ready', counts: { grounded: 5, ungroundedWithValue: 0, missing: 0 } },
      c: { status: 'ready', counts: { grounded: 1, ungroundedWithValue: 0, missing: 0 } },
    })
    const { detailMembers, cleanCount } = partitionDocumentReports(members, reports)
    expect(detailMembers).toEqual([])
    expect(cleanCount).toBe(3)
  })

  it('keeps a detail row for every document with an ungrounded-with-value or missing field, in a mixed batch', () => {
    const reports = reportsMap({
      a: { status: 'ready', counts: { grounded: 3, ungroundedWithValue: 0, missing: 0 } },
      b: { status: 'ready', counts: { grounded: 2, ungroundedWithValue: 1, missing: 0 } },
      c: { status: 'ready', counts: { grounded: 1, ungroundedWithValue: 0, missing: 2 } },
    })
    const { detailMembers, cleanCount } = partitionDocumentReports(members, reports)
    expect(detailMembers.map((m) => m.sourceDocumentId)).toEqual(['b', 'c'])
    expect(cleanCount).toBe(1)
  })

  it('gives every document a detail row in an all-problem batch, with zero collapsed', () => {
    const reports = reportsMap({
      a: { status: 'ready', counts: { grounded: 0, ungroundedWithValue: 1, missing: 0 } },
      b: { status: 'failed' },
      c: { status: 'ready', counts: { grounded: 0, ungroundedWithValue: 0, missing: 2 } },
    })
    const { detailMembers, cleanCount } = partitionDocumentReports(members, reports)
    expect(detailMembers.map((m) => m.sourceDocumentId)).toEqual(['a', 'b', 'c'])
    expect(cleanCount).toBe(0)
  })

  it('treats not-yet-loaded, failed, cancelled, and errored members as detail rows, never collapsed', () => {
    const reports = reportsMap({
      a: { status: 'loading' },
      b: { status: 'cancelled' },
      // c: absent from the map entirely -> defaults to loading
    })
    const { detailMembers, cleanCount } = partitionDocumentReports(members, reports)
    expect(detailMembers.map((m) => m.sourceDocumentId)).toEqual(['a', 'b', 'c'])
    expect(cleanCount).toBe(0)
  })
})

describe('documentReportText', () => {
  it('renders the three-way breakdown for a ready report', () => {
    expect(documentReportText({ status: 'ready', counts: { grounded: 2, ungroundedWithValue: 1, missing: 3 } })).toBe(
      '6 fields · 2 grounded · 1 not grounded · 3 missing',
    )
  })

  it('omits zero-count categories', () => {
    expect(documentReportText({ status: 'ready', counts: { grounded: 4, ungroundedWithValue: 0, missing: 0 } })).toBe(
      '4 fields · 4 grounded',
    )
  })

  it('reports non-ready statuses without a field breakdown', () => {
    expect(documentReportText({ status: 'failed' })).toBe('Failed to extract.')
    expect(documentReportText({ status: 'cancelled' })).toBe('Cancelled.')
    expect(documentReportText({ status: 'error' })).toBe('Evidence coverage could not be read.')
    expect(documentReportText({ status: 'loading' })).toBe('Checking Evidence coverage…')
  })
})
