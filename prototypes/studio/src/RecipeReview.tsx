import type { GroundedDiagnostics } from '../shared/extraction.contract'

/** Why a candidate was rejected, in the researcher's words. */
const REASONS: Readonly<Record<string, string>> = {
  quote_not_in_entry: 'quote not in entry',
  value_not_in_quote: 'value not in its quote',
  key_context_missing: 'its key does not introduce it',
  type_mismatch: 'wrong type for the field',
  no_quote: 'no quote given',
  malformed_candidate: 'malformed answer',
}

type Candidate = GroundedDiagnostics['proposed'][number]

function label(candidate: Candidate, grounded: GroundedDiagnostics): string {
  const record = typeof candidate.path[1] === 'number' ? grounded.recordBlocks[candidate.path[1]] : undefined
  const field = candidate.path.slice(2).filter((step) => step !== null).join('.')
  const value = typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value)
  return `${record ? `Entry ${record.entry_label} · ` : ''}${field}: ${value}`
}

/**
 * A recipe Catalog result's review material, apart from the accepted values: how much of the source
 * the segmentation accounted for, whether every call completed within budget, and the values the
 * model proposed that no rule could verify or that failed a check. Read-only; no confidence number
 * is derived from any of these flags.
 */
/** Why the segmentation's coverage is incomplete, each reason named once. */
function coverageGaps(coverage: { unresolved?: number; lines?: number; potential_duplicates?: number; reading_order_issues?: number }): string {
  const gaps = []
  if (coverage.unresolved) gaps.push(`${coverage.unresolved} of ${coverage.lines ?? '?'} source lines unresolved`)
  if (coverage.potential_duplicates) gaps.push(`${coverage.potential_duplicates} possible repeated reads`)
  if (coverage.reading_order_issues)
    gaps.push(`reading order disagrees with the page layout in ${coverage.reading_order_issues} place${coverage.reading_order_issues === 1 ? '' : 's'}`)
  return `${gaps.join('; ') || 'Coverage is incomplete'}.`
}

export function RecipeReview({ grounded }: { grounded: GroundedDiagnostics }) {
  const coverage = grounded.coverage as Parameters<typeof coverageGaps>[0] & { complete?: boolean }
  const { completeness, proposed, rejected, segmentationDiagnostics } = grounded
  const notes = new Map<string, typeof segmentationDiagnostics>()
  for (const note of segmentationDiagnostics) notes.set(note.code, [...(notes.get(note.code) ?? []), note])
  return (
    <section
      aria-label="Recipe review"
      className="mt-2 rounded-md border border-line bg-surface-muted px-2.5 py-2 text-[11.5px] leading-snug text-ink"
    >
      <p className="font-semibold">Numbered catalogue · {grounded.recipe}</p>
      <p className="text-ink-muted">
        {coverage.complete ? 'Every source line is accounted for.' : coverageGaps(coverage)}{' '}
        {completeness.processing
          ? 'Every model call completed within its token budget.'
          : 'Some model calls failed or were refused; values may be missing.'}{' '}
        Recall is not measured.
      </p>
      {notes.size > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer font-medium">
            {segmentationDiagnostics.length} segmentation note{segmentationDiagnostics.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 list-disc pl-4">
            {[...notes].map(([code, items]) => (
              <li key={code}>{code.replaceAll('_', ' ')}: {items.length} — {items[0]!.detail}</li>
            ))}
          </ul>
        </details>
      )}
      {proposed.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer font-medium">
            {proposed.length} proposed value{proposed.length === 1 ? '' : 's'} not accepted (no rule ties them to their field)
          </summary>
          <ul className="mt-1 list-disc pl-4">
            {proposed.map((candidate, index) => (
              <li key={index}>{label(candidate, grounded)}</li>
            ))}
          </ul>
        </details>
      )}
      {rejected.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer font-medium">
            {rejected.length} rejected candidate{rejected.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 list-disc pl-4">
            {rejected.map((candidate, index) => (
              <li key={index}>
                {label(candidate, grounded)} ({REASONS[candidate.reason ?? ''] ?? candidate.reason ?? 'rejected'})
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
