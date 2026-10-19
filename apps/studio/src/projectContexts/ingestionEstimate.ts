import { useEffect, useState } from 'react'
import type { SourceIngestion } from '../../shared/sourceDocumentIngestion.contract'

/** At least this much expected waiting earns the "take a break" note. */
export const BREAK_WORTHY_MS = 5 * 60 * 1000

type LiveIngestion = Extract<SourceIngestion, { status: 'queued' | 'parsing' }>

/** "less than a minute", "about 7 min", "about 1 h 20 min": rounded up, so the wait is never understated. */
export function formatWait(ms: number): string {
  if (ms < 60_000) return 'less than a minute'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 60) return `about ${minutes} min`
  const rest = minutes % 60
  return `about ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ''}`
}

/** The time a live ingestion still expects to take, or null when Studio has no estimate. */
export function remainingMs(ingestion: LiveIngestion, nowMs: number): number | null {
  return ingestion.estimatedCompletionAt === undefined
    ? null
    : Date.parse(ingestion.estimatedCompletionAt) - nowMs
}

/** A live ingestion's status line, e.g. "Parsing · 42 pages · about 6 min left". */
export function liveIngestionLabel(ingestion: LiveIngestion, nowMs: number): string {
  const parts: string[] = []
  if (ingestion.pageCount !== undefined)
    parts.push(`${ingestion.pageCount} page${ingestion.pageCount === 1 ? '' : 's'}`)
  const remaining = remainingMs(ingestion, nowMs)
  if (remaining !== null)
    parts.push(remaining > 0
      ? ingestion.status === 'parsing' ? `${formatWait(remaining)} left` : `done in ${formatWait(remaining)}`
      : 'taking longer than estimated')
  if (ingestion.status === 'queued') return ['Queued', ...parts].join(' · ')
  return parts.length ? ['Parsing', ...parts].join(' · ') : 'Parsing…'
}

/** The clock, re-read every `intervalMs` while `active`, so an estimate counts down between listings. */
export function useNow(active: boolean, intervalMs = 15_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const tick = () => setNow(Date.now())
    // The page may have idled since the last reading: catch up at once, then count down.
    const first = window.setTimeout(tick, 0)
    const timer = window.setInterval(tick, intervalMs)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [active, intervalMs])
  return now
}

const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/**
 * The line above the list while documents are parsing: how many are left and when the last should be done. The lanes
 * convert side by side and each estimate already waits behind its lane, so the whole set is done at the latest one,
 * not at their sum. A document without an estimate makes it a lower bound.
 */
export function parsingSummary(
  rows: readonly SourceIngestion[], nowMs: number, formatClock: (ms: number) => string = clockTime,
): string | null {
  const live = rows.filter((row): row is LiveIngestion => row.status === 'queued' || row.status === 'parsing')
  if (!live.length) return null
  const left = `${live.length} document${live.length === 1 ? '' : 's'} left to parse`
  const estimated = live.flatMap((row) => row.estimatedCompletionAt === undefined ? [] : [Date.parse(row.estimatedCompletionAt)])
  if (!estimated.length) return `${left}.`
  const last = Math.max(...estimated)
  if (last <= nowMs) return `${left} · taking longer than estimated.`
  const unknown = live.length - estimated.length
  const wait = last - nowMs
  return [
    `${left} · all done in ${unknown ? 'at least ' : ''}${formatWait(wait)} (around ${formatClock(last)}).`,
    unknown ? ` ${unknown} ${unknown === 1 ? 'has' : 'have'} no estimate yet.` : '',
    wait >= BREAK_WORTHY_MS ? ' You can take a break; this list updates on its own.' : '',
  ].join('')
}
