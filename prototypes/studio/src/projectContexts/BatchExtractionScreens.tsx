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
import { Button } from '../ui'

function stamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

function memberStatus(member: BatchExtractionMember): {
  label: string
  tone: string
  message: string | null
} {
  const extraction = member.latestExtraction
  if (member.executionStatus === 'RUNNING')
    return { label: 'Running', tone: 'text-accent', message: null }
  if (member.executionStatus === 'FAILED' && !extraction)
    return {
      label: 'No result in this batch',
      tone: 'text-danger',
      message:
        member.executionFailureMessage ??
        'The member Extraction did not finish.',
    }
  if (!extraction)
    return {
      label: member.executionStatus === 'QUEUED' ? 'Queued' : 'Not run',
      tone: 'text-ink-faint',
      message: null,
    }
  if (extraction.outcome === 'FAILED')
    return {
      label: 'Failed',
      tone: 'text-danger',
      message:
        extraction.failureMessage ??
        'The Extraction failed without a recorded reason.',
    }
  if (extraction.outcome === 'CANCELLED')
    return {
      label: 'Cancelled',
      tone: 'text-ink-muted',
      message: 'The Extraction was cancelled before completion.',
    }
  if (extraction.reviewedAt)
    return { label: 'Reviewed', tone: 'text-success', message: null }
  if (!extraction.reviewable)
    return {
      label: 'No reviewable result',
      tone: 'text-ink-muted',
      message: 'The Extraction produced no grounded Evidence to review.',
    }
  return { label: 'Needs review', tone: 'text-accent', message: null }
}

function batchStatus(batch: BatchExtraction) {
  const progress = batchExtractionProgress(batch)
  if (batch.executionStatus === 'QUEUED')
    return { label: 'Queued', tone: 'text-ink-muted' }
  if (batch.executionStatus === 'RUNNING')
    return {
      label: `Running, ${progress.extracted} of ${progress.total} completed`,
      tone: 'text-accent',
    }
  if (batch.executionStatus === 'FAILED')
    return {
      label: batch.executionFailureMessage ?? 'Execution failed',
      tone: 'text-danger',
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
  if (parts.length === 0) return { label: 'Reviewed', tone: 'text-success' }
  return {
    label: parts.join(' · '),
    tone: progress.failed ? 'text-danger' : 'text-accent',
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
    <ul className="space-y-1" aria-live="polite">
      {batches.map((batch) => {
        const status = batchStatus(batch)
        return (
          <li key={batch.batchExtractionId}>
            <button
              className="grid w-full grid-cols-1 items-center gap-2 rounded-md px-2 py-3 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40 sm:grid-cols-[1fr_auto] sm:gap-6"
              type="button"
              onClick={() => onOpen(batch)}
            >
              <span>
                <strong className="block text-xs text-ink">
                  <time dateTime={batch.createdAt}>{stamp(batch.createdAt)}</time>
                </strong>
                <span className="mt-1 block text-[11px] text-ink-muted">
                  {batchSchemaLine(batch)}
                </span>
                <span className="block text-[11px] text-ink-faint">
                  {selectionLine(batch)}
                </span>
              </span>
              <span className={`text-[11px] font-semibold ${status.tone}`}>
                {status.label}
                <span className="ml-3 text-ink-faint" aria-hidden="true">
                  ›
                </span>
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
      <div className="mb-5 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-end">
        <p className="text-[11px] text-ink-faint">
          {batchSchemaLine(batch)} · Article
        </p>
        <p className={`text-xs font-semibold ${status.tone}`}>{status.label}</p>
        <div className="flex items-start gap-2">
          <div className="flex flex-col items-end gap-1">
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
            {pinnedSchemaFailure && (
              <div className="flex max-w-72 flex-col items-end gap-1">
                <p
                  className="text-right text-[11.5px] leading-snug text-danger"
                  role="alert"
                >
                  {pinnedSchemaFailure}
                </p>
                <Button size="sm" variant="secondary" onClick={onRetrySchema}>
                  Retry Schema Revision
                </Button>
              </div>
            )}
            {coverageMessage && (
              <p
                className="max-w-96 text-right text-[11.5px] leading-snug text-ink-muted"
                role="status"
              >
                {coverageMessage}
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={opening}
            onClick={onRunAgain}
          >
            {opening ? 'Running again…' : 'Run again'}
          </Button>
        </div>
      </div>
      <ul className="space-y-1" aria-label="Batch Extraction members">
        {batch.members.map((member) => {
          const memberState = memberStatus(member)
          return (
            <li key={member.sourceDocumentId}>
              <button
                className="w-full rounded-md px-2 py-3 text-left outline-none hover:bg-line/20 focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:hover:bg-transparent"
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
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-xs font-semibold text-ink">
                    {documentName(member.sourceDocumentId)}
                  </span>
                  <small className={`shrink-0 ${memberState.tone}`}>
                    {memberState.label}
                  </small>
                </span>
                {memberState.message && (
                  <span
                    className={`mt-1 block text-[11px] leading-snug ${memberState.tone}`}
                  >
                    {memberState.message}
                  </span>
                )}
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}
