import { Button, Overline } from './ui'

export type PilotReviewGuideProps = {
  reviewed: number
  total: number
  /** Whether the open document's review is saved. */
  currentReviewed: boolean
  /** Absent once every member is reviewed. */
  onNext?: () => void
  onBackToBatch?: () => void
}

/**
 * The pilot round's guide, a strip under the document tabs: how far the round is, what to do on this document, and
 * the step after it. The review itself happens in the Results rail; this only says so and leads on once it is saved.
 */
export default function PilotReviewGuide({ reviewed, total, currentReviewed, onNext, onBackToBatch }: PilotReviewGuideProps) {
  const done = total > 0 && reviewed >= total
  const percent = total > 0 ? Math.min(100, (reviewed / total) * 100) : 0
  const step = done
    ? 'Every pilot document is reviewed. Approve the schema, or revise it, on the Batch Extraction.'
    : currentReviewed
      ? 'This document is reviewed. Continue with the next one.'
      : 'Check each value against its highlighted source in Results (Review one by one), then Save review.'
  return (
    <div role="region" aria-label="Pilot review"
      className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-accent/30 bg-accent-ghost px-4 py-2.5">
      <div className="flex shrink-0 items-center gap-3">
        <Overline className="text-accent">Pilot review</Overline>
        <span className="text-secondary font-semibold text-ink tabular-nums">{reviewed} of {total} documents reviewed</span>
        <span role="progressbar" aria-label="Pilot documents reviewed" aria-valuenow={Math.round(percent)} aria-valuemin={0}
          aria-valuemax={100} className="block h-1.5 w-24 overflow-hidden rounded-full bg-line">
          <span className="block h-full rounded-full bg-green" style={{ width: `${percent}%` }} />
        </span>
      </div>
      <p className="m-0 min-w-48 flex-1 text-secondary text-ink">{step}</p>
      {onNext ? (
        <Button variant={currentReviewed ? 'positive' : 'secondary'} size="md" className="h-8" onClick={onNext}>
          Next document<span aria-hidden="true"> →</span>
        </Button>
      ) : done && onBackToBatch && (
        <Button variant="positive" size="md" className="h-8" onClick={onBackToBatch}>
          Back to Batch Extraction<span aria-hidden="true"> →</span>
        </Button>
      )}
    </div>
  )
}
