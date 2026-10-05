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
  if(member.durableExtractionId) {
    if(member.durableReview&&member.executionStatus==='COMPLETED')return {label:'Reviewed',tone:'success',message:'Saved review names its result and feedback versions.'}
    const label=member.executionStatus.charAt(0)+member.executionStatus.slice(1).toLowerCase()
    return {label,tone:member.executionStatus==='FAILED'?'danger':member.executionStatus==='RUNNING'||member.executionStatus==='PAUSING'||member.executionStatus==='STOPPING'?'accent':'neutral',
      message:member.executionFailureMessage??'Saved values and producing inputs remain available.'}
  }
  if (member.executionStatus === 'RUNNING')
    return { label: 'Running', tone: 'accent', message: null }
  // Failed, cancelled or interrupted: the member's own message says which.
  if (member.executionStatus === 'FAILED')
    return {
      label: 'Failed',
      tone: 'danger',
      message: member.executionFailureMessage ?? 'The member Extraction did not finish.',
    }
  if (!extraction)
    return {
      label: member.executionStatus === 'QUEUED' ? 'Queued' : 'Not run',
      tone: 'neutral',
      message: null,
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
