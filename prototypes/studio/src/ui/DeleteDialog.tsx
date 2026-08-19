import { type ReactNode, useEffect, useRef, useState } from 'react'
import Button from './Button'

export type DeleteDialogProps = {
  title: string
  description: ReactNode
  onConfirm: () => Promise<{ message: string } | null>
  onCancel: () => void
}

/** Permanent deletion is confirmed in a labelled modal, never on one click. */
export default function DeleteDialog({
  title,
  description,
  onConfirm,
  onCancel,
}: DeleteDialogProps) {
  const [failure, setFailure] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)

  // Native modality owns focus: `showModal` moves focus in and contains Tab.
  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialog}
      className="m-auto w-full max-w-sm rounded-lg border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      aria-labelledby="delete-dialog-title"
      aria-describedby="delete-dialog-description"
      onClose={onCancel}
      // Escape and every other dismissal wait for a write in flight, so a
      // failure keeps the dialog and its retry.
      onCancel={(event) => {
        event.preventDefault()
        if (!deleting) dialog.current?.close()
      }}
    >
      <h2
        id="delete-dialog-title"
        className="text-sm font-bold text-ink"
      >
        {title}
      </h2>
      <p
        id="delete-dialog-description"
        className="mt-2 text-xs leading-relaxed text-ink-muted"
      >
        {description}
      </p>
      {failure && (
        <p className="mt-2 text-[11px] leading-snug text-danger" role="alert">
          {failure}
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          size="md"
          autoFocus
          onClick={() => dialog.current?.close()}
          disabled={deleting}
        >
          Cancel
        </Button>
        <Button
          size="md"
          variant="primary"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true)
            setFailure(null)
            const rejected = await onConfirm()
            if (rejected) {
              setDeleting(false)
              setFailure(rejected.message)
            } else dialog.current?.close()
          }}
        >
          {deleting ? 'Deleting…' : 'Delete permanently'}
        </Button>
      </div>
    </dialog>
  )
}
