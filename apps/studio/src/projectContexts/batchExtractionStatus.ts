import type { BatchExtractionMember } from '../../shared/batchExtraction.contract'

export type StatusTone = 'neutral' | 'accent' | 'success' | 'danger'

/** One member's display status: its durable lifecycle, or its finalized review of the current cut. */
export function memberStatus(member: BatchExtractionMember): {
  label: string
  tone: StatusTone
  message: string | null
} {
  if (member.currentReview)
    return { label: 'Reviewed', tone: 'success', message: 'The finalized review names its result and decision versions.' }
  const label = member.executionStatus.charAt(0) + member.executionStatus.slice(1).toLowerCase()
  const tone: StatusTone = member.executionStatus === 'FAILED'
    ? 'danger'
    : member.executionStatus === 'RUNNING' || member.executionStatus === 'PAUSING' || member.executionStatus === 'STOPPING'
      ? 'accent'
      : 'neutral'
  return { label, tone, message: member.reviewable ? 'Saved values and producing inputs remain available.' : null }
}
