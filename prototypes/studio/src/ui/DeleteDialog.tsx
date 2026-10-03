import {
  type ReactNode,
  type RefObject,
  useId,
  useRef,
  useState,
} from 'react'
import Button from './Button'
import ModalDialog from './ModalDialog'

export type DeleteDialogProps = {
  title: string
  description: ReactNode
  onConfirm: () => Promise<{ message: string } | null>
  onCancel: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
}

/** Permanent deletion is confirmed in a labelled modal, never on one click. */
export default function DeleteDialog({
  title,
  description,
  onConfirm,
  onCancel,
  returnFocusRef,
}: DeleteDialogProps) {
  const [failure, setFailure] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const initialFocus = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const descriptionId = useId()

  return (
    <ModalDialog
      className="m-auto w-full max-w-sm rounded-card border border-line bg-surface p-5 text-ink backdrop:bg-ink/55 backdrop:backdrop-blur-[2px]"
      labelledBy={titleId}
      describedBy={descriptionId}
      initialFocusRef={initialFocus}
      returnFocusRef={returnFocusRef}
      dismissDisabled={deleting}
      onDismiss={onCancel}
    >
      <h2 id={titleId} className="text-sm font-bold text-ink">
        {title}
      </h2>
      <p
        id={descriptionId}
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
          ref={initialFocus}
          size="md"
          onClick={onCancel}
          disabled={deleting}
        >
          Cancel
        </Button>
        <Button
          size="md"
          variant="danger"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true)
            setFailure(null)
            const rejected = await onConfirm()
            if (rejected) {
              setDeleting(false)
              setFailure(rejected.message)
            } else onCancel()
          }}
        >
          {deleting ? 'Deleting…' : 'Delete permanently'}
        </Button>
      </div>
    </ModalDialog>
  )
}
