import { describe, expect, it } from 'vitest'
import { formatWait, liveIngestionLabel } from './ingestionEstimate'

const NOW = Date.parse('2026-10-19T12:00:00.000Z')
const at = (ms: number) => new Date(NOW + ms).toISOString()
const live = (status: 'queued' | 'parsing', extra: { pageCount?: number; estimatedCompletionAt?: string } = {}) =>
  ({ workflowId: 'w', name: 'a.pdf', createdAt: at(-60_000), status, ...extra })

describe('formatWait', () => {
  it('rounds up to whole minutes and hours', () => {
    expect(formatWait(30_000)).toBe('less than a minute')
    expect(formatWait(60_001)).toBe('about 2 min')
    expect(formatWait(60 * 60_000)).toBe('about 1 h')
    expect(formatWait(80 * 60_000)).toBe('about 1 h 20 min')
  })
})

describe('liveIngestionLabel', () => {
  it('keeps the bare status when Studio has no estimate', () => {
    expect(liveIngestionLabel(live('parsing'), NOW)).toBe('Parsing…')
    expect(liveIngestionLabel(live('queued'), NOW)).toBe('Queued')
  })

  it('shows the pages and the remaining wait', () => {
    expect(liveIngestionLabel(live('parsing', { pageCount: 42, estimatedCompletionAt: at(5.5 * 60_000) }), NOW))
      .toBe('Parsing · 42 pages · about 6 min left')
    expect(liveIngestionLabel(live('queued', { pageCount: 1, estimatedCompletionAt: at(9 * 60_000) }), NOW))
      .toBe('Queued · 1 page · done in about 9 min')
  })

  it('never counts below zero', () => {
    expect(liveIngestionLabel(live('parsing', { pageCount: 3, estimatedCompletionAt: at(-1) }), NOW))
      .toBe('Parsing · 3 pages · taking longer than estimated')
  })
})
