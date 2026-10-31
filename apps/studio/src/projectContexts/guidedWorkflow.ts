import { phaseLabels, phaseOrder, type WorkflowPhase } from '../ui'
import type { ProjectContextActivitySummary } from './transport'

export type GuidedStepStatus = 'done' | 'current' | 'upcoming'

export type GuidedStep = {
  step: WorkflowPhase
  label: string
  status: GuidedStepStatus
  /** Work a later change left on a done step; Next leads here first. */
  attention: string | null
  /** Something worth knowing that Next does not wait for. */
  hint: string | null
}

/** The work Next opens. It is the step's own, except a pilot that has run opens its results for `review`. */
export type GuidedAction = WorkflowPhase

export type GuidedWorkflow = {
  steps: readonly GuidedStep[]
  /** The one way forward: the earliest step with work left, else the current one. Null once everything is done. */
  next: { step: WorkflowPhase; label: string; action: GuidedAction } | null
  /** Why Next cannot be taken yet, while its work runs. */
  waiting: string | null
  /** The step before the current position, for "Back". */
  previous: WorkflowPhase | null
}

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`

/**
 * The guided workflow as one forward path (guided-workflow-phases). The
 * position is the server's `phase`, which never moves back. A change made
 * upstream afterwards (a revised schema, added or changed documents, new
 * results) is shown as attention on the step it reopens, and Next leads to
 * the earliest such step before anything further.
 */
export function guidedWorkflow(
  summary: ProjectContextActivitySummary,
  { sourcesInFlight = false }: { sourcesInFlight?: boolean } = {},
): GuidedWorkflow {
  const position = phaseOrder.indexOf(summary.phase)
  const reached = (step: WorkflowPhase) => phaseOrder.indexOf(step) < position
  const pending = summary.pendingExtractionSourceDocumentCount
  const unreviewed = Math.max(
    0,
    summary.extractedSourceDocumentCount - summary.reviewedSourceDocumentCount,
  )
  const revised = summary.currentSchemaRevisionId !== null && !summary.schemaStabilised

  // A first approval needs a reviewed pilot of the revision it approves; a
  // re-approval does not, so a revised schema is only a hint on the pilot then.
  const pilotAttention =
    summary.phase === 'approve' && !summary.currentSchemaRevisionReviewed
      ? 'Schema changed since the pilot'
      : null
  const pilotHint =
    reached('approve') && revised && !summary.currentSchemaRevisionReviewed
      ? 'Revised schema not piloted'
      : null
  const approveAttention = reached('approve') && revised ? 'Schema changed since approval' : null
  const batchAttention = reached('batch') && pending > 0 ? `${plural(pending, 'document')} to extract` : null
  const complete = summary.phase === 'review' && unreviewed === 0 && pending === 0 && !revised

  const attention: Record<WorkflowPhase, string | null> = {
    upload: null,
    schema: null,
    pilot: pilotAttention,
    approve: approveAttention,
    batch: batchAttention,
    review: null,
  }
  const hint: Record<WorkflowPhase, string | null> = {
    upload: sourcesInFlight && reached('upload') ? 'Parsing documents' : null,
    schema: null,
    pilot: pilotHint,
    approve: null,
    batch: null,
    review: summary.phase === 'review' && unreviewed > 0 ? `${plural(unreviewed, 'result')} to review` : null,
  }

  const steps = phaseOrder.map((step, index): GuidedStep => ({
    step,
    label: phaseLabels[step],
    status:
      index < position || (index === position && complete)
        ? 'done'
        : index === position
          ? 'current'
          : 'upcoming',
    attention: attention[step],
    hint: hint[step],
  }))

  // A pilot that has run waits for its results to be reviewed, not for another pilot.
  const pilotToReview = summary.phase === 'pilot' && unreviewed > 0
  const nextLabel = (step: WorkflowPhase): string => {
    switch (step) {
      case 'upload':
        return 'Upload documents'
      case 'schema':
        return 'Create schema'
      case 'pilot':
        return pilotToReview
          ? `Review ${plural(unreviewed, 'pilot result')}`
          : pilotAttention
            ? 'Pilot the revised schema'
            : 'Pilot extraction'
      case 'approve':
        return approveAttention ? 'Re-approve schema' : 'Approve schema'
      case 'batch':
        return pending > 0 ? `Extract ${plural(pending, 'document')}` : 'Batch extraction'
      case 'review':
        return unreviewed > 0 ? `Review ${plural(unreviewed, 'result')}` : 'Review results'
    }
  }
  const owed = phaseOrder.find((step) => attention[step] !== null)
  const nextStep = owed ?? (complete ? null : summary.phase)

  const waiting = summary.runningBatch
    ? `Extraction running · ${summary.runningBatch.completedMemberCount}/${summary.runningBatch.memberCount}`
    : nextStep === 'upload' && sourcesInFlight
      ? 'Parsing documents…'
      : null

  return {
    steps,
    next: nextStep
      ? { step: nextStep, label: nextLabel(nextStep), action: nextStep === 'pilot' && pilotToReview ? 'review' : nextStep }
      : null,
    waiting,
    previous: position > 0 ? phaseOrder[position - 1]! : null,
  }
}
