import { useRef, type ReactNode } from 'react'

export type ToastAction = { label: string; onAction: () => void }

export type ToastProps = {
  message: ReactNode
  /** One optional command, e.g. Undo. The toast is dismissed before the action runs, so an action may show a follow-up toast. */
  action?: ToastAction
  onDismiss?: () => void
  /** Held while hovered or while focus is within it, so a researcher reaching its action (with the pointer or the
   *  keyboard) does not lose it to the timer; the host pauses and resumes its timer. */
  onHoldChange?: (held: boolean) => void
  className?: string
}

/** A transient notice. The host decides where it sits and for how long; `role="status"` announces it once. */
function Toast({ message, action, onDismiss, onHoldChange, className = '' }: ToastProps) {
  const hold = useRef({ hovered: false, focused: false })
  const update = (change: Partial<typeof hold.current>) => {
    const before = hold.current.hovered || hold.current.focused
    hold.current = { ...hold.current, ...change }
    const after = hold.current.hovered || hold.current.focused
    if (before !== after) onHoldChange?.(after)
  }
  return (
    <div
      role="status"
      className={`animate-fadeup pointer-events-auto flex min-w-0 max-w-full items-center gap-3 rounded-xl border border-line-strong bg-surface px-4 py-2 text-compact font-semibold text-ink shadow-float ${className}`}
      onMouseEnter={() => update({ hovered: true })}
      onMouseLeave={() => update({ hovered: false })}
      onFocus={() => update({ focused: true })}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) update({ focused: false }) }}
    >
      <span className="min-w-0 truncate">{message}</span>
      {action && (
        <button
          type="button"
          className="inline-flex min-h-6 shrink-0 cursor-pointer items-center rounded-sm px-2 font-bold text-green outline-none hover:underline"
          onClick={() => {
            onDismiss?.()
            action.onAction()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

export default Toast
