import { Fragment, useEffect, useRef, useState, type RefObject } from 'react'
import { schemaDefinitionToTemplate, type SchemaDefinition } from 'extraction/schema'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { CatalogReview } from './CatalogReview'
import { MethodUsed } from './MethodUsed'
import { RecipeReview } from './RecipeReview'
import { fieldLabel, reasonText } from './claimStates'
import { CloseGlyph } from './ui/icons'
import { Overline } from './ui'

function outcomeLabel(outcome: string) {
  return outcome.replaceAll('_', ' ')
}

type DiagnosticCall = {
  outcome: string
  finishReason: string | null
  calls?: number
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number
  failureCode?: string | null
}

function DiagnosticDetails({
  diagnostic,
  identity,
}: {
  diagnostic: DiagnosticCall
  identity?: Array<[string, string | number]>
}) {
  return (
    <details className="mt-1 rounded-md border border-line bg-surface-muted px-2.5 py-1.5 text-compact text-ink-muted">
      <summary className="cursor-pointer font-semibold text-ink">Technical details</summary>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {identity?.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd className="font-mono text-ink">{value}</dd>
          </Fragment>
        ))}
        <dt>Finish reason</dt>
        <dd className="font-mono text-ink">{diagnostic.finishReason ?? '—'}</dd>
        {diagnostic.calls !== undefined && (
          <>
            <dt>Calls</dt>
            <dd className="font-mono text-ink">{diagnostic.calls}</dd>
          </>
        )}
        <dt>Input tokens</dt>
        <dd className="font-mono text-ink">{diagnostic.inputTokens ?? '—'}</dd>
        <dt>Output tokens</dt>
        <dd className="font-mono text-ink">{diagnostic.outputTokens ?? '—'}</dd>
        <dt>Duration / latency</dt>
        <dd className="font-mono text-ink">{diagnostic.durationMs} ms</dd>
        <dt>Failure code</dt>
        <dd className="font-mono text-ink">{diagnostic.failureCode ?? '—'}</dd>
      </dl>
    </details>
  )
}

function GroundingDiagnostics({
  diagnostics,
}: {
  diagnostics: NonNullable<NonNullable<ExtractionAttempt['diagnostics']>['grounding']>
}) {
  return (
    <section className="mt-3 border-t border-line pt-2.5" aria-label="Grounding diagnostics">
      <p className="text-compact font-bold uppercase tracking-[0.08em] text-ink-muted">
        Grounding batches
      </p>
      <div className="mt-1.5 space-y-1.5">
        {diagnostics.batches.map((batch, index) => (
          <div key={`${index}-${batch.resultPath?.join('.') ?? 'run'}`} className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5">
            <p className="text-compact text-ink">
              Batch {index + 1} · {batch.outcome} · {batch.candidateCount} candidate{batch.candidateCount === 1 ? '' : 's'}
            </p>
            <DiagnosticDetails diagnostic={batch} identity={batch.resultPath ? [['Result path', batch.resultPath.join('.')] ] : undefined} />
          </div>
        ))}
      </div>
    </section>
  )
}

