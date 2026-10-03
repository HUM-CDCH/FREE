import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { SchemaNode } from 'extraction/schema'
import { readExtraction } from '../api'
import { getSchemaRevision } from '../schemaRevisions'
import { countLeafFields } from '../fieldCoverage'
import {
  batchExtractionProgress,
  type BatchExtraction,
} from '../../shared/batchExtraction.contract'
import { Button, ModalDialog } from '../ui'

type DocumentReport =
  | { status: 'loading' }
  | { status: 'ready'; grounded: number; ungrounded: number }
  | { status: 'failed' }
  | { status: 'error' }

/** Reads every published member Extraction's full diagnostics — the same
 *  per-member fetch the review grid's own hook makes lazily, just run
 *  eagerly here so each document's own grounded/ungrounded counts can be
 *  reported, not only a batch-wide sum. */
function useBatchDocumentReports(
  batch: BatchExtraction,
): ReadonlyMap<string, DocumentReport> {
  // Only ever holds the fetched outcome of members with a published
  // Extraction — failed and loading are derived synchronously from `batch`
  // itself below, so this state never needs a synchronous reset at the top of
  // the effect.
  const [fetched, setFetched] = useState<ReadonlyMap<string, DocumentReport>>(new Map())

  useEffect(() => {
    const controller = new AbortController()
    const succeeded = batch.members.filter((member) => member.latestExtraction)
    Promise.all(
      succeeded.map((member) =>
        readExtraction(member.latestExtraction!.extractionId, controller.signal).then(
          ({ extraction }) => ({ member, extraction, ok: true as const }),
          () => ({ member, ok: false as const }),
        ),
      ),
    ).then((results) => {
      if (controller.signal.aborted) return
      const next = new Map<string, DocumentReport>()
      for (const result of results) {
        next.set(
          result.member.sourceDocumentId,
          result.ok
            ? {
                status: 'ready',
                grounded: result.extraction.diagnostics?.grounding?.groundedPaths.length ?? 0,
                ungrounded: result.extraction.diagnostics?.grounding?.ungroundedPaths.length ?? 0,
              }
            : { status: 'error' },
        )
      }
      setFetched(next)
    })
    return () => controller.abort()
  }, [batch])

  return useMemo(() => {
    const merged = new Map<string, DocumentReport>()
    for (const member of batch.members) {
      merged.set(
        member.sourceDocumentId,
        member.executionStatus === 'FAILED'
          ? { status: 'failed' }
          : (fetched.get(member.sourceDocumentId) ?? { status: 'loading' }),
      )
    }
    return merged
  }, [batch, fetched])
}

/** Fetches the Schema Revision this Batch Extraction ran, so the report can
 *  count fields the same way the review grid's columns do — independent of
 *  whichever Schema Revision the panel above happens to have pinned, since
 *  the finished batch is not necessarily the one currently open. */
function useBatchSchemaNodes(
  projectContextId: string,
  batch: BatchExtraction,
): readonly SchemaNode[] | null {
  const [schemaNodes, setSchemaNodes] = useState<readonly SchemaNode[] | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getSchemaRevision(
      projectContextId,
      batch.extractionSchemaId,
      batch.schemaRevisionId,
      controller.signal,
    ).then(
      (revision) => {
        if (!controller.signal.aborted) setSchemaNodes(revision.schemaNodes)
      },
      () => {},
    )
    return () => controller.abort()
  }, [projectContextId, batch.extractionSchemaId, batch.schemaRevisionId])

  return schemaNodes
}

function documentReportText(report: DocumentReport, fieldCount: number): string {
  switch (report.status) {
    case 'loading':
      return 'Checking Evidence coverage…'
    case 'ready':
      return `${fieldCount} field${fieldCount === 1 ? '' : 's'} · ${report.grounded} grounded`
    case 'failed':
      return 'Failed to extract.'
    case 'error':
      return 'Evidence coverage could not be read.'
  }
}

export type BatchExtractionFinishedDialogProps = {
  batch: BatchExtraction
  projectContextId: string
  documentName(sourceDocumentId: string): string
  onReviewNow: () => void
  onDismiss: () => void
}

/**
 * Shown once when a Batch Extraction finishes running: one line per Source
 * Document with its own fields/Evidence-grounded counts, plus a way straight
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
  const progress = batchExtractionProgress(batch)
  const reports = useBatchDocumentReports(batch)
  const schemaNodes = useBatchSchemaNodes(projectContextId, batch)
  const fieldCount = useMemo(() => countLeafFields(schemaNodes), [schemaNodes])

  return (
    <ModalDialog
      className="m-auto flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusRef={initialFocus}
      onDismiss={onDismiss}
    >
      <h2 id={titleId} className="text-sm font-bold text-ink">
        Batch Extraction finished
      </h2>
      <div id={descriptionId} className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
        <p>
          {progress.total} Source Document{progress.total === 1 ? '' : 's'} extracted
          {progress.needsReview > 0 ? ` · ${progress.needsReview} need review` : ''}
          {progress.unreviewable > 0 ? ` · ${progress.unreviewable} unreviewable` : ''}
          {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}.
        </p>
      </div>
      <ul className="scrollbar-subtle mt-3 min-h-0 flex-1 space-y-1 overflow-y-auto text-xs">
        {batch.members.map((member) => (
          <li
            key={member.sourceDocumentId}
            className="flex items-baseline justify-between gap-3 rounded-md border border-line/60 px-2.5 py-1.5"
          >
            <span className="truncate font-medium text-ink">
              {documentName(member.sourceDocumentId)}
            </span>
            <span className="shrink-0 text-ink-muted">
              {documentReportText(
                reports.get(member.sourceDocumentId) ?? { status: 'loading' },
                fieldCount,
              )}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <Button size="md" onClick={onDismiss}>
          Dismiss
        </Button>
        <Button ref={initialFocus} size="md" variant="positive" onClick={onReviewNow}>
          Review now
        </Button>
      </div>
    </ModalDialog>
  )
}
