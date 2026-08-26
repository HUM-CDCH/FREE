import type { ReactNode } from 'react'

export type WorkflowPhase =
  | 'ingest'
  | 'chat'
  | 'approve'
  | 'extract'
  | 'validate'

export type PhaseProgressTone = 'progress' | 'running' | 'validated' | 'stale'

export type PhaseProgressProps = {
  phase: WorkflowPhase
  /** State color: terracotta `progress`/`running`, green `validated`, amber `stale`. */
  tone?: PhaseProgressTone
  /** Persisted member progress of an open Batch Extraction (`running` tone). */
  running?: { completedMemberCount: number; memberCount: number }
  /** Small right-hand text, e.g. a `<time>` reading "12 Aug 2026". Running shows its count instead. */
  timestamp?: ReactNode
  className?: string
}

const phaseOrder: readonly WorkflowPhase[] = [
  'ingest',
  'chat',
  'approve',
  'extract',
  'validate',
]

const phaseLabels: Record<WorkflowPhase, string> = {
  ingest: 'Ingest',
  chat: 'Schema Chat',
  approve: 'Approve schema',
  extract: 'Extract',
  validate: 'Validate',
}

/**
 * Five thin square-ended segments marking the workflow position, with a small
 * state line beneath. Purely presentational: phase, tone, and progress arrive
 * as props; nothing is fetched.
 */
function PhaseProgress({
  phase,
  tone = 'progress',
  running,
  timestamp,
  className = '',
}: PhaseProgressProps) {
  const position = phaseOrder.indexOf(phase) + 1
  const fraction =
    running && running.memberCount > 0
      ? Math.min(1, running.completedMemberCount / running.memberCount)
      : 0

  const segment = (index: number): { className: string; style?: React.CSSProperties } => {
    if (tone === 'validated') return { className: 'bg-green' }
    if (index < position - 1) return { className: 'bg-accent' }
    if (index === position - 1) {
      if (tone === 'stale') return { className: 'bg-stale' }
      if (tone === 'running')
        return {
          className: '',
          style: {
            background: `linear-gradient(to right, var(--color-accent) ${fraction * 100}%, var(--color-line) ${fraction * 100}%)`,
          },
        }
      return { className: 'bg-accent' }
    }
    return { className: 'bg-line' }
  }

  const label =
    tone === 'running'
      ? 'Extraction running'
      : tone === 'validated'
        ? 'Validated'
        : tone === 'stale'
          ? 'Re-run needed'
          : phaseLabels[phase]

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div aria-hidden="true" className="flex items-center gap-1">
        {phaseOrder.map((name, index) => {
          const { className: fill, style } = segment(index)
          return (
            <span
              key={name}
              data-testid="phase-segment"
              className={`h-0.5 flex-1 ${fill}`}
              style={style}
            />
          )
        })}
      </div>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
            tone === 'running'
              ? 'text-accent'
              : tone === 'validated'
                ? 'text-green'
                : tone === 'stale'
                  ? 'text-stale-ink'
                  : 'text-ink'
          }`}
        >
          {tone === 'running' && (
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-accent"
            />
          )}
          {tone === 'validated' && (
            <svg
              aria-hidden="true"
              width="10"
              height="10"
              viewBox="0 0 20 20"
              fill="none"
            >
              <path
                d="M4 10.5 8.5 15 16 5.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {label}
        </span>
        {tone === 'running' && running ? (
          <span className="font-mono text-[11.5px] text-ink-muted">
            {running.completedMemberCount} / {running.memberCount}
          </span>
        ) : (
          timestamp && (
            <span className="text-[11.5px] text-ink-faint">{timestamp}</span>
          )
        )}
      </div>
    </div>
  )
}

export default PhaseProgress
