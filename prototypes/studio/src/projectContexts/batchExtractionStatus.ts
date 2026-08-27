import type { BatchExtractionMember } from '../../shared/batchExtraction.contract'

export type StatusTone = 'neutral' | 'accent' | 'success' | 'danger'

/**
 * One member's display status, shared by the members list and the review
 * grid so a Source Document never shows two different status stories.
 */
export function memberStatus(member: BatchExtractionMember): {
  label: string
  tone: StatusTone
  message: string | null
} {
  const extraction = member.latestExtraction
  if (member.executionStatus === 'RUNNING')
    return { label: 'Running', tone: 'accent', message: null }
  if (member.executionStatus === 'FAILED' && !extraction)
    return {
      label: 'No result in this batch',
      tone: 'danger',
      message:
        member.executionFailureMessage ??
        'The member Extraction did not finish.',
    }
  if (!extraction)
    return {
      label: member.executionStatus === 'QUEUED' ? 'Queued' : 'Not run',
      tone: 'neutral',
      message: null,
    }
  if (extraction.outcome === 'FAILED')
    return {
      label: 'Failed',
      tone: 'danger',
      message:
        extraction.failureMessage ??
        'The Extraction failed without a recorded reason.',
    }
  if (extraction.outcome === 'CANCELLED')
    return {
      label: 'Cancelled',
      tone: 'neutral',
      message: 'The Extraction was cancelled before completion.',
    }
  if (extraction.reviewedAt)
    return { label: 'Reviewed', tone: 'success', message: null }
  if (!extraction.reviewable)
    return {
      label: 'No reviewable result',
      tone: 'neutral',
      message: 'The Extraction produced no grounded Evidence to review.',
    }
  return { label: 'Needs review', tone: 'accent', message: null }
}
