import type { SchemaSaveState } from './schemaSaveCoordinator'

/**
 * The durable schema's save lifecycle beside the controls that change it: an unsaved change, a save in flight, or a
 * failed save with its message and a Retry (a flush, which retries the failed save with the latest draft and scope).
 * Nothing shows once the revision is acknowledged, unless `showSaved` asks for the saved revision (the Schema panel's
 * footer); a conflict points to the Schema panel's reload. With `retry={false}` (a host beside the panel) a failure is
 * status text only: the panel footer holds the one alert and the one Retry.
 */
export function SchemaSaveStatus({
  save,
  onRetry,
  showSaved = false,
  retry = true,
  className = '',
}: {
  save: SchemaSaveState | null
  onRetry: () => void
  /** Say `Saved · revision N` once the revision is acknowledged. */
  showSaved?: boolean
  /** Offer Retry and announce a failure as an alert; false says the failure as status text only. */
  retry?: boolean
  className?: string
}) {
  const status = save?.status
  const failure =
    status === 'error' ? save?.error?.message || 'The schema could not be saved.' : null
  const failureAsStatus = failure !== null && !retry
  return (
    <span className={`flex min-w-0 items-center gap-1.5 text-secondary font-medium ${className}`}>
      {/* Always rendered, so a status that appears in it is announced. */}
      <span
        role="status"
        className={failureAsStatus ? 'min-w-0 truncate text-danger' : 'shrink-0 text-ink-muted'}
        title={failureAsStatus ? failure : undefined}
      >
        {status === 'dirty'
          ? 'Unsaved changes'
          : status === 'saving'
            ? 'Saving…'
            : status === 'conflict'
              ? 'Not saved: the schema changed elsewhere'
              : failureAsStatus
                ? `Not saved: ${failure}`
                : showSaved && status === 'saved'
                  ? `Saved · revision ${save?.acknowledged.revisionNumber}`
                  : ''}
      </span>
      {failure !== null && !failureAsStatus && (
        <>
          <span role="alert" className="min-w-0 truncate text-danger" title={failure}>
            Not saved: {failure}
          </span>
          <button
            type="button"
            onClick={onRetry}
            className="shrink-0 cursor-pointer rounded-md border border-danger/40 bg-surface px-2 py-0.5 text-compact font-semibold text-danger outline-none hover:bg-danger-soft"
          >
            Retry save
          </button>
        </>
      )}
    </span>
  )
}
