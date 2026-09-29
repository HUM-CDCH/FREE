import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SchemaNode } from 'extraction/schema'
import { readExtraction } from '../api'
import { getSchemaRevision } from '../schemaRevisions'
import {
  classifyExtractionFields,
  groundedPathKeySet,
  type ExtractionFieldCounts,
} from '../extractionClassification'
import type { ResultPath } from '../../shared/groundedExtraction'
import {
  batchExtractionProgress,
  PILOT_BATCH_SELECTION_LIMIT,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import { Button, ModalDialog } from '../ui'

type FetchedDocument =
  | { ok: true; resultPayload: unknown; groundedPaths: readonly ResultPath[] }
  | { ok: false }

export type DocumentReport =
  | { status: 'loading' }
  | { status: 'ready'; counts: ExtractionFieldCounts }
  | { status: 'failed' }
  | { status: 'cancelled' }
  | { status: 'error' }

/** Reads every SUCCEEDED member's full Extraction result/diagnostics — the
 *  same per-member fetch the review grid's own hook makes lazily, just run
 *  eagerly here so each document's own grounded/ungrounded-with-value/
 *  missing counts can be reported, not only a batch-wide sum. Classification
 *  itself happens outside this hook (it needs `schemaNodes`, fetched
 *  separately) so a schema-revision change doesn't require re-fetching. */
function useBatchDocumentData(
  batch: BatchExtraction,
): ReadonlyMap<string, FetchedDocument> {
  const [fetched, setFetched] = useState<ReadonlyMap<string, FetchedDocument>>(new Map())

  useEffect(() => {
    const controller = new AbortController()
    const succeeded = batch.members.filter(
      (member) => member.latestExtraction?.outcome === 'SUCCEEDED',
    )
    Promise.all(
      succeeded.map((member) =>
        readExtraction(member.latestExtraction!.extractionId, controller.signal).then(
          ({ extraction }) => ({ member, extraction, ok: true as const }),
          () => ({ member, ok: false as const }),
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return
      const next = new Map<string, FetchedDocument>()
      for (const result of results) {
        next.set(
          result.member.sourceDocumentId,
          result.ok
            ? {
                ok: true,
                resultPayload: result.extraction.resultPayload,
                groundedPaths: result.extraction.diagnostics?.grounding?.groundedPaths ?? [],
              }
            : { ok: false },
        )
      }
      setFetched(next)
    })
    return () => controller.abort()
  }, [batch])

  return fetched
}

type BatchSchemaRevisionInfo = {
  schemaNodes: readonly SchemaNode[]
  stabilisedAt: string | null
}

/** Fetches the Schema Revision this Batch Extraction ran, so the report can
 *  classify fields the same way the review grid's columns do — independent
 *  of whichever Schema Revision the panel above happens to have pinned,
 *  since the finished batch is not necessarily the one currently open. Also
 *  carries `stabilisedAt` so the dialog can state the right next step
 *  (guided-workflow-phases). */
function useBatchSchemaRevision(
  projectContextId: string,
  batch: BatchExtraction,
): BatchSchemaRevisionInfo | null {
  const [info, setInfo] = useState<BatchSchemaRevisionInfo | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getSchemaRevision(
      projectContextId,
      batch.extractionSchemaId,
      batch.schemaRevisionId,
      controller.signal,
    ).then(
      (revision) => {
        if (!controller.signal.aborted)
          setInfo({ schemaNodes: revision.schemaNodes, stabilisedAt: revision.stabilisedAt })
      },
      () => {},
    )
    return () => controller.abort()
  }, [projectContextId, batch.extractionSchemaId, batch.schemaRevisionId])

  return info
}

function useBatchDocumentReports(
  batch: BatchExtraction,
  schemaNodes: readonly SchemaNode[] | null,
): ReadonlyMap<string, DocumentReport> {
  const data = useBatchDocumentData(batch)
  return useMemo(() => {
    const merged = new Map<string, DocumentReport>()
    for (const member of batch.members) {
      const outcome = member.latestExtraction?.outcome
      if (outcome === 'FAILED') {
        merged.set(member.sourceDocumentId, { status: 'failed' })
        continue
      }
      if (outcome === 'CANCELLED') {
        merged.set(member.sourceDocumentId, { status: 'cancelled' })
        continue
      }
      const fetched = data.get(member.sourceDocumentId)
      if (!fetched) {
        merged.set(member.sourceDocumentId, { status: 'loading' })
        continue
      }
      if (!fetched.ok) {
        merged.set(member.sourceDocumentId, { status: 'error' })
        continue
      }
      merged.set(member.sourceDocumentId, {
        status: 'ready',
        counts: classifyExtractionFields(
          schemaNodes,
          fetched.resultPayload,
          groundedPathKeySet(fetched.groundedPaths),
        ),
      })
    }
    return merged
  }, [batch, data, schemaNodes])
}

