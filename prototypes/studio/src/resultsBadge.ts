import type { ExtractionController } from './useExtraction'

export type ResultsBadge = { label: string; done?: boolean }

/** The Results tab's badge and the run button's progress word: "running" during a run, "n to check" while required
 *  decisions remain, nothing once the review is saved or no result exists. The streaming spec adds "k of n". */
export function resultsBadgeFor(
  controller: Pick<ExtractionController, 'attempt' | 'hasResults' | 'review'>,
): ResultsBadge | null {
  const attempt = controller.attempt
  if (attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING') return { label: 'running' }
  if (!controller.hasResults || attempt?.reviewedAt || controller.review.reviewedExtractionId) return null
  const remaining = controller.review.untouchedCount
  return remaining > 0 ? { label: `${remaining} to check` } : null
}
