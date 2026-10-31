import { phaseLabels, type WorkflowPhase } from '../ui'
import { guidedWorkflow, type GuidedAction } from './guidedWorkflow'
import type { ProjectContext } from './transport'

/**
 * The project page's guided workflow bar (guided-workflow-phases): every step
 * with where the project stands, one Next that is the only way forward, and
 * Back to the step before. A done step stays open to revisit; one a later
 * change reopened says so, and Next leads there first.
 */
function ProjectWorkflowSteps({
  summary,
  sourcesInFlight = false,
  onOpenStep,
  onNext,
}: {
  summary: ProjectContext['summary']
  /** Source Ingestions this project still has queued or parsing. */
  sourcesInFlight?: boolean
  /** Shows where a step's work lives, without acting on it. */
  onOpenStep: (step: WorkflowPhase) => void
  /** Takes the one way forward: starts a step's work or opens what it left to review. */
  onNext: (action: GuidedAction) => void
}) {
  const workflow = guidedWorkflow(summary, { sourcesInFlight })

  return (
    <div className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3.5">
      {/* A plain group, not a `role="list"` — this page already has a
          Source Documents `<ul>`, and a second implicit list role makes
          `getByRole('list')` queries ambiguous for no real accessibility
          benefit here. */}
      <div className="flex min-w-0 items-start gap-1" role="group" aria-label="Project workflow">
        {workflow.steps.map((step, index) => {
          const isLast = index === workflow.steps.length - 1
          const clickable = step.status === 'done' || step.attention !== null
          const note = step.attention ?? step.hint
          const stepContent = (
            <>
              <span
                aria-hidden="true"
                className={`relative grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                  step.status === 'done'
                    ? 'bg-accent text-white'
                    : step.status === 'current'
                      ? 'border-2 border-accent text-accent'
                      : 'border border-line text-ink-faint'
                }`}
              >
                {step.status === 'done' ? (
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
                {step.attention && (
                  <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-stale ring-2 ring-surface" />
                )}
              </span>
              <span
                className={`line-clamp-2 min-w-0 text-[11px] font-semibold ${
                  step.status === 'upcoming' ? 'text-ink-faint' : 'text-ink'
                }`}
              >
                {step.label}
              </span>
              {note && (
                <span
                  className={`line-clamp-2 text-[10px] ${step.attention ? 'text-stale-ink' : 'text-ink-faint'}`}
                >
                  {note}
                </span>
              )}
            </>
          )
          return (
            <div key={step.step} className="flex min-w-0 flex-1 items-start last:flex-none">
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onOpenStep(step.step)}
                  aria-label={`Go to ${step.label}${note ? ` (${note})` : ''}`}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col items-center gap-1.5 rounded-md text-center outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {stepContent}
                </button>
              ) : (
                <div
                  className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center"
                  aria-current={step.status === 'current' ? 'step' : undefined}
                >
                  {stepContent}
                </div>
              )}
              {!isLast && (
                <span
                  aria-hidden="true"
                  className={`mt-2.5 h-0.5 min-w-4 flex-1 ${
                    step.status === 'done' ? 'bg-accent' : 'bg-line'
                  }`}
                />
              )}
            </div>
          )
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        {workflow.previous ? (
          <button
            type="button"
            className="cursor-pointer rounded-md px-1 py-1.5 text-xs font-semibold text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() => onOpenStep(workflow.previous!)}
          >
            <span aria-hidden="true">← </span>Back: {phaseLabels[workflow.previous]}
          </button>
        ) : (
          <span />
        )}
        {workflow.next ? (
          <div className="flex items-center gap-2">
            {workflow.waiting && (
              <span className="text-[11px] text-ink-muted" role="status">
                {workflow.waiting}
              </span>
            )}
            <button
              type="button"
              disabled={workflow.waiting !== null}
              className="shrink-0 cursor-pointer rounded-md border border-accent bg-accent px-3 py-1.5 text-xs font-semibold text-white outline-none transition-colors hover:opacity-90 focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-ink-faint"
              onClick={() => onNext(workflow.next!.action)}
            >
              Next: {workflow.next.label}
              <span aria-hidden="true"> →</span>
            </button>
          </div>
        ) : (
          <span className="text-xs font-semibold text-green" role="status">
            Every document is extracted and reviewed.
          </span>
        )}
      </div>
    </div>
  )
}

export default ProjectWorkflowSteps
