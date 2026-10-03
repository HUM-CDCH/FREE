import type { HTMLAttributes } from 'react'

type Tone = 'neutral' | 'accent' | 'evidence' | 'success' | 'stale' | 'danger'
type Size = 'overline' | 'compact'

export type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone
  /** Add a hairline border (used for the muted "summary" chips). */
  outline?: boolean
  /** Text size: `overline` (10.5px semibold, the default) or `compact` (11px medium, e.g. a schema row's type). */
  size?: Size
}

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  accent: 'bg-accent-soft text-accent',
  evidence: 'bg-ev-soft text-ev',
  success: 'bg-green-soft text-green',
  stale: 'bg-stale-soft text-stale-ink',
  danger: 'bg-danger/10 text-danger',
}

const sizes: Record<Size, string> = {
  overline: 'text-overline font-semibold',
  compact: 'text-compact font-medium',
}

const outlines: Record<Tone, string> = {
  neutral: 'border border-line-strong',
  accent: 'border border-accent',
  evidence: 'border border-ev',
  success: 'border border-green',
  stale: 'border border-stale',
  danger: 'border border-danger/40',
}

function Pill({ tone = 'neutral', outline = false, size = 'overline', className = '', ...props }: PillProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 ${sizes[size]} leading-none ${
        tones[tone]
      } ${outline ? outlines[tone] : ''} ${className}`}
      {...props}
    />
  )
}

export default Pill
