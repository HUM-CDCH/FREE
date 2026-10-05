import type { ExtractionController } from './useExtraction'

export type ResultsBadge = { label: string }

/** The tab and run control count server-reported records once discovery is known, then required review decisions. */
export function resultsBadgeFor(
  controller: Pick<ExtractionController, 'attempt' | 'hasResults' | 'review' | 'state'>,
): ResultsBadge | null {
  const attempt = controller.attempt
  if(attempt?.durable)return {label:attempt.executionStatus.toLowerCase()}
  if (attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING') {
    const partial = controller.state.status === 'running' ? controller.state.partial : null
    return { label: partial && partial.discovered > 0 ? `${partial.finished} of ${partial.discovered}` : 'running' }
  }
  if (!controller.hasResults || attempt?.reviewedAt || controller.review.reviewedExtractionId) return null
  const remaining = controller.review.untouchedCount
  return remaining > 0 ? { label: `${remaining} to check` } : null
}
