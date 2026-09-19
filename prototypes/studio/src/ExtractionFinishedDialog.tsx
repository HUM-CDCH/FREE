import { useId, useMemo, useRef } from 'react'
import type { SchemaNode } from 'extraction/schema'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { classifyExtractionFields, groundedPathKeySet } from './extractionClassification'
import { Button, ModalDialog } from './ui'

export type ExtractionFinishedDialogProps = {
  attempt: ExtractionAttempt
  documentName: string
  schemaNodes: readonly SchemaNode[] | null
  onReviewNow: () => void
  onDismiss: () => void
}

/**
 * Shown once when a single (non-batch) Extraction finishes running: this
 * Source Document's own fields/Evidence-grounded counts, plus a way straight
 * into the Results tab. Mirrors BatchExtractionFinishedDialog's report shape
 * for one document instead of many.
 */
export default function ExtractionFinishedDialog({
  attempt,
  documentName,
  schemaNodes,
  onReviewNow,
  onDismiss,
}: ExtractionFinishedDialogProps) {
  const initialFocus = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()
  const counts = useMemo(() => {
    const grounding = attempt.diagnostics?.grounding
    return classifyExtractionFields(
      schemaNodes,
      attempt.resultPayload,
      groundedPathKeySet(grounding?.groundedPaths ?? []),
    )
  }, [schemaNodes, attempt.resultPayload, attempt.diagnostics])
  const fieldCount = counts.grounded + counts.ungroundedWithValue + counts.missing

  return (
    <ModalDialog
      className="m-auto w-full max-w-sm rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusRef={initialFocus}
      onDismiss={onDismiss}
    >
      <h2 id={titleId} className="text-sm font-bold text-ink">
        Extraction finished
      </h2>
      <div id={descriptionId} className="mt-2 space-y-1 text-xs leading-relaxed text-ink-muted">
        <p className="font-medium text-ink">{documentName}</p>
        <p>
          {fieldCount} field{fieldCount === 1 ? '' : 's'} · {counts.grounded} grounded
          {counts.ungroundedWithValue > 0 ? ` · ${counts.ungroundedWithValue} not grounded` : ''}
          {counts.missing > 0 ? ` · ${counts.missing} missing` : ''}.
        </p>
      </div>
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
