import type { SchemaDefinition } from 'extraction/schema'
import type {
  ExportChoices,
  ExportFormat,
} from 'extraction-result-export'
import {
  batchExtractionProgress,
  type BatchExtraction,
  type BatchExtractionMember,
} from '../../shared/batchExtraction.contract'
import ExtractionResultExportControl from '../ExtractionResultExportControl'
import { Button, Pill } from '../ui'

type StatusTone = 'neutral' | 'accent' | 'success' | 'danger'

const statusInk: Record<StatusTone, string> = {
  neutral: 'text-ink-muted',
  accent: 'text-accent',
  success: 'text-green',
  danger: 'text-danger',
}

/** The little state dot every status rendering leads with. */
function StatusDot() {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full bg-current"
    />
  )
}

/** Bare dot-plus-label status text (the pill-less rendering). */
function StatusLine({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span
      className={`flex items-center gap-1.5 text-[11px] font-semibold ${statusInk[tone]}`}
    >
      <StatusDot />
      {label}
    </span>
  )
}

function RerunIcon() {
  return (
    <svg
      aria-hidden="true"
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M16.5 10a6.5 6.5 0 1 1-1.9-4.6M16.5 3v3.5H13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function DocumentIcon() {
  return (
    <svg
      aria-hidden="true"
      className="shrink-0"
      width="13"
      height="13"
      viewBox="0 0 20 20"
      fill="none"
    >
      <path
        d="M11.5 2.5H6.25A1.75 1.75 0 0 0 4.5 4.25v11.5a1.75 1.75 0 0 0 1.75 1.75h7.5a1.75 1.75 0 0 0 1.75-1.75V6.5l-4-4Zm0 0V6.5h4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function memberStatus(member: BatchExtractionMember): {
  label: string
  tone: StatusTone
  message: string | null
} {
  const extraction = member.latestExtraction
  if (member.executionStatus === 'RUNNING')
    return { label: 'Running', tone: 'accent', message: null }
  if (member.executionStatus === 'FAILED' && !extraction)
    return {
      label: 'No result in this batch',
      tone: 'danger',
      message:
        member.executionFailureMessage ??
        'The member Extraction did not finish.',
    }
  if (!extraction)
    return {
      label: member.executionStatus === 'QUEUED' ? 'Queued' : 'Not run',
      tone: 'neutral',
      message: null,
    }
  if (extraction.outcome === 'FAILED')
    return {
      label: 'Failed',
      tone: 'danger',
      message:
        extraction.failureMessage ??
        'The Extraction failed without a recorded reason.',
    }
  if (extraction.outcome === 'CANCELLED')
    return {
      label: 'Cancelled',
      tone: 'neutral',
      message: 'The Extraction was cancelled before completion.',
    }
  if (extraction.reviewedAt)
    return { label: 'Reviewed', tone: 'success', message: null }
  if (!extraction.reviewable)
    return {
      label: 'No reviewable result',
      tone: 'neutral',
      message: 'The Extraction produced no grounded Evidence to review.',
    }
  return { label: 'Needs review', tone: 'accent', message: null }
}

/** Status chip shared by the summary line and every member row. */
function StatusPill({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <Pill tone={tone} className="gap-1.5">
      <StatusDot />
      {label}
    </Pill>
  )
}

function batchStatus(batch: BatchExtraction): {
  label: string
  tone: StatusTone
  running: boolean
} {
  const progress = batchExtractionProgress(batch)
  if (batch.executionStatus === 'QUEUED')
    return { label: 'Queued', tone: 'neutral', running: true }
  if (batch.executionStatus === 'RUNNING')
    return {
      label: `Running · ${progress.extracted} of ${progress.total} completed`,
      tone: 'accent',
      running: true,
    }
  if (batch.executionStatus === 'FAILED')
    return {
      label: batch.executionFailureMessage ?? 'Execution failed',
      tone: 'danger',
      running: false,
    }
  const withoutResult = batch.members.filter(
    (member) =>
      member.executionStatus === 'FAILED' && member.latestExtraction === null,
  ).length
  const parts = [
    withoutResult ? `${withoutResult} without a result` : null,
    progress.needsReview ? `${progress.needsReview} need review` : null,
    progress.unreviewable
      ? `${progress.unreviewable} with no reviewable result`
      : null,
    progress.failed ? `${progress.failed} failed` : null,
    progress.cancelled ? `${progress.cancelled} cancelled` : null,
  ].filter((part): part is string => part !== null)
  if (parts.length === 0)
    return { label: 'Reviewed', tone: 'success', running: false }
  return {
    label: parts.join(' · '),
    tone: progress.failed ? 'danger' : 'accent',
    running: false,
  }
}

function batchSchemaLine(batch: BatchExtraction): string {
  return `${batch.extractionSchemaName} · Schema Revision ${batch.schemaRevisionNumber}`
}

function selectionLine(batch: BatchExtraction): string {
  const count = batch.members.length
  const strategy = batch.strategy === 'CATALOG' ? 'Catalog' : 'Article'
  return `${count} Source Document${count === 1 ? '' : 's'} · ${strategy}`
}

export function BatchExtractionHistory({
  batches,
  onOpen,
}: {
  batches: readonly BatchExtraction[]
  onOpen(batch: BatchExtraction): void
}) {
  if (batches.length === 0)
    return (
      <p className="py-6 text-center text-xs text-ink-muted">
        No Batch Extractions yet.
      </p>
    )
  return (
    <ul className="divide-y divide-line" aria-live="polite">
      {batches.map((batch) => {
        const status = batchStatus(batch)
        const progress = batchExtractionProgress(batch)
        const percent =
          progress.total > 0 ? (progress.extracted / progress.total) * 100 : 0
        return (
          <li key={batch.batchExtractionId}>
            {/* `-mx-2 px-2` keeps the hover fill wider than the text while the
                text itself stays flush with the panel heading. */}
            <button
              className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-1 items-center gap-2 rounded-xs px-2 py-3.5 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40 sm:grid-cols-[1fr_13rem_auto] sm:gap-6"
              type="button"
              onClick={() => onOpen(batch)}
            >
              <span className="min-w-0">
                <strong className="block text-[12.5px] font-semibold text-ink">
                  <time dateTime={batch.createdAt}>{stamp(batch.createdAt)}</time>
                </strong>
                <span className="mt-1 block text-[11px] text-ink-muted">
                  {batchSchemaLine(batch)}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-faint">
                  <DocumentIcon />
                  {selectionLine(batch)}
                </span>
              </span>
              {status.running ? (
                <span className="w-full">
                  <StatusLine tone={status.tone} label={status.label} />
                  {/* Same square-ended hard-stop track as PhaseProgress. */}
                  <span
                    aria-hidden="true"
                    className="mt-1.5 block h-0.5 w-full"
                    style={{
                      background: `linear-gradient(to right, var(--color-accent) ${percent}%, var(--color-line) ${percent}%)`,
                    }}
                  />
                </span>
              ) : (
                <span className="justify-self-start">
                  <StatusPill tone={status.tone} label={status.label} />
                </span>
              )}
              <span
                className="hidden shrink-0 text-[15px] font-bold leading-none text-ink-muted sm:block"
                aria-hidden="true"
              >
                ›
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

export function BatchExtractionMembers({
  batch,
  pinnedSchema,
  pinnedSchemaFailure,
  hasSuccessfulResult,
  coverageMessage,
  opening,
  documentName,
  onExport,
  onRetrySchema,
  onRunAgain,
  onOpenMember,
}: {
  batch: BatchExtraction
  pinnedSchema: SchemaDefinition | null
  pinnedSchemaFailure: string | null
  hasSuccessfulResult: boolean
  coverageMessage: string | null
  opening: boolean
  documentName(sourceDocumentId: string): string
  onExport(format: ExportFormat, choices: ExportChoices): Promise<void>
  onRetrySchema(): void
  onRunAgain(): void
  onOpenMember(sourceDocumentId: string, extractionId: string): void
}) {
  const status = batchStatus(batch)
  return (
    <>
      <div className="mb-5 flex flex-col gap-3 rounded-card border border-line bg-surface px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="min-w-0 text-[11px] text-ink-faint">
          {batchSchemaLine(batch)} · {selectionLine(batch)}
        </p>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <StatusLine tone={status.tone} label={status.label} />
          <ExtractionResultExportControl
            schema={pinnedSchema}
            disabled={!hasSuccessfulResult}
            disabledReason={
              !hasSuccessfulResult
                ? 'No successful Extraction Results are available to export.'
                : null
            }
            onExport={onExport}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={opening}
            onClick={onRunAgain}
          >
            <RerunIcon />
            {opening ? 'Running again…' : 'Run again'}
          </Button>
        </div>
      </div>
      {pinnedSchemaFailure && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <p className="text-[11.5px] leading-snug text-danger" role="alert">
            {pinnedSchemaFailure}
          </p>
          <Button size="sm" variant="secondary" onClick={onRetrySchema}>
            Retry Schema Revision
          </Button>
        </div>
      )}
      {coverageMessage && (
        <p
          className="mb-4 text-[11.5px] leading-snug text-ink-muted"
          role="status"
        >
          {coverageMessage}
        </p>
      )}
      <div
        aria-hidden="true"
        className="grid grid-cols-[1fr_auto] items-center gap-6 border-b border-line pb-2 text-[11px] font-semibold text-ink-muted sm:grid-cols-[1fr_13rem_auto]"
      >
        <span>Documents</span>
        <span className="hidden sm:block">Status</span>
        <span className="hidden w-3 sm:block" />
      </div>
      <ul className="divide-y divide-line" aria-label="Batch Extraction members">
        {batch.members.map((member) => {
          const memberState = memberStatus(member)
          return (
            <li key={member.sourceDocumentId}>
              {/* `-mx-2 px-2`: hover fill wider than the text, text still flush
                  with the column headings above. */}
              <button
                className="-mx-2 grid w-[calc(100%+1rem)] grid-cols-[1fr_auto] items-center gap-6 rounded-xs px-2 py-3.5 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:hover:bg-transparent sm:grid-cols-[1fr_13rem_auto]"
                type="button"
                disabled={!member.latestExtraction}
                onClick={() => {
                  if (member.latestExtraction)
                    onOpenMember(
                      member.sourceDocumentId,
                      member.latestExtraction.extractionId,
                    )
                }}
              >
                <span className="min-w-0">
                  <span className="flex min-w-0 items-center gap-2 text-ink-faint">
                    <DocumentIcon />
                    <span className="min-w-0 truncate text-[12.5px] font-semibold text-ink">
                      {documentName(member.sourceDocumentId)}
                    </span>
                  </span>
                  {memberState.message && (
                    <span
                      className={`mt-1 block pl-[21px] text-[11px] leading-snug ${statusInk[memberState.tone]}`}
                    >
                      {memberState.message}
                    </span>
                  )}
                </span>
                <span className="justify-self-start">
                  <StatusPill
                    tone={memberState.tone}
                    label={memberState.label}
                  />
                </span>
                <span
                  aria-hidden="true"
                  className="hidden shrink-0 text-[15px] font-bold leading-none text-ink-muted sm:block"
                >
                  ›
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
