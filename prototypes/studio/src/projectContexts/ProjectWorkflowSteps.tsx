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
  activeTab,
  onNavigate,
}: {
  summary: ProjectContext['summary']
  activeTab: ProjectResource['tab']
  onNavigate: (tab: StepTab) => void
}) {
  const currentPhaseIndex = phaseOrder.indexOf(summary.phase)
  // `validate` never advances to a further phase once reached, so "fully
  // reviewed" is its own done signal — otherwise a fully-validated project
  // would sit forever on "current" with nothing to show for it.
  const fullyValidated =
    summary.phase === 'validate' &&
    summary.extractedSourceDocumentCount > 0 &&
    summary.reviewedSourceDocumentCount === summary.extractedSourceDocumentCount

  const statusForPhase = (index: number): StepStatus => {
    if (index < currentPhaseIndex) return 'done'
    if (index === currentPhaseIndex) return fullyValidated ? 'done' : 'current'
    return 'upcoming'
  }

  // The server only tracks one `extract` phase value, but it covers two
  // rounds in sequence: piloting on a small selection first, then a
  // stabilised schema unlocking the collection-scale run. The phase itself
  // only flips to `validate` once a pilot Extraction has been reviewed, and
  // stabilising requires exactly that review to already have happened — so
  // `phase === 'extract'` and `schemaStabilised` never overlap; reaching
  // `validate` is what "Pilot Extraction" being done actually means, and
  // `schemaStabilised` is the only further signal for whether "Batch
  // Extraction" has started or finished from there.
  const pilotReviewed = currentPhaseIndex > extractPhaseIndex
  const pilotStatus: StepStatus =
    currentPhaseIndex < extractPhaseIndex
      ? 'upcoming'
      : pilotReviewed
        ? 'done'
        : 'current'
  const batchStatus: StepStatus = !pilotReviewed
    ? 'upcoming'
    : summary.schemaStabilised
      ? 'done'
      : 'current'

  const displaySteps: readonly DisplayStep[] = phaseOrder.flatMap((phase, index) =>
    phase === 'extract'
      ? [
          { key: 'pilot', label: 'Pilot Extraction', tab: stepTab.extract, status: pilotStatus },
          { key: 'batch', label: 'Batch Extraction', tab: stepTab.extract, status: batchStatus },
        ]
      : [{ key: phase, label: phaseLabels[phase], tab: stepTab[phase], status: statusForPhase(index) }],
  )

  const nextTab = stepTab[summary.phase]
  const nextLabel =
    summary.phase === 'extract'
      ? 'Pilot Extraction'
      : summary.phase === 'validate' && !summary.schemaStabilised
        ? 'Batch Extraction'
        : phaseLabels[summary.phase]
  const showNext = !fullyValidated && activeTab !== nextTab

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
                className={`min-w-0 truncate text-[11px] font-semibold ${
                  state === 'upcoming' ? 'text-ink-faint' : 'text-ink'
                }`}
              >
                {step.label}
              </span>
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
