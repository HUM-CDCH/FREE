export type ProgressBarProps = {
  /** 0..1; clamped. */
  fraction: number
  tone?: 'accent' | 'success'
  className?: string
  'aria-label'?: string
}

const fillVar: Record<'accent' | 'success', string> = {
  accent: 'var(--color-accent)',
  success: 'var(--color-green)',
}

/**
 * A plain square-ended progress track. Same gradient-fill visual as
 * PhaseProgress's running segment and the inline bar in
 * BatchExtractionScreens.tsx — kept as its own primitive here rather than a
 * third bespoke copy, without folding those two into it yet.
 */
function ProgressBar({ fraction, tone = 'accent', className = '', 'aria-label': ariaLabel }: ProgressBarProps) {
  const percent = Math.min(1, Math.max(0, fraction)) * 100
  return (
    <span
      role="progressbar"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={ariaLabel}
      className={`block h-0.5 w-full ${className}`}
      style={{
        background: `linear-gradient(to right, ${fillVar[tone]} ${percent}%, var(--color-line) ${percent}%)`,
      }}
    />
  )
}

export default ProgressBar
