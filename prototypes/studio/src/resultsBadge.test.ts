import { describe, expect, it } from 'vitest'
import type { PartialResult } from '../shared/extraction.contract'
import { resultsBadgeFor } from './resultsBadge'
import type { ExtractionController } from './useExtraction'

const review = (untouchedCount: number, reviewedExtractionId: string | null = null) =>
  ({ untouchedCount, reviewedExtractionId }) as unknown as ExtractionController['review']
const attempt = (executionStatus: 'RUNNING' | 'COMPLETED', reviewedAt: string | null = null) =>
  ({ executionStatus, reviewedAt }) as unknown as ExtractionController['attempt']

describe('resultsBadgeFor', () => {
  it('says running during a run', () => {
    expect(resultsBadgeFor({ attempt: attempt('RUNNING'), hasResults: false, review: review(0), state: { status: 'running', step: 'extraction', partial: null } })).toEqual({ label: 'running' })
  })
  it('counts records once discovery is known and says running before discovery', () => {
    const partial: PartialResult = { strategy: 'CATALOG', startedAtPage: 1, discovered: 48, finished: 7, records: [], document: null }
    expect(resultsBadgeFor({ attempt: attempt('RUNNING'), hasResults: false, review: review(0), state: { status: 'running', step: 'extraction', partial } })).toEqual({ label: '7 of 48' })
    expect(resultsBadgeFor({ attempt: attempt('RUNNING'), hasResults: false, review: review(0), state: { status: 'running', step: 'extraction', partial: { ...partial, discovered: 0, finished: 0 } } })).toEqual({ label: 'running' })
  })
  it('counts the required decisions left to check', () => {
    expect(resultsBadgeFor({ attempt: attempt('COMPLETED'), hasResults: true, review: review(3), state: { status: 'ready', result: {}, evidenceLinks: [], ungroundedCount: 0 } })).toEqual({ label: '3 to check' })
  })
  it('shows nothing once reviewed or without a result', () => {
    expect(resultsBadgeFor({ attempt: attempt('COMPLETED', '2026-10-03T00:00:00Z'), hasResults: true, review: review(0), state: { status: 'idle' } })).toBeNull()
    expect(resultsBadgeFor({ attempt: attempt('COMPLETED'), hasResults: true, review: review(0, 'x'), state: { status: 'ready', result: {}, evidenceLinks: [], ungroundedCount: 0 } })).toBeNull()
    expect(resultsBadgeFor({ attempt: null, hasResults: false, review: review(0), state: { status: 'idle' } })).toBeNull()
  })
})
