import { phaseLabels, phaseOrder } from '../ui'
import type { ProjectResource } from '../projectNavigation'
import type { ProjectContext } from './transport'

type StepTab = ProjectResource['tab']

/** Every phase's home tab — where its next action actually happens. */
const stepTab: Record<(typeof phaseOrder)[number], StepTab> = {
  ingest: 'sources',
  chat: 'schemas',
  approve: 'schemas',
  extract: 'extractions',
  validate: 'extractions',
}

type StepStatus = 'done' | 'current' | 'upcoming'

type DisplayStep = {
  key: string
  label: string
  tab: StepTab
  status: StepStatus
  meta?: string | null
}

const extractPhaseIndex = phaseOrder.indexOf('extract')

/**
 * The project page's own live orientation stepper (guided-pilot-extraction-workflow):
 * unlike the one-shot `nudge` toasts, this always shows every phase — done,
 * current, or upcoming — so a researcher reopening a project after any
 * amount of time can immediately see where they left off and what's next,
 * not just at the moment a phase transition happens live.
 */
function ProjectWorkflowSteps({
  summary,
  onNavigate,
}: {
  summary: ProjectContext['summary']
  onNavigate: (tab: StepTab) => void
}) {
  const currentPhaseIndex = phaseOrder.indexOf(summary.phase)
  // `validate` never advances to a further phase once reached, so "fully
  // reviewed" is its own done signal — otherwise a fully-validated project
  // would sit forever on "current" with nothing to show for it. A Source
  // Document changed since its latest Extraction is pending work too: the
  // Home card already flags it, so the stepper must not claim everything is
  // done while re-extraction is needed.
  const fullyValidated =
    summary.phase === 'validate' &&
    summary.schemaStabilised &&
    summary.extractedSourceDocumentCount > 0 &&
    summary.reviewedSourceDocumentCount === summary.extractedSourceDocumentCount &&
    summary.staleSourceDocumentCount === 0

  const statusForPhase = (index: number): StepStatus => {
    if (index < currentPhaseIndex) return 'done'
    if (index === currentPhaseIndex) {
      // `validate` is the tail of the split extract phase: while Batch
      // Extraction or its review is still pending, the Batch step is the one
      // current position, so exactly one step reads as current.
      if (summary.phase === 'validate') return fullyValidated ? 'done' : 'upcoming'
      return 'current'
    }
    return 'upcoming'
  }

  // The server only tracks one `extract` phase value, but it covers two
  // rounds in sequence: piloting on a small selection first, then a
  // stabilised schema unlocking the collection-scale run. The phase itself
  // only flips to `validate` once a pilot Extraction has been reviewed, so
  // reaching `validate` is what "Pilot Extraction" being done actually
  // means. `schemaStabilised` only unlocks Batch Extraction — it's set the
  // moment a researcher clicks "Stabilise schema", before any Batch
  // Extraction has actually run, so it must never mark "Batch Extraction"
  // done by itself (that previously left the stepper claiming batch work
  // was finished when none had started). `fullyValidated` — the current
  // Revision stabilised, every latest Extraction reviewed, and nothing
  // changed since extraction — is the closest available "done" signal;
  // `runningBatch`, when present, surfaces real progress on the "current"
  // step instead of leaving it looking stalled.
  const pilotReviewed = currentPhaseIndex > extractPhaseIndex
  const pilotStatus: StepStatus =
    currentPhaseIndex < extractPhaseIndex
      ? 'upcoming'
      : pilotReviewed
        ? 'done'
        : 'current'
  const batchStatus: StepStatus = !pilotReviewed
    ? 'upcoming'
    : fullyValidated
      ? 'done'
      : 'current'
  const batchMeta =
    batchStatus === 'current' && summary.runningBatch
      ? `${summary.runningBatch.completedMemberCount}/${summary.runningBatch.memberCount}`
      : null

  const displaySteps: readonly DisplayStep[] = phaseOrder.flatMap((phase, index) =>
    phase === 'extract'
      ? [
          { key: 'pilot', label: 'Pilot Extraction', tab: stepTab.extract, status: pilotStatus },
          { key: 'batch', label: 'Batch Extraction', tab: stepTab.extract, status: batchStatus, meta: batchMeta },
        ]
      : [{ key: phase, label: phaseLabels[phase], tab: stepTab[phase], status: statusForPhase(index) }],
  )

  const nextTab = stepTab[summary.phase]
  const nextLabel =
    summary.phase === 'extract'
      ? 'Pilot Extraction'
      : summary.phase === 'validate'
        ? summary.schemaStabilised
          ? 'Batch Extraction'
          : 'Approve for batch extraction'
        : phaseLabels[summary.phase]
  // Stays visible even once the researcher is already on the target tab —
  // it's a persistent "what's next" anchor, not a one-shot nudge that
  // should vanish the moment they act on it.
  const showNext = !fullyValidated

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
      {/* A plain group, not a `role="list"` — this page already has a
          Source Documents `<ul>`, and a second implicit list role makes
          `getByRole('list')` queries ambiguous for no real accessibility
          benefit here. */}
      <div className="flex min-w-0 flex-1 items-start gap-1" role="group" aria-label="Project workflow">
        {displaySteps.map((step, index) => {
          const state = step.status
          const isLast = index === displaySteps.length - 1
          // Done steps stay interactive so a researcher can jump straight back
          // to an earlier phase's tab (e.g. to revise an already-approved
          // schema) — the phase itself never locks, it's just where the
          // stepper's "you are here" marker currently sits.
          const clickable = state === 'done'
          const stepContent = (
            <>
              <span
                aria-hidden="true"
                className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                  state === 'done'
                    ? 'bg-accent text-white'
                    : state === 'current'
                      ? 'border-2 border-accent text-accent'
                      : 'border border-line text-ink-faint'
                }`}
              >
                {state === 'done' ? (
                  <svg width="10" height="10" viewBox="0 0 20 20" fill="none">
                    <path
                      d="M4 10.5 8.5 15 16 5.5"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  index + 1
                )}
              </span>
              <span
                className={`line-clamp-2 min-w-0 text-[11px] font-semibold ${
                  state === 'upcoming' ? 'text-ink-faint' : 'text-ink'
                }`}
              >
                {step.label}
              </span>
              {step.meta && (
                <span className="text-[10px] text-ink-faint">{step.meta}</span>
              )}
            </>
          )
          return (
            <div key={step.key} className="flex min-w-0 flex-1 items-start last:flex-none">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onNavigate(step.tab)}
                  aria-label={`Go to ${step.label}`}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-1.5 rounded-md text-center outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {stepContent}
                </button>
              ) : (
                <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
                  {stepContent}
                </div>
              )}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`mt-2.5 h-0.5 min-w-4 flex-1 ${
                    state === 'done' ? 'bg-accent' : 'bg-line'
                  }`}
                />
              )}
            </div>
          )
        })}
      </div>
      {showNext && (
        <button
          type="button"
          className="shrink-0 cursor-pointer rounded-md border border-accent px-3 py-1.5 text-xs font-semibold text-accent outline-none transition-colors hover:bg-accent-soft"
          onClick={() => onNavigate(nextTab)}
        >
          Next: {nextLabel}
          <span aria-hidden="true"> →</span>
        </button>
      )}
    </div>
  )
}

export default ProjectWorkflowSteps
