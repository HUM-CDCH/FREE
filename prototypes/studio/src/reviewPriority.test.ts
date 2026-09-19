import { describe, expect, it } from 'vitest'
import {
  FORCED_REVIEW_ISSUE_THRESHOLD,
  reviewCount,
  selectPriorityReviewMembers,
} from './reviewPriority'

describe('reviewCount', () => {
  it('reviews everything at or under 5', () => {
    expect(reviewCount(0)).toBe(0)
    expect(reviewCount(1)).toBe(1)
    expect(reviewCount(5)).toBe(5)
  })

  it('grows sub-linearly past 5, per the documented reference points', () => {
    expect(reviewCount(10)).toBe(8)
    expect(reviewCount(20)).toBe(10)
    expect(reviewCount(50)).toBe(16)
    expect(reviewCount(100)).toBe(23)
    expect(reviewCount(500)).toBe(50)
    expect(reviewCount(1000)).toBe(71)
  })

  it('never exceeds n and never drops below the 5-item floor once n >= 5', () => {
    for (const n of [6, 7, 9, 15, 42, 999]) {
      expect(reviewCount(n)).toBeLessThanOrEqual(n)
      expect(reviewCount(n)).toBeGreaterThanOrEqual(5)
    }
  })
})

describe('selectPriorityReviewMembers', () => {
  it('flags every member when there are 5 or fewer succeeded members', () => {
    const ids = ['a', 'b', 'c', 'd', 'e']
    const scores = new Map(ids.map((id) => [id, 0]))
    const flagged = selectPriorityReviewMembers(ids, scores)
    expect(flagged).toEqual(new Set(ids))
  })

  it('flags a shrinking fraction for a large clean batch via the sampled floor alone', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `doc-${i}`)
    const scores = new Map(ids.map((id) => [id, 0]))
    const flagged = selectPriorityReviewMembers(ids, scores)
    expect(flagged.size).toBe(23)
    expect(flagged.size).toBeLessThan(ids.length)
  })

  it('always includes every member above the forced threshold, even beyond the sampling target', () => {
    const ids = Array.from({ length: 10 }, (_, i) => `doc-${i}`)
    const scores = new Map(ids.map((id, i) => [id, i < 9 ? FORCED_REVIEW_ISSUE_THRESHOLD + 1 : 0]))
    const flagged = selectPriorityReviewMembers(ids, scores)
    for (let i = 0; i < 9; i += 1) expect(flagged.has(`doc-${i}`)).toBe(true)
  })

  it('fills remaining slots from below-threshold members when the forced tier is smaller than the target', () => {
    const ids = Array.from({ length: 20 }, (_, i) => `doc-${i}`)
    // Only doc-0 is forced; reviewCount(20) = 10, so 9 more must come from the sampled floor.
    const scores = new Map(ids.map((id, i) => [id, i === 0 ? FORCED_REVIEW_ISSUE_THRESHOLD + 1 : 0]))
    const flagged = selectPriorityReviewMembers(ids, scores)
    expect(flagged.size).toBe(reviewCount(20))
    expect(flagged.has('doc-0')).toBe(true)
  })

  it('does not gate on threshold when every member already exceeds it (no sampling needed)', () => {
    const ids = Array.from({ length: 8 }, (_, i) => `doc-${i}`)
    const scores = new Map(ids.map((id) => [id, FORCED_REVIEW_ISSUE_THRESHOLD + 5]))
    const flagged = selectPriorityReviewMembers(ids, scores)
    expect(flagged).toEqual(new Set(ids))
  })

  it('treats an unscored member as score zero (below any positive threshold)', () => {
    const ids = ['a', 'b']
    const flagged = selectPriorityReviewMembers(ids, new Map())
    expect(flagged).toEqual(new Set(ids)) // n <= 5, so both are flagged regardless of score
  })
})
