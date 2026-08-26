import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
} from 'react'

export type ModalDialogProps = {
  children: ReactNode
  className: string
  ariaLabel?: string
  labelledBy?: string
  describedBy?: string
  initialFocusRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
  dismissDisabled?: boolean
  onDismiss: () => void
}

/**
 * Shared modal contract for FREE dialogs. Native modality owns Tab
 * containment; every dismissal path is routed through onDismiss and focus is
 * restored to the exact opener when it still exists.
 */
export default function ModalDialog({
  children,
  className,
  ariaLabel,
  labelledBy,
  describedBy,
  initialFocusRef,
  returnFocusRef,
  dismissDisabled = false,
  onDismiss,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const capturedOpener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    const explicitOpener = returnFocusRef?.current ?? null
    capturedOpener.current =
      explicitOpener ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)
    if (typeof dialog?.showModal === 'function') dialog.showModal()
    else dialog?.setAttribute('open', '')

    queueMicrotask(() => initialFocusRef?.current?.focus())
    return () => {
      if (dialog?.open && typeof dialog.close === 'function') dialog.close()
      else dialog?.removeAttribute('open')
      const opener = explicitOpener ?? capturedOpener.current
      queueMicrotask(() => {
        if (opener?.isConnected) opener.focus()
      })
    }
  }, [initialFocusRef, returnFocusRef])

  return (
    <dialog
      ref={dialogRef}
      className={className}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      onCancel={(event) => {
        event.preventDefault()
        if (!dismissDisabled) onDismiss()
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !dismissDisabled)
          onDismiss()
      }}
    >
      {children}
    </dialog>
  )
}
