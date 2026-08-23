import { Fragment, useEffect, useMemo, useState } from 'react'
import { exportExtractionResult } from 'extraction-result-export'
import ExtractionResultExportControl from './ExtractionResultExportControl'
import ResultValue, { singularItemLabel } from './ui/ResultValue'
import { Overline, SegmentedControl, Spinner, Button } from './ui'
import { isRecord } from '../shared/template'
import { schemaDefinitionToTemplate, type SchemaDefinition } from 'extraction/schema'
import { resultStats } from './resultStats'
import { extractionStateFromAttempt, type ExtractionController } from './useExtraction'
import type { ExtractionAttempt } from '../shared/extraction.contract'

type ResultsTabProps = {
  controller: ExtractionController
  onRunExtraction: () => void | Promise<void>
  runExtractionDisabled: boolean
  schemaReady: boolean
  documentMarkdown: string | null
  sourceDocumentName: string
  onSelectEvidence?: (anchorId: string) => void
  onResultPathChange?: (path: string[] | null) => void
  pinnedSchema?: SchemaDefinition | null
  /** Extraction Schema of the displayed Extraction Result; leads the export columns. */
  exportSchema?: SchemaDefinition | null
  inspectedAttempt?: ExtractionAttempt
  readOnly?: boolean
}

type View = 'review' | 'json' | 'markdown' | 'schema'

const preClasses =
  'scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink'

