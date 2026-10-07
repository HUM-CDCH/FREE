import Button from './Button'

export type GuidedNextStepProps = {
  title: string
  description: string
  actionLabel: string
  onAction(): void
  onDismiss(): void
}

/**
 * A dismissible "here's what to do next" nudge, surfaced right after a
 * milestone completes (a document finishes uploading, a schema is first
 * committed, a schema is stabilised, …) so the researcher never has to
 * guess the next step in the guided pilot-extraction workflow. Non-modal —
 * it never blocks the page underneath, unlike `ModalDialog` — so it fits
 * transitions that happen alongside other in-flight work (more files still
 * uploading, a chat reply still streaming).
 */
export default function GuidedNextStep({
  title,
  description,
  actionLabel,
  onAction,
  onDismiss,
}: GuidedNextStepProps) {
  return (
    <div
      role="status"
      className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center p-4"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-card border border-accent/40 bg-surface p-6 shadow-lg">
        <div className="flex items-start justify-between gap-2">
          <p className="text-base font-bold text-ink">{title}</p>
          <button
            type="button"
            aria-label="Dismiss"
            title="Dismiss"
            onClick={onDismiss}
            className="shrink-0 rounded-md p-0.5 leading-none text-ink-faint outline-none transition-colors hover:bg-line/40 hover:text-ink-muted"
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {description}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" onClick={onDismiss}>
            Not now
          </Button>
          <Button
            size="sm"
            variant="positive"
            onClick={() => {
              onAction()
              onDismiss()
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