function ExtractionDiagnostics({ attempt }: { attempt: ExtractionAttempt }) {
  const diagnostics = attempt.diagnostics
  if (!diagnostics)
    return <p className="text-compact text-ink-muted">Diagnostics are not available yet.</p>
  const catalog = diagnostics.catalog
  return (
    <section aria-label="Extraction diagnostics">
      <div className="mt-2 space-y-2">
        <p className="text-compact font-bold uppercase tracking-[0.08em] text-ink-muted">
          Extraction diagnostics
        </p>
          <DiagnosticDetails
            diagnostic={{
              outcome: 'succeeded',
              finishReason: diagnostics.finishReason,
              inputTokens: diagnostics.inputTokens,
              outputTokens: diagnostics.outputTokens,
              durationMs: diagnostics.durationMs,
              failureCode: null,
              calls: diagnostics.modelCalls,
            }}
            identity={[
              ['Phase', diagnostics.phase],
              // The model each role ran on, as kei-exp resolved the run's choice over its defaults.
              ...(diagnostics.models
                ? [['Field model', diagnostics.models.fields], ['Reasoning model', diagnostics.models.reasoning]] as Array<[string, string]>
                : []),
            ]}
          />
          {catalog && (
            <div className="space-y-2" aria-label="Catalog diagnostics">
              <p className="text-compact font-semibold text-ink">Catalog stages</p>
              {catalog.stages.map((stage) => (
                <div
                  key={stage.stage}
                  aria-label={`Catalog stage ${stage.stage}: ${stage.outcome}, ${stage.provenance}`}
                  className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5"
                >
                  <p className="text-compact text-ink">
                    {stage.stage} · {outcomeLabel(stage.outcome)} · {stage.provenance}
                  </p>
                  <DiagnosticDetails diagnostic={stage} />
                </div>
              ))}
              <p className="text-compact font-semibold text-ink">Catalog records</p>
              <div
                data-testid="catalog-record-diagnostics"
                className="max-h-48 space-y-1.5 overflow-y-auto pr-1"
              >
                {catalog.records.map((record) => (
                  <div
                    key={record.ordinal}
                    aria-label={`Catalog record ${record.ordinal + 1}: ${record.outcome}, ${record.provenance}, ${record.boundary.headingText}`}
                    className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5"
                  >
                    <p className="text-compact text-ink">
                      Record {record.ordinal + 1} · {outcomeLabel(record.outcome)} · {record.provenance} · {record.boundary.headingText}
                    </p>
                    <p className="text-compact text-ink-muted">
                      Canonical {record.boundary.startContentIndex}–{record.boundary.endContentIndex}
                      {record.boundary.headingLevel !== null && ` · heading level ${record.boundary.headingLevel}`}
                    </p>
                    <DiagnosticDetails
                      diagnostic={record}
                      identity={[
                        ['Record identity', record.boundary.startBlockId],
                        ['Record start', record.boundary.headingText],
                        ['Canonical start', record.boundary.startContentIndex],
                        ['Canonical end', record.boundary.endContentIndex],
                        ['Heading level', record.boundary.headingLevel ?? 'Not a heading'],
                      ]}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          {diagnostics.grounding && <GroundingDiagnostics diagnostics={diagnostics.grounding} />}
      </div>
    </section>
  )
}

export type DrawerSection = 'extraction' | 'schema' | null

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const linkButton = 'cursor-pointer rounded px-1 -ml-1 text-secondary font-semibold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent'

/**
 * Run details (results review redesign §8): a panel over the rail, not modal: Escape closes it (the rail's key order),
 * focus moves to its heading on open and back to its opener on close. The Extraction, Schema, Evidence, Review and
 * Method sections hold what the old header and Completion lines said, and the run's own review panels.
 */
export default function RunDetailsDrawer({ attempt, section, recordCount, usedSchema, usedRevision, currentRevision, linkCounts,
  doubtful, review, returnFocusRef, recordsInResult, onShowValue, onClose }: {
  attempt: ExtractionAttempt
  section: DrawerSection
  recordCount: number
  usedSchema: SchemaDefinition | null
  usedRevision: number | null
  currentRevision: number | null
  linkCounts: { verifier: number; rule: number }
  doubtful: number
  review: string
  returnFocusRef: RefObject<HTMLElement | null>
  recordsInResult: number
  onShowValue: (resultPath: readonly (string | number)[]) => void
  onClose: () => void
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  const extractionRef = useRef<HTMLDivElement>(null)
  const schemaRef = useRef<HTMLDivElement>(null)
  const [schemaShown, setSchemaShown] = useState(section === 'schema')
  const [methodShown, setMethodShown] = useState(false)
  useEffect(() => {
    if (section) (section === 'schema' ? schemaRef : extractionRef).current?.scrollIntoView?.({ block: 'start' })
    headingRef.current?.focus()
    const opener = returnFocusRef.current
    return () => { if (opener?.isConnected) opener.focus() }
    // Focus moves once per opening; the section is the opener's choice at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const claims = attempt.diagnostics?.grounding?.claims ?? null
  const cut = attempt.diagnostics?.unified?.sourceEndEntries?.length ?? 0
  const outcome = attempt.executionStatus === 'FAILED' ? 'Failed' : attempt.complete === false ? 'Completed, not all of it' : 'Completed'
  return (
    <div role="dialog" aria-label="Run details" className="absolute inset-0 z-30 flex flex-col bg-surface">
      <div className="flex h-11 shrink-0 items-center border-b border-line pr-2 pl-4">
        <h2 ref={headingRef} tabIndex={-1} className="m-0 text-content font-bold text-ink outline-none">Run details</h2>
        <span className="flex-1" />
        <button type="button" aria-label="Close run details" onClick={onClose}
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-ink-muted hover:bg-surface-muted hover:text-ink"><CloseGlyph /></button>
      </div>
      <div className="scrollbar-subtle flex-1 overflow-auto text-secondary text-ink [&>div]:border-b [&>div]:border-line [&>div]:px-4 [&>div]:py-3 [&_p]:m-0 [&_p+p]:mt-1">
        <div ref={extractionRef}>
          <Overline as="h3" className="mb-1.5 block">Extraction</Overline>
          <p>{outcome} · {attempt.strategy === 'ARTICLE' ? 'Article' : 'Catalog'} strategy · {plural(recordCount, 'record')} found</p>
          <p className="text-ink-muted">How many records the source holds is not measured, so a missing record would not show here.</p>
          {attempt.diagnostics?.grounding?.issueCodes.includes('text_truncated') &&
            <p className="text-ink-muted">Some extraction calls omitted source text because of their text budget; affected values may be missing.</p>}
          {cut > 0 && <p className="text-ink-muted">{plural(cut, 'record')} cut off where the supplied source ends, so some of its values may be missing.</p>}
          {attempt.diagnostics?.grounded && <RecipeReview grounded={attempt.diagnostics.grounded} />}
          {attempt.diagnostics?.unified && <CatalogReview unified={attempt.diagnostics.unified} />}
        </div>
        <div ref={schemaRef}>
          <Overline as="h3" className="mb-1.5 block">Schema</Overline>
          <p>Revision {usedRevision ?? '…'} · {currentRevision === null || currentRevision === usedRevision ? 'the current revision' : `current is ${currentRevision}`}</p>
          <button type="button" aria-expanded={schemaShown} className={linkButton} disabled={!usedSchema} onClick={() => setSchemaShown((shown) => !shown)}>View schema used</button>
          {schemaShown && usedSchema && (
            <pre className="scrollbar-subtle mt-1.5 max-h-56 overflow-auto rounded-md border border-line bg-canvas px-3 py-2 font-mono text-compact">
              {JSON.stringify(schemaDefinitionToTemplate({ recordDescription: usedSchema.recordDescription, schemaNodes: usedSchema.schemaNodes }), null, 2)}
            </pre>
          )}
        </div>
        <div>
          <Overline as="h3" className="mb-1.5 block">Evidence{claims ? ` · ${claims.claims} claims` : ''}</Overline>
          <p className="tabular-nums">{linkCounts.verifier} verifier-supported · {linkCounts.rule} linked by rule</p>
          <p className="text-ink-muted tabular-nums">{doubtful} of the linked values have a doubtful link: the value isn’t found in its passage, or is found in other passages too.</p>
          {claims ? (
            <>
              <p className="tabular-nums">{claims.unsupported} unsupported · {claims.notCompleted} not completed · {claims.excluded} excluded by policy</p>
              <p className="text-ink-muted">Linked by rule: a key or structure rule linked it, and no verifier checked it. A link is never a judgement that the value is right; that is your decision.</p>
              {claims.unfinished.length > 0 && (
                <details className="mt-1.5">
                  <summary className="cursor-pointer font-semibold">Checks not completed ({claims.unfinished.length})</summary>
                  <ul className="m-0 mt-1 list-none space-y-1 p-0">
                    {claims.unfinished.map(({ resultPath, reasons }) => {
                      const label = fieldLabel(resultPath, recordsInResult)
                      return (
                        <li key={JSON.stringify(resultPath)} className="flex flex-wrap items-baseline gap-x-2">
                          <span className="font-mono">{label}</span>
                          <span className="text-ink-muted">{reasons.map(reasonText).join('; ')}</span>
                          <button type="button" className={linkButton} onClick={() => onShowValue(resultPath)}>Show {label}</button>
                        </li>
                      )
                    })}
                  </ul>
                </details>
              )}
            </>
          ) : <p className="text-ink-muted">This run kept no claim accounting.</p>}
        </div>
        <div>
          <Overline as="h3" className="mb-1.5 block">Review</Overline>
          <p className="tabular-nums">{review}</p>
          <p className="text-ink-muted">The review saves itself, and becomes read-only, once every linked value has a decision. Values that aren’t linked never block it.</p>
        </div>
        <div>
          <Overline as="h3" className="mb-1.5 block">Method</Overline>
          <button type="button" aria-expanded={methodShown} className={linkButton} onClick={() => setMethodShown((shown) => !shown)}>Show the method used</button>
          {methodShown && <><MethodUsed attempt={attempt} /><ExtractionDiagnostics attempt={attempt} /></>}
        </div>
      </div>
    </div>
  )
}
