import type { HTMLAttributes } from 'react'

type Tone = 'neutral' | 'accent' | 'evidence' | 'success' | 'stale' | 'danger'

export type PillProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: Tone
  /** Add a hairline border (used for the muted "summary" chips). */
  outline?: boolean
}

const tones: Record<Tone, string> = {
  neutral: 'bg-surface-muted text-ink-muted',
  accent: 'bg-accent-soft text-accent',
  evidence: 'bg-ev-soft text-ev',
  success: 'bg-green-soft text-green',
  stale: 'bg-stale-soft text-stale-ink',
  danger: 'bg-danger/10 text-danger',
}

const outlines: Record<Tone, string> = {
  neutral: 'border border-line-strong',
  accent: 'border border-accent',
  evidence: 'border border-ev',
  success: 'border border-green',
  stale: 'border border-stale',
  danger: 'border border-danger/40',
}

function Pill({ tone = 'neutral', outline = false, className = '', ...props }: PillProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-overline font-semibold leading-none ${
        tones[tone]
      } ${outline ? outlines[tone] : ''} ${className}`}
      {...props}
    />
  )
}

export default Pill