function summaryItem(label: string, value: string | number) {
  return (
    <span className="rounded-full border border-line bg-surface-muted px-2 py-1 text-[11px] font-semibold text-ink-muted">
      {label}: <span className="font-mono text-ink">{value}</span>
    </span>
  )
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
    <details className="mt-1 rounded-md border border-line bg-surface-muted px-2.5 py-1.5 text-[11px] text-ink-muted">
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
  diagnostics: NonNullable<ExtractionAttempt['diagnostics']['grounding']>
}) {
  return (
    <section className="mt-3 border-t border-line pt-2.5" aria-label="Grounding diagnostics">
      <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">
        Grounding batches
      </p>
      <div className="mt-1.5 space-y-1.5">
        {diagnostics.batches.map((batch, index) => (
          <div key={`${index}-${batch.resultPath?.join('.') ?? 'run'}`} className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5">
            <p className="text-[11.5px] text-ink">
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
  return (
    <section aria-label="Extraction diagnostics">
      <div className="mt-2 space-y-2">
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">
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
            identity={[["Phase", diagnostics.phase]]}
          />
          {diagnostics.grounding && <GroundingDiagnostics diagnostics={diagnostics.grounding} />}
      </div>
    </section>
  )
}

function AttemptDetails({ attempt }: { attempt: ExtractionAttempt }) {
  return (
    <details className="mt-3 border-t border-line pt-2.5">
      <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">
        Run details
      </summary>
      <div className="scrollbar-subtle max-h-64 overflow-y-auto pr-1">
        <ExtractionDiagnostics attempt={attempt} />
      </div>
    </details>
  )
}

function getAtPath(obj: unknown, path: string[]): unknown {
  return path.reduce(
    (cur, key) =>
      Array.isArray(cur) ? cur[parseInt(key, 10)] :
      isRecord(cur) ? (cur as Record<string, unknown>)[key] :
      undefined,
    obj,
  )
}

function ResultsTab({ controller, onRunExtraction, runExtractionDisabled, schemaReady, documentMarkdown, sourceDocumentName, pinnedSchema = null, exportSchema = null, inspectedAttempt, readOnly = false, onSelectEvidence, onResultPathChange }: ResultsTabProps) {
  const attempt = inspectedAttempt ?? controller.attempt
  const state = inspectedAttempt
    ? extractionStateFromAttempt(inspectedAttempt)
    : controller.state
  const [view, setView] = useState<View>('review')
  const articleRecords =
    state.status === 'ready' &&
    isRecord(state.result) &&
    Array.isArray(state.result.records)
      ? state.result.records
      : null
  const articlePathPrefix = useMemo(
    () =>
      articleRecords
        ? articleRecords.length === 1
          ? ['records', '0']
          : ['records']
        : [],
    [articleRecords],
  )
  const displayResult =
    articleRecords?.length === 1
      ? articleRecords[0]
      : articleRecords ?? (state.status === 'ready' ? state.result : null)
  const stats = useMemo(
    () => (displayResult !== null ? resultStats(displayResult) : null),
    [displayResult],
  )

  const [navPath, setNavPath] = useState<string[]>([])
  const [backStack, setBackStack] = useState<string[][]>([])
  const [forwardStack, setForwardStack] = useState<string[][]>([])

  useEffect(
    () => onResultPathChange?.(
      view === 'review' ? [...articlePathPrefix, ...navPath] : null,
    ),
    [articlePathPrefix, navPath, onResultPathChange, view],
  )
  const evidenceAnchorIdByPath = useMemo(
    () =>
      new Map(
        state.status === 'ready'
          ? state.evidenceLinks.map((link) => [
              JSON.stringify(
                link.resultPath.map(String).slice(articlePathPrefix.length),
              ),
              link.evidenceAnchorId,
            ])
          : [],
      ),
    [articlePathPrefix.length, state],
  )

  function navTo(newPath: string[]) {
    setBackStack(prev => [...prev, navPath])
    setForwardStack([])
    setNavPath(newPath)
  }

  function clearNavigation() {
    setNavPath([])
    setBackStack([])
    setForwardStack([])
  }

  function goBack() {
    if (backStack.length === 0) return
    const prev = backStack[backStack.length - 1]
    setForwardStack(f => [...f, navPath])
    setNavPath(prev)
    setBackStack(b => b.slice(0, -1))
  }

  function goForward() {
    if (forwardStack.length === 0) return
    const next = forwardStack[forwardStack.length - 1]
    setBackStack(b => [...b, navPath])
    setNavPath(next)
    setForwardStack(f => f.slice(0, -1))
  }

  const currentEntries = useMemo((): Array<{ pathKey: string; displayName: string; value: unknown }> => {
    const node = navPath.length === 0 ? displayResult : (displayResult ? getAtPath(displayResult, navPath) : null)
    if (Array.isArray(node)) return node.map((v, i) => ({ pathKey: String(i), displayName: singularItemLabel(navPath[navPath.length - 1] ?? 'item', i), value: v }))
    if (isRecord(node)) return Object.entries(node as Record<string, unknown>).map(([k, v]) => ({ pathKey: k, displayName: k, value: v }))
    return []
  }, [displayResult, navPath])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-9.5 shrink-0 items-center gap-2 border-b border-line px-4">
        <Overline as="h2">Extraction results</Overline>
      </header>

      {state.status === 'ready' && stats && (
        <>
          <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {summaryItem(
                'Status',
                attempt?.complete === false ? 'incomplete' : 'ready',
              )}
              {attempt && summaryItem('Strategy', attempt.strategy.toLowerCase())}
              {summaryItem('Fields', stats.fields)}
              {summaryItem('Missing', stats.missing)}
              {summaryItem('Grounded', state.evidenceLinks.length)}
              {stats.arrayItems > 0 && summaryItem('Array items', stats.arrayItems)}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <SegmentedControl
                aria-label="Result view"
                value={view}
                onChange={setView}
                options={[
                  { value: 'review', label: 'Review' },
                  { value: 'json', label: 'Raw JSON' },
                  { value: 'markdown', label: 'Markdown' },
                  ...(pinnedSchema ? [{ value: 'schema' as const, label: 'Pinned schema' }] : []),
                ]}
              />
              <div className="flex gap-1.5">
                <ExtractionResultExportControl
                  schema={exportSchema}
                  disabled={displayResult === null}
                  onExport={async (format, choices) => {
                    if (displayResult === null || exportSchema === null) return
                    await exportExtractionResult(displayResult, {
                      format,
                      filename: sourceDocumentName,
                      schemaNodes: exportSchema.schemaNodes,
                      choices,
                    })
                  }}
                />
                {!readOnly && controller.review.available && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!controller.review.canAccept}
                    title={
                      controller.review.reviewedExtractionId
                        ? 'This result is already saved with its Review Decisions'
                        : state.ungroundedCount > 0
                          ? 'Save this review; values without Evidence remain explicitly ungrounded'
                          : 'Save this result and its reviewed Evidence to the Source Representation'
                    }
                    onClick={() => void controller.review.accept()}
                  >
                    {controller.review.reviewedExtractionId
                      ? 'Review saved'
                      : controller.review.saving
                        ? 'Saving…'
                        : 'Save Review'}
                  </Button>
                )}
                {!readOnly && (
                  <Button variant="secondary" size="sm" disabled={runExtractionDisabled} onClick={() => void onRunExtraction()}>
                    Rerun
                  </Button>
                )}
              </div>
            </div>
            {attempt?.complete === false && (
              <div
                className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-snug text-amber-900"
                role="status"
              >
                <p className="font-semibold">Incomplete Extraction</p>
                <p>
                  Successful values remain visible. See the persisted stage
                  diagnostics for details.
                </p>
              </div>
            )}
            {!readOnly && !inspectedAttempt && controller.stale && (
              <div
                className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-snug text-amber-900"
                role="status"
              >
                <p className="font-semibold">Extraction Schema updated</p>
                <p>This Extraction Result was produced with a previous Extraction Schema.</p>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-1.5"
                  disabled={runExtractionDisabled}
                  onClick={() => void onRunExtraction()}
                >
                  Re-run extraction
                </Button>
              </div>
            )}
            {controller.review.error && (
              <p role="alert" className="mt-2 text-[11.5px] leading-snug text-danger">
                {controller.review.error}
              </p>
            )}
            {state.ungroundedCount > 0 && (
              <p className="mt-2 text-[11.5px] leading-snug text-ink-muted">
                {state.ungroundedCount} value{state.ungroundedCount === 1 ? '' : 's'} could not be grounded. You can still save the review; {state.ungroundedCount === 1 ? 'it' : 'they'} will remain recorded without Evidence.
              </p>
            )}
            {attempt && <AttemptDetails attempt={attempt} />}
          </div>

          {view === 'review' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {/* Breadcrumb bar — always visible */}
              <nav aria-label="Result navigation" className="flex shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2 py-1">
                <button
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[13px] font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30"
                  type="button"
                  title="Back"
                  disabled={backStack.length === 0}
                  onClick={goBack}
                >‹</button>
                <button
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[13px] font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30"
                  type="button"
                  title="Forward"
                  disabled={forwardStack.length === 0}
                  onClick={goForward}
                >›</button>
                <span className="mx-1 h-3.5 w-px shrink-0 bg-line" />
                <div className="scrollbar-subtle flex min-w-0 flex-1 items-center overflow-x-auto">
                  <button
                    aria-current={navPath.length === 0 ? 'page' : undefined}
                    className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[12px] font-semibold text-accent hover:bg-accent-ghost/40 disabled:cursor-default disabled:text-ink"
                    type="button"
                    disabled={navPath.length === 0}
                    onClick={() => navTo([])}
                  >Root</button>
                  {navPath.map((seg, i) => {
                    const idx = parseInt(seg, 10)
                    const label = !isNaN(idx) && String(idx) === seg ? singularItemLabel(navPath[i - 1] ?? 'item', idx) : seg
                    return (
                      <span key={i} className="flex items-center gap-0.5">
                        <span className="text-[11px] text-ink-faint">›</span>
                        {i < navPath.length - 1 ? (
                          <button
                            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[12px] font-semibold text-ink-muted hover:text-accent"
                            type="button"
                            onClick={() => navTo(navPath.slice(0, i + 1))}
                          >{label}</button>
                        ) : (
                          <span aria-current="page" className="shrink-0 px-1.5 py-0.5 text-[12px] font-semibold text-ink">{label}</span>
                        )}
                      </span>
                    )
                  })}
                </div>
                {navPath.length > 0 && (
                  <>
                    <span className="mx-1 h-3.5 w-px shrink-0 bg-line" />
                    <button
                      className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[11.5px] font-semibold text-ink-muted hover:bg-accent-ghost/40 hover:text-accent"
                      type="button"
                      title="Return to root"
                      onClick={clearNavigation}
                    >Clear</button>
                  </>
                )}
              </nav>
              {/* Content */}
              <div className="scrollbar-subtle min-h-0 flex-1 overflow-auto bg-canvas px-3 py-2">
                {currentEntries.map(({ pathKey, displayName, value: val }) => (
                  <ResultValue
                    key={pathKey}
                    name={displayName}
                    value={val}
                    path={[...navPath, pathKey]}
                    onNavigateTo={isRecord(val) || Array.isArray(val) ? navTo : undefined}
                    defaultExpanded={false}
                    expandText={navPath.length > 0}
                    getEvidenceAnchorId={(path) =>
                      evidenceAnchorIdByPath.get(JSON.stringify(path))
                    }
                    onSelectEvidence={onSelectEvidence}
                  />
                ))}
              </div>
            </div>
          )}

          {view === 'json' && <pre className={preClasses}>{JSON.stringify(displayResult, null, 2)}</pre>}

          {view === 'schema' && pinnedSchema && (
            <pre className={preClasses}>{JSON.stringify(schemaDefinitionToTemplate({ recordDescription: pinnedSchema.recordDescription, schemaNodes: pinnedSchema.schemaNodes }), null, 2)}</pre>
          )}

          {view === 'markdown' && (
            <div className="flex min-h-0 flex-1 flex-col">
              {documentMarkdown ? (
                <pre className={preClasses}>{documentMarkdown}</pre>
              ) : (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
                  <p className="text-[13px] font-semibold text-ink">Markdown unavailable</p>
                  <p className="mt-1.5 max-w-[34ch] text-[11.5px] leading-snug text-ink-muted">
                    Parsed Markdown has not been received for this source document.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {state.status === 'running' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          <Spinner
            label="Running Article extraction…"
            hint="The server is extracting values, grounding Evidence, and saving the terminal attempt."
          />
        </div>
      )}

      {state.status === 'error' && (
        <div className="m-3.25 rounded-xl border border-danger/40 bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-danger">Extraction failed</p>
          <p className="mt-1 wrap-anywhere text-[12px] leading-snug text-ink-muted">{state.message}</p>
          {!readOnly && (
            <Button variant="primary" size="md" className="mt-2.5" disabled={runExtractionDisabled} onClick={() => void onRunExtraction()}>
              Retry extraction
            </Button>
          )}
          {attempt && <AttemptDetails attempt={attempt} />}
        </div>
      )}

      {state.status === 'idle' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-[13.5px] font-semibold text-ink">No results yet</p>
          <p className="mt-1.5 max-w-[34ch] text-[11.5px] leading-snug text-ink-muted">
            {schemaReady
              ? 'Run extraction to apply the schema across the source document.'
              : 'Generate a schema in the Schema tab first, then run extraction.'}
          </p>
          {!readOnly && (
            <Button
              variant="primary"
              size="md"
              className="mt-4"
              disabled={runExtractionDisabled}
              onClick={() => void onRunExtraction()}
            >
              {schemaReady ? 'Run extraction' : 'Generate a schema first'}
            </Button>
          )}
        </div>
      )}

      {state.status === 'cancelled' && (
        <div className="m-3.25 rounded-xl border border-line bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-ink">Extraction cancelled</p>
          {!readOnly && <Button variant="primary" size="md" className="mt-2.5" disabled={runExtractionDisabled} onClick={() => void onRunExtraction()}>
            Run a new extraction
          </Button>}
          {attempt && <AttemptDetails attempt={attempt} />}
        </div>
      )}
    </div>
  )
}

export default ResultsTab
