import type { UnifiedDiagnostics } from '../shared/extraction.contract'

/** Why a unified Catalog candidate was not accepted, in the researcher's words. */
const REASONS: Readonly<Record<string, string>> = {
  quote_not_in_source: 'its quote is not text of this entry',
  value_not_in_quote: 'the value is not in its quote',
  type_mismatch: 'wrong type for the field',
  no_quote: 'no quote given',
  malformed_candidate: 'malformed answer',
  verification_rejected: 'verification found no support',
  verification_unclear: 'verification was unsure',
  verification_unresolved: 'verification gave no usable answer',
  verification_disabled: 'verification is off',
  evidence_policy_derived: 'the schema marks it derived',
  evidence_policy_unverified: 'the schema marks it unverified',
  partial_item: 'a list item seen only in part at a window cut',
  competing_value: 'another verified value disagrees',
  document_unverified: 'document-level fields are not verified',
}

type Candidate = UnifiedDiagnostics['proposed'][number]

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`
const where = (span: { segment: string; start: number; end: number }) => `${span.segment} [${span.start}:${span.end}]`

function label(candidate: Candidate): string {
  const entry = typeof candidate.path[1] === 'number' ? `Entry ${candidate.path[1] + 1} · ` : ''
  const field = candidate.path.slice(2).map((step) => (step === null ? '?' : step)).join('.')
  const value = typeof candidate.value === 'string' ? candidate.value : JSON.stringify(candidate.value)
  return `${entry}${field}: ${value} (${REASONS[candidate.reason ?? ''] ?? candidate.reason ?? 'not accepted'})`
}

function List({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <details className="mt-1">
      <summary className="cursor-pointer font-medium">{title}</summary>
      <ul className="mt-1 list-disc pl-4">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>
    </details>
  )
}

/**
 * A unified Catalog result's review material, apart from the accepted values: whether every source range has a
 * disposition and which stayed unresolved, whether every stage's model calls completed, and each value that was
 * proposed, rejected, contested or seen only in part. Accounting, processing and evidence are separate statements;
 * none of them measures recall, and no confidence number is derived from them.
 */
export function CatalogReview({ unified }: { unified: UnifiedDiagnostics }) {
  const { completeness, processing, document } = unified
  const failed = [
    processing.discovery.failed && plural(processing.discovery.failed, 'discovery window'),
    processing.entries.failed && plural(processing.entries.failed, 'entry window'),
    processing.document.failed && plural(processing.document.failed, 'document-field window'),
    processing.verification.undecided && plural(processing.verification.undecided, 'undecided verification'),
  ].filter(Boolean)
  const partial = unified.items.filter((item) => item.partial > 0)
  const unresolvedContests = unified.competitors.filter((contest) => contest.outcome === 'unresolved')
  return (
    <section
      aria-label="Catalog review"
      className="mt-2 rounded-md border border-line bg-surface-muted px-2.5 py-2 text-[11.5px] leading-snug text-ink"
    >
      <p className="font-semibold">Catalog · {plural(unified.entries, 'entry', 'entries')} found</p>
      <p className="text-ink-muted">
        {unified.unresolved.length === 0
          ? 'Every nonblank source range was assigned to an entry or to text outside the entries.'
          : `${plural(unified.unresolved.length, 'source range')} could not be assigned to an entry.`}{' '}
        {unified.withheld.length > 0 && `${plural(unified.withheld.length, 'range')} the parser could not read were not processed. `}
        {failed.length === 0 ? 'Every required model call completed.' : `Not processed: ${failed.join(', ')}; values may be missing.`}{' '}
        {completeness.evidence ? 'Every accepted value was verifier-supported.' : 'Some values stay proposals or conflicts.'}{' '}
        Recall is not measured.
      </p>
      <List title={plural(unified.unresolved.length, 'unresolved source range')} items={unified.unresolved.map(where)} />
      <List title={plural(unified.withheld.length, 'unread source range')} items={unified.withheld.map(where)} />
      <List title={plural(unified.unsettledEntries.length, 'entry with an uncertain end', 'entries with an uncertain end')}
        items={unified.unsettledEntries.map((entry) => `${entry.label ?? entry.id}: ${entry.end === 'beyond_scope'
          ? 'continues past the processed source' : 'its end could not be confirmed'}`)} />
      <List title={plural(unified.sourceEndEntries?.length ?? 0, 'entry', 'entries')  + ' cut by the end of the supplied source'}
        items={(unified.sourceEndEntries ?? []).map((entry) => `${entry.label ?? entry.id}: its text continues past the last page supplied`)} />
      <List title={`${plural(unified.proposed.length, 'proposed value')} not accepted`} items={unified.proposed.map(label)} />
      <List title={plural(unified.rejected.length, 'rejected candidate')} items={unified.rejected.map(label)} />
      <List title={plural(unresolvedContests.length, 'unresolved conflict')}
        items={unresolvedContests.map((contest) => `${(contest.path as unknown[]).slice(2).join('.')}: ${(contest.candidates as { value: unknown }[]).map((c) => JSON.stringify(c.value)).join(' or ')}`)} />
      <List title={plural(partial.length, 'list with uncertain items', 'lists with uncertain items')}
        items={partial.map((item) => `${item.path.slice(2).join('.')} in entry ${Number(item.path[1]) + 1}: ${item.resolved} placed, ${item.partial} seen only in part (${item.observed} observed)`)} />
      {document.applicable && (
        <p className="mt-1 text-ink-muted">
          Document-level fields are read from every part of the source and stay unverified
          {document.conflicts.length > 0 ? `; ${plural(document.conflicts.length, 'field')} disagreed and ${document.conflicts.length === 1 ? 'is' : 'are'} left empty` : ''}.
        </p>
      )}
      <List title={plural(unified.contextOmitted.length, 'context range')  + ' left out to fit'}
        items={unified.contextOmitted.map((row) => `${row.kind} context for ${row.stage}${row.record === null ? '' : ` entry ${row.record + 1}`}: ${where(row)}`)} />
    </section>
  )
}
