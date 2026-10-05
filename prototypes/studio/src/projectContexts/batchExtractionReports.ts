import type { ExtractionFieldCounts } from '../extractionClassification'

/** One member's own coverage report: what its published Extraction's fields
 *  look like, or why there is none to describe. */
export type DocumentReport =
  | { status: 'loading' }
  | { status: 'ready'; counts: ExtractionFieldCounts }
  | { status: 'failed' }
  | { status: 'error' }

export function documentReportText(report: DocumentReport): string {
  switch (report.status) {
    case 'loading':
      return 'Checking Evidence coverage…'
    case 'ready': {
      const { grounded, ungroundedWithValue, missing } = report.counts
      const fieldCount = grounded + ungroundedWithValue + missing
      return (
        `${fieldCount} field${fieldCount === 1 ? '' : 's'} · ${grounded} grounded` +
        (ungroundedWithValue > 0 ? ` · ${ungroundedWithValue} not grounded` : '') +
        (missing > 0 ? ` · ${missing} missing` : '')
      )
    }
    case 'failed':
      return 'Failed to extract.'
    case 'error':
      return 'Evidence coverage could not be read.'
  }
}

function hasIssues(report: DocumentReport): boolean {
  return report.status === 'ready' && (report.counts.ungroundedWithValue > 0 || report.counts.missing > 0)
}

export type BatchDocumentMember = { sourceDocumentId: string }

/** Splits a batch's members into ones that need their own detail row (not
 *  yet loaded, failed/cancelled/errored, or succeeded with an
 *  ungrounded-with-value/missing field) and a count of the rest — succeeded
 *  members with zero such fields, collapsed into one summary line. */
export function partitionDocumentReports<Member extends BatchDocumentMember>(
  members: readonly Member[],
  reports: ReadonlyMap<string, DocumentReport>,
): { detailMembers: Member[]; cleanCount: number } {
  let cleanCount = 0
  const detailMembers = members.filter((member) => {
    const report = reports.get(member.sourceDocumentId) ?? { status: 'loading' }
    if (report.status === 'ready' && !hasIssues(report)) {
      cleanCount += 1
      return false
    }
    return true
  })
  return { detailMembers, cleanCount }
}