export function documentReportText(report: DocumentReport): string {
  switch (report.status) {
    case 'loading':
      return 'Checking Evidence coverage…'
    case 'ready': {
      const { grounded, ungroundedWithValue, missing } = report.counts
      const fieldCount = grounded + ungroundedWithValue + missing
      return (
        `${fieldCount} field${fieldCount === 1 ? '' : 's'} · ${grounded} grounded` +
        (ungroundedWithValue > 0 ? ` · ${ungroundedWithValue} not grounded` : '') +
        (missing > 0 ? ` · ${missing} missing` : '')
      )
    }
    case 'failed':
      return 'Failed to extract.'
    case 'cancelled':
      return 'Cancelled.'
    case 'error':
      return 'Evidence coverage could not be read.'
  }
}

function hasIssues(report: DocumentReport): boolean {
  return report.status === 'ready' && (report.counts.ungroundedWithValue > 0 || report.counts.missing > 0)
}

export type BatchDocumentMember = { sourceDocumentId: string }

/** Splits a batch's members into ones that need their own detail row (not
 *  yet loaded, failed/cancelled/errored, or succeeded with an
 *  ungrounded-with-value/missing field) and a count of the rest — succeeded
 *  members with zero such fields, collapsed into one summary line. */
export function partitionDocumentReports<Member extends BatchDocumentMember>(
  members: readonly Member[],
  reports: ReadonlyMap<string, DocumentReport>,
): { detailMembers: Member[]; cleanCount: number } {
  let cleanCount = 0
  const detailMembers = members.filter((member) => {
    const report = reports.get(member.sourceDocumentId) ?? { status: 'loading' }
    if (report.status === 'ready' && !hasIssues(report)) {
      cleanCount += 1
      return false
    }
    return true
  })
  return { detailMembers, cleanCount }
}

export type BatchExtractionFinishedDialogProps = {
  batch: BatchExtraction
  projectContextId: string
  documentName(sourceDocumentId: string): string
  onReviewNow: () => void
  onDismiss: () => void
}

/**
 * Shown once when a Batch Extraction finishes running: the total succeeded
 * count, one line per Source Document that has an ungrounded-with-value or
 * missing field, a single collapsed line for the rest, and a way straight
 * into the review grid. Built on ModalDialog, following DeleteDialog's
 * structure.
 */
export default function BatchExtractionFinishedDialog({
  batch,
  projectContextId,
  documentName,
  onReviewNow,
  onDismiss,
}: BatchExtractionFinishedDialogProps) {
  const initialFocus = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const failed = batch.executionStatus === 'FAILED'
  const progress = batchExtractionProgress(batch)
  const schemaRevision = useBatchSchemaRevision(projectContextId, batch)
  const reports = useBatchDocumentReports(batch, schemaRevision?.schemaNodes ?? null)
  const isPilotRound = batch.members.length <= PILOT_BATCH_SELECTION_LIMIT
  const nextStepText = failed
    ? null
    : isPilotRound && schemaRevision?.stabilisedAt == null
      ? 'This was a pilot round. Review the results below, then stabilise the schema once you trust it, to unlock a full run across the whole collection.'
      : isPilotRound
        ? 'Review the results below, then run the full collection when ready.'
        : 'Review the results below, then export when you’re satisfied.'

  const { detailMembers, cleanCount } = useMemo(
    () => partitionDocumentReports(batch.members, reports),
    [batch, reports],
  )

  return (
    <ModalDialog
      className="m-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusRef={initialFocus}
      onDismiss={onDismiss}
    >
      <h2 id={titleId} className="text-sm font-bold text-ink">
        {failed ? 'Batch Extraction failed' : 'Batch Extraction finished'}
      </h2>
      <div id={descriptionId} className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
        {failed && (
          <p className="text-danger">
            {batch.executionFailureMessage ?? 'Execution failed.'}
          </p>
        )}
        <p>
          {progress.succeeded} succeeded
          {progress.needsReview > 0 ? ` · ${progress.needsReview} need review` : ''}
          {progress.unreviewable > 0 ? ` · ${progress.unreviewable} unreviewable` : ''}
          {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}.
        </p>
        {nextStepText && <p>{nextStepText}</p>}
      </div>
      <ul className="scrollbar-subtle mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto text-xs">
        {detailMembers.map((member) => (
          <li
            key={member.sourceDocumentId}
            className="flex items-baseline justify-between gap-3 rounded-md border border-line/60 px-2.5 py-1.5"
          >
            <span className="truncate font-medium text-ink">
              {documentName(member.sourceDocumentId)}
            </span>
            <span className="shrink-0 text-ink-muted">
              {documentReportText(reports.get(member.sourceDocumentId) ?? { status: 'loading' })}
            </span>
          </li>
        ))}
        {cleanCount > 0 && (
          <li className="px-2.5 py-1.5 text-ink-muted">
            {cleanCount} more document{cleanCount === 1 ? '' : 's'} extracted cleanly (no ungrounded or missing fields).
          </li>
        )}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="md" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button ref={initialFocus} size="md" variant="primary" onClick={onReviewNow}>
          Review now
        </Button>
      </div>
    </ModalDialog>
  )
}
