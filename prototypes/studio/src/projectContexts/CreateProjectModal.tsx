import { useRef, useState } from 'react'
import { projectContextNameSchema } from '../../shared/projectContext.contract'
import { Button, ModalDialog } from '../ui'
import type { WriteResult } from './useProjectContexts'

/**
 * Accessible modal creation. The dialog owns its draft and shows a retryable
 * failure in place; only an acknowledged write or a dismissal closes it.
 */
export function CreateProjectModal({
  onSubmit,
  onClose,
}: {
  onSubmit: (name: string) => WriteResult
  onClose: () => void
}) {
  const initialFocus = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // The shared contract decides, so the field never narrows it: a name that
  // trims down to the limit stays submittable however it was typed.
  const named = projectContextNameSchema.safeParse(name)

  return (
    <ModalDialog
      className="m-auto w-full max-w-sm rounded-lg border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy="create-project-context-title"
      describedBy="create-project-context-description"
      initialFocusRef={initialFocus}
      dismissDisabled={saving}
      onDismiss={onClose}
    >
      <h2
        id="create-project-context-title"
        className="text-sm font-bold text-ink"
      >
        New Project
      </h2>
      <p
        id="create-project-context-description"
        className="mt-2 text-xs leading-relaxed text-ink-muted"
      >
        Give this project a name.
      </p>
      <form
        className="mt-4 flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!named.success) return
          setSaving(true)
          setFailure(null)
          const rejected = await onSubmit(named.data)
          // A success closes the dialog; a failure keeps the typed name.
          if (rejected) {
            setSaving(false)
            setFailure(rejected.message)
          } else onClose()
        }}
      >
        <label
          className="text-xs font-semibold text-ink"
          htmlFor="new-project-context-name"
        >
          Project name
        </label>
        <input
          id="new-project-context-name"
          ref={initialFocus}
          className="rounded-sm border border-line bg-canvas px-2 py-1.5 text-sm text-ink outline-none focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-60"
          value={name}
          disabled={saving}
          aria-invalid={!named.success}
          aria-describedby={
            failure ? 'create-project-context-error' : undefined
          }
          onChange={(event) => setName(event.target.value)}
        />
        {failure && (
          <p
            id="create-project-context-error"
            className="text-[11px] leading-snug text-danger"
            role="alert"
          >
            {failure}
          </p>
        )}
        <div className="mt-2 flex justify-end gap-2">
          <Button
            type="button"
            size="md"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="md"
            variant="primary"
            disabled={saving || !named.success}
          >
            Create
          </Button>
        </div>
      </form>
    </ModalDialog>
  )
}
