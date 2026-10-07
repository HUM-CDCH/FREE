import { useRef, useState } from 'react'
import { Button, ModalDialog } from '../ui'
import type { SourceLayout } from '../sourceIngestionMachine'
import { getDocumentReopenSnapshot, toProjectContextFailure } from './transport'
import { useProjectContexts } from './useProjectContexts'

export function ReprocessSourceModal({
  source,
  onClose,
  onQueued,
}: {
  source: { projectContextId: string; sourceDocumentId: string; name: string }
  onClose: () => void
  onQueued?: () => void
}) {
  const { reprocessSource } = useProjectContexts()
  const focus = useRef<HTMLSelectElement>(null)
  const [layout, setLayout] = useState<SourceLayout>('pages')
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  return (
    <ModalDialog
      className="m-auto w-full max-w-sm rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55"
      labelledBy="reprocess-title"
      describedBy="reprocess-description"
      initialFocusRef={focus}
      dismissDisabled={loading}
      onDismiss={onClose}
    >
      <h2 id="reprocess-title" className="text-sm font-bold">
        Reprocess {source.name}
      </h2>
      <p id="reprocess-description" className="mt-2 text-xs text-ink-muted">
        Parse the retained PDF into a new source revision. Existing extractions
        and reviews keep their original evidence. Run a new extraction after
        processing to use the new evidence.
      </p>
      <form
        className="mt-4 flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault()
          setLoading(true)
          setFailure(null)
          try {
            const snapshot = await getDocumentReopenSnapshot(
              source.projectContextId,
              source.sourceDocumentId,
            )
            reprocessSource({
              ...source,
              layout,
              expectedRepresentationId:
                snapshot.sourceRepresentation.sourceRepresentationId,
            })
            onQueued?.()
            onClose()
          } catch (error) {
            setFailure(toProjectContextFailure(error).message)
            setLoading(false)
          }
        }}
      >
        <label htmlFor="reprocess-layout" className="text-xs font-semibold">
          PDF layout
        </label>
        <select
          id="reprocess-layout"
          ref={focus}
          value={layout}
          disabled={loading}
          className="rounded border border-line bg-canvas p-2 text-sm"
          onChange={(event) => setLayout(event.target.value as SourceLayout)}
        >
          <option value="pages">Single pages</option>
          <option value="spreads">Two-page spreads</option>
        </select>
        {failure && (
          <p role="alert" className="text-xs text-danger">
            {failure}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" disabled={loading} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="positive" disabled={loading}>
            Reprocess
          </Button>
        </div>
      </form>
    </ModalDialog>
  )
}
