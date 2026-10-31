import { useId, useRef, useState } from 'react'
import { Button, ModalDialog } from '../ui'
import { stabiliseSchemaRevision } from './schemaGovernance'

/**
 * The guided workflow's Approve step (guided-workflow-phases): approves the
 * Current Schema Revision for Batch Extraction, after saying what that
 * unlocks and what it leaves to extract.
 */
export default function ApproveSchemaDialog({
  projectContextId,
  schemaRevisionId,
  reapproval,
  pendingExtractionCount,
  onApproved,
  onDismiss,
}: {
  projectContextId: string
  schemaRevisionId: string
  /** An earlier revision of this schema was approved: this approves its revision. */
  reapproval: boolean
  /** Source Documents with no Extraction on this revision yet. */
  pendingExtractionCount: number
  onApproved: () => void
  onDismiss: () => void
}) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [approving, setApproving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const approve = async () => {
    setApproving(true)
    setFailure(null)
    try {
      await stabiliseSchemaRevision({ projectContextId, schemaRevisionId })
      onApproved()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'The schema could not be approved.')
      setApproving(false)
    }
  }

  const documents = `${pendingExtractionCount} Source Document${pendingExtractionCount === 1 ? '' : 's'}`
  return (
    <ModalDialog
      className="m-auto w-full max-w-md rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy={titleId}
      initialFocusRef={cancelRef}
      dismissDisabled={approving}
      onDismiss={onDismiss}
    >
      <h2 id={titleId} className="text-sm font-bold text-ink">
        {reapproval ? 'Re-approve the revised schema?' : 'Approve the schema for Batch Extraction?'}
      </h2>
      <p className="mt-2 text-xs leading-relaxed text-ink-muted">
        {reapproval
          ? 'Batch Extraction will use the revised schema. Results extracted with the earlier revision are kept, and their documents are extracted again with this one.'
          : 'Batch Extraction will run this schema over the whole collection.'}
      </p>
      {pendingExtractionCount > 0 && (
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">
          {documents} will be extracted in the next step.
        </p>
      )}
      {failure && (
        <p className="mt-3 text-[11px] text-danger" role="alert">
          {failure}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <Button ref={cancelRef} size="sm" disabled={approving} onClick={onDismiss}>
          Cancel
        </Button>
        <Button size="sm" variant="positive" disabled={approving} onClick={() => void approve()}>
          {approving ? 'Approving…' : reapproval ? 'Re-approve' : 'Approve'}
        </Button>
      </div>
    </ModalDialog>
  )
}
