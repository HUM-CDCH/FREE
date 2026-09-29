import { useId } from 'react'
import { CATALOG_RECIPES } from '../shared/catalogRecipes'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { methodLines, modelsLine, settingsHeadline } from './methodSummary'

const VERSION_LABELS: Readonly<Record<string, string>> = {
  prompt: 'Prompt', method: 'Method', spanGrounding: 'Span grounding', groundingRouting: 'Grounding routing',
  rendering: 'Rendering', grouping: 'Grouping', selection: 'Selection',
}
const ELIGIBLE: Readonly<Record<'complete' | 'partial' | 'not_applicable', string>> = {
  complete: 'All eligible values grounded', partial: 'Some eligible values ungrounded', not_applicable: 'Not applicable: no value was eligible',
}

/** What an Extraction was admitted with, beside what the Parsing Service reports it ran. Recorded values only: a
 *  run without a record says so and never borrows today's account configuration. */
export function MethodUsed({ attempt }: { attempt: ExtractionAttempt }) {
  const headingId = useId()
  const requested = attempt.requestedSettings ?? null
  const effective = attempt.diagnostics?.effectiveMethod ?? null
  const eligibility = attempt.diagnostics?.eligibility ?? null
  const strategy = attempt.strategy === 'CATALOG'
    ? requested && 'unified' in requested ? 'Catalog' : `Catalog · ${attempt.catalogRecipe
      ? CATALOG_RECIPES.find((recipe) => recipe.id === attempt.catalogRecipe)?.label ?? attempt.catalogRecipe
      : 'Model discovery'}` : 'Article'
  return (
    <section aria-labelledby={headingId} className="mb-3 flex flex-col gap-1.5 text-[11.5px]">
      <p id={headingId} className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">Method used</p>
      <div>
        <p className="font-semibold text-ink">Requested</p>
        <p className="text-ink">{strategy} · <span>{settingsHeadline(requested)}</span></p>
        <p className="text-ink-muted">{modelsLine(attempt.requestedModels ?? null)}</p>
        {methodLines(requested).length > 0 && (
          <details className="text-[11px] text-ink-muted">
            <summary className="cursor-pointer">Settings</summary>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3">
              {methodLines(requested).map((line) => [<dt key={`${line.label}-t`}>{line.label}</dt>, <dd key={`${line.label}-d`} className="text-ink">{line.value}</dd>])}
            </dl>
          </details>
        )}
      </div>
      <div>
        <p className="font-semibold text-ink">Effective</p>
        {attempt.executionStatus === 'FAILED' ? <p className="text-ink">Effective method unavailable</p>
          : attempt.executionStatus !== 'COMPLETED' ? <p className="text-ink-muted">Not reported yet</p>
          : effective === null ? <p className="text-ink">Not recorded</p>
          : <>
              {attempt.diagnostics?.models && <p className="text-ink">Field values ran on {attempt.diagnostics.models.fields} · Reasoning on {attempt.diagnostics.models.reasoning}</p>}
              <p className="text-ink-muted">Versions: <span className="text-ink">{Object.entries(effective.versions).map(([key, version]) => `${VERSION_LABELS[key] ?? key} ${version}`).join(' · ')}</span></p>
              <details className="text-[11px] text-ink-muted">
                <summary className="cursor-pointer">Technical details</summary>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono">{JSON.stringify(effective.options, null, 2)}</pre>
              </details>
            </>}
        {eligibility && (
          <p className="text-ink-muted">
            Eligible values: {eligibility.eligibleRecordLeaves} of {eligibility.allRecordLeaves} populated record values; {eligibility.skipped.length} skipped by schema policy. <span className="text-ink">{ELIGIBLE[eligibility.eligibleGrounding]}</span>
          </p>
        )}
      </div>
      <p className="text-[10.5px] text-ink-faint">Effective options and versions are what the Parsing Service reported for this run. Equal settings are not a promise of identical output on another runtime.</p>
    </section>
  )
}
