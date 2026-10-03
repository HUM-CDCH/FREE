import type { ReactNode } from 'react'

export type ToastAction = { label: string; onAction: () => void }

export type ToastProps = {
  message: ReactNode
  /** One optional command, e.g. Undo. The toast dismisses after it runs. */
  action?: ToastAction
  onDismiss?: () => void
  className?: string
}

/** A transient notice. The host decides where it sits and for how long; `role="status"` announces it once. */
function Toast({ message, action, onDismiss, className = '' }: ToastProps) {
  return (
    <div
      role="status"
      className={`animate-fadeup pointer-events-auto flex min-w-0 max-w-full items-center gap-3 rounded-xl border border-line-strong bg-surface px-4 py-2 text-compact font-semibold text-ink shadow-float ${className}`}
    >
      <span className="min-w-0 truncate">{message}</span>
      {action && (
        <button
          type="button"
          className="inline-flex min-h-6 shrink-0 cursor-pointer items-center rounded-sm px-2 font-bold text-green outline-none hover:underline"
          onClick={() => {
            action.onAction()
            onDismiss?.()
          }}
        >
          {action.label}
        </button>
      )}
    </div>
  )
}

export default Toast
