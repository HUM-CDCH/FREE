import { Button, phaseLabels } from '../ui'
import { guidedWorkflow } from './guidedWorkflow'
import type { ProjectContext } from './transport'

/**
 * Where the project stands, said and not led: the chat leads the workflow (pilot, approval, batch, review), so this
 * page offers no step of its own, only the way into the chat on a document. Uploading is the exception: it happens
 * on this page, so that step points to the documents below and not to the chat.
 */
export default function ProjectStatus({
  summary,
  sourcesInFlight = false,
  onContinue,
}: {
  summary: ProjectContext['summary']
  /** Source Ingestions this project still has queued or parsing. */
  sourcesInFlight?: boolean
  /** Opens a document, where the chat goes on; null while the project has none. */
  onContinue: (() => void) | null
}) {
  const workflow = guidedWorkflow(summary, { sourcesInFlight })
  const state = workflow.waiting
    ?? (!workflow.next
      ? 'Every document is extracted and reviewed.'
      : workflow.next.step === 'upload'
        ? 'Next: upload documents below.'
        : `Next in the chat: ${workflow.next.label}`)
  return (
    <section aria-label="Project status"
      className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-card border border-line bg-surface px-4 py-3.5">
      <div className="min-w-0">
        <p className="m-0 text-overline font-bold uppercase tracking-[0.12em] text-ink-muted">{phaseLabels[summary.phase]}</p>
        <p className="m-0 text-xs font-semibold text-ink">{state}</p>
      </div>
      {onContinue && (
        <Button variant="positive" size="md" onClick={onContinue}>
          Continue in chat<span aria-hidden="true"> →</span>
        </Button>
      )}
    </section>
  )
}
