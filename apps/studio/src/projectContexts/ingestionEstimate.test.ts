import { describe, expect, it } from 'vitest'
import { formatWait, liveIngestionLabel, parsingSummary } from './ingestionEstimate'

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

describe('parsingSummary', () => {
  const clock = (ms: number) => `T+${(ms - NOW) / 60_000}m`
  const done = { workflowId: 'd', name: 'd.pdf', createdAt: at(-1), status: 'succeeded' as const, completedAt: at(0), sourceDocumentId: 'x' }

  it('says nothing once no document is parsing', () => {
    expect(parsingSummary([done], NOW, clock)).toBeNull()
  })

  it('is done at the latest estimate, not their sum, and suggests a break for a long wait', () => {
    expect(parsingSummary([
      live('parsing', { pageCount: 10, estimatedCompletionAt: at(3 * 60_000) }),
      live('queued', { pageCount: 90, estimatedCompletionAt: at(12 * 60_000) }),
      done,
    ], NOW, clock)).toBe('2 documents left to parse · all done in about 12 min (around T+12m). You can take a break; this list updates on its own.')
  })

  it('makes the wait a lower bound while a document has no estimate', () => {
    expect(parsingSummary([live('parsing', { estimatedCompletionAt: at(2 * 60_000) }), live('queued')], NOW, clock))
      .toBe('2 documents left to parse · all done in at least about 2 min (around T+2m). 1 has no estimate yet.')
    expect(parsingSummary([live('queued')], NOW, clock)).toBe('1 document left to parse.')
  })

  it('admits an overdue set instead of counting down past zero', () => {
    expect(parsingSummary([live('parsing', { estimatedCompletionAt: at(-1) })], NOW, clock))
      .toBe('1 document left to parse · taking longer than estimated.')
  })
})
