import type { HTMLAttributes } from 'react'

type Tone = 'neutral' | 'accent' | 'evidence' | 'success' | 'stale'

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
}

const outlines: Record<Tone, string> = {
  neutral: 'border border-line-strong',
  accent: 'border border-accent',
  evidence: 'border border-ev',
  success: 'border border-green',
  stale: 'border border-stale',
}

function Pill({ tone = 'neutral', outline = false, className = '', ...props }: PillProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold leading-none ${
        tones[tone]
      } ${outline ? outlines[tone] : ''} ${className}`}
      {...props}
    />
  )
}

export default Pill
