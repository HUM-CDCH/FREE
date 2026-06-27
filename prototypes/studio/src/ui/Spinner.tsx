export type SpinnerProps = {
  /** When set, renders the spinner centered above a label/hint block. */
  label?: string
  hint?: string
  className?: string
}

function Spinner({ label, hint, className = '' }: SpinnerProps) {
  const ring = (
    <span
      aria-hidden="true"
      className="animate-spin-slow size-7 rounded-full border-[3px] border-line border-t-accent"
    />
  )

  if (!label && !hint) {
    return ring
  }

  return (
    <div className={`flex flex-col items-center gap-3 text-center ${className}`} aria-live="polite">
      {ring}
      {label && <p className="text-[13px] font-semibold text-ink">{label}</p>}
      {hint && <p className="max-w-[34ch] text-xs leading-snug text-ink-muted">{hint}</p>}
    </div>
  )
}

export default Spinner
