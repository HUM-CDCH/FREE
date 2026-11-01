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
        // React passes `cancel` up its tree: Escape in a dialog opened from another would dismiss both.
        event.stopPropagation()
        if (!dismissDisabled) onDismiss()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || dismissDisabled) return
        // The dialog itself is the target of a click on its backdrop and of one on its own padding or border: only a
        // click outside its box, whose right and bottom edges lie outside as for any hit test, is on the backdrop.
        // Browsers may report a click in whole pixels (Chromium truncates y 292.5 on a border whose top is 292.25 to
        // 292), so both are compared as pixel indices: a pixel the box partly covers counts as inside, which keeps
        // the edge of a fractional border and leaves under 1px of backdrop beside it that does not dismiss.
        const box = event.currentTarget.getBoundingClientRect()
        const x = Math.floor(event.clientX)
        const y = Math.floor(event.clientY)
        const inside =
          x >= Math.floor(box.left) &&
          x < Math.ceil(box.right) &&
          y >= Math.floor(box.top) &&
          y < Math.ceil(box.bottom)
        if (!inside) onDismiss()
      }}
    >
      {children}
    </dialog>
  )
}
