/**
 * Two-tier "priority review" flagging for the batch review grid (design.md
 * D3): a forced tier (score above a threshold) plus a sampled floor over
 * the remaining members, sized by a √N-style curve so the reviewed count
 * still grows with batch size while the reviewed fraction shrinks. This is
 * advisory only — it drives sort order and a badge, never what a document
 * is allowed to be reviewed or approved (review-grid-prioritization spec).
 */

/** More than this many ungrounded-with-value + missing fields forces
 *  priority review regardless of the sampling budget. A conservative
 *  starting point — tune against real batches (design.md D3, tasks.md 6.2). */
export const FORCED_REVIEW_ISSUE_THRESHOLD = 2

/** How many of `n` succeeded members should be flagged for review: every
 *  one for small batches, then growing with the square root of `n` so the
 *  count keeps growing but the fraction shrinks. */
export function reviewCount(n: number): number {
  if (n <= 5) return n
  return Math.max(5, Math.ceil(Math.sqrt(5 * n)))
}

/**
 * Selects which of `succeededSourceDocumentIds` are flagged "priority
 * review": every member whose score exceeds `forcedThreshold` (forced
 * tier), plus enough more — evenly spaced through the remaining members in
 * their given order — to reach `reviewCount(n)` total (sampled floor).
 */
export function selectPriorityReviewMembers(
  succeededSourceDocumentIds: readonly string[],
  issueScores: ReadonlyMap<string, number>,
  forcedThreshold: number = FORCED_REVIEW_ISSUE_THRESHOLD,
): ReadonlySet<string> {
  const target = reviewCount(succeededSourceDocumentIds.length)
  const flagged = new Set(
    succeededSourceDocumentIds.filter((id) => (issueScores.get(id) ?? 0) > forcedThreshold),
  )
  if (flagged.size >= target) return flagged

  const remaining = succeededSourceDocumentIds.filter((id) => !flagged.has(id))
  const need = target - flagged.size
  const chosenIndices = new Set<number>()
  for (let i = 0; i < need; i += 1)
    chosenIndices.add(Math.floor((i * remaining.length) / need))
  for (const index of chosenIndices) flagged.add(remaining[index])

  return flagged
}
