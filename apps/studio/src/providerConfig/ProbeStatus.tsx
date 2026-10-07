import { probeText, probeTone, type ProbeView } from './useProbeLifecycle'

const DOT = {
  ok: 'bg-green',
  failed: 'bg-danger',
  checking: 'animate-pulse bg-stale',
  idle: 'bg-line-strong',
} as const

/** A connection's probe state as a coloured dot; the text beside it says the same in words. */
export function ProbeDot({ probe }: { probe: ProbeView | undefined }) {
  return <span aria-hidden="true" className={`inline-block size-1.75 shrink-0 rounded-full ${DOT[probeTone(probe)]}`} />
}

/** The dot and what the probe said. */
export function ProbeStatusLine({ probe }: { probe: ProbeView | undefined }) {
  const failed = probeTone(probe) === 'failed'
  return (
    <p className={`flex items-center gap-1.5 text-[11.5px] whitespace-pre-line ${failed ? 'text-danger' : 'text-ink-muted'}`}>
      <ProbeDot probe={probe} />
      {probeText(probe)}
    </p>
  )
}
