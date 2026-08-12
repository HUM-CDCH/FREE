import { Fragment, useEffect, useMemo, useState } from 'react'
import ResultValue from './ui/ResultValue'
import { Overline, SegmentedControl, Spinner, Button } from './ui'
import { isRecord } from '../shared/template'
import { schemaDefinitionToTemplate, type SchemaDefinition } from '../shared/schemaNode'
import { resultStats } from './resultStats'
import { extractionStateFromAttempt, type ExtractionController } from './useExtraction'
import type { ExtractionAttempt, ExtractionRetrySelection } from '../shared/extraction.contract'

type ResultsTabProps = {
  controller: ExtractionController
  schemaReady: boolean
  documentMarkdown: string | null
  onSelectEvidence?: (anchorId: string) => void
  onResultPathChange?: (path: string[] | null) => void
  pinnedSchema?: SchemaDefinition | null
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

function outcomeLabel(outcome: string) {
  return outcome.replaceAll('_', ' ')
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
  const catalog = diagnostics.catalog
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
          {diagnostics.values && (
            <div>
              <p className="text-[11.5px] font-semibold text-ink">Values call</p>
              <DiagnosticDetails diagnostic={diagnostics.values} />
            </div>
          )}
          {catalog && (
            <div className="space-y-2" aria-label="Catalog diagnostics">
              <p className="text-[11.5px] font-semibold text-ink">Catalog stages</p>
              {catalog.stages.map((stage) => (
                <div key={stage.stage} className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5">
                  <p className="text-[11.5px] text-ink">
                    {stage.stage} · {outcomeLabel(stage.outcome)}
                  </p>
                  <DiagnosticDetails diagnostic={stage} />
                </div>
              ))}
              <p className="text-[11.5px] font-semibold text-ink">Catalog records</p>
              <div
                data-testid="catalog-record-diagnostics"
                className="max-h-48 space-y-1.5 overflow-y-auto pr-1"
              >
                {catalog.records.map((record) => (
                  <div key={record.ordinal} className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5">
                    <p className="text-[11.5px] text-ink">
                      Record {record.ordinal + 1} · {outcomeLabel(record.outcome)} · {record.boundary.headingText}
                    </p>
                    <p className="text-[11px] text-ink-muted">
                      Canonical {record.boundary.startContentIndex}–{record.boundary.endContentIndex} · heading level {record.boundary.headingLevel}
                    </p>
                    <DiagnosticDetails
                      diagnostic={record}
                      identity={[
                        ['Record identity', record.boundary.startBlockId],
                        ['Heading', record.boundary.headingText],
                        ['Canonical start', record.boundary.startContentIndex],
                        ['Canonical end', record.boundary.endContentIndex],
                        ['Heading level', record.boundary.headingLevel],
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

type RetrySelection = Omit<ExtractionRetrySelection, 'retryOfId'>

const emptyRetrySelection: RetrySelection = {
  retryDocument: false,
  rediscover: false,
  retryRecordStartBlockIds: [],
}

function CatalogRetryControls({
  controller,
  attempt,
}: {
  controller: ExtractionController
  attempt: ExtractionAttempt
}) {
  const catalog = attempt.strategy === 'CATALOG' ? attempt.diagnostics.catalog : null
  const [selection, setSelection] = useState<RetrySelection>(emptyRetrySelection)

  if (!catalog || attempt.outcome === 'CANCELLED') return null
  const documentStage = catalog.stages.find((stage) => stage.stage === 'document-values')
  const discoveryStage = catalog.stages.find((stage) => stage.stage === 'discovery')
  // The server accepts document retries only for a failed document-values stage.
  const retryDocument = documentStage?.outcome === 'failed'
  const rediscover =
    discoveryStage?.outcome === 'failed' ||
    discoveryStage?.finishReason === 'length'
  const records = catalog.records.filter(
    (record) => record.outcome === 'failed' || record.outcome === 'not_attempted',
  )
  const canGroundOnly = attempt.outcome === 'SUCCEEDED' && attempt.resultPayload !== null
  if (!retryDocument && !rediscover && records.length === 0 && !canGroundOnly) return null

  const active = controller.state.status === 'running'
  const selectedCount = selection.retryRecordStartBlockIds.length
  const canRetrySelected = selection.retryDocument || selection.rediscover || selectedCount > 0
  const submit = (next: RetrySelection) => {
    void controller.retryExtraction(next)
  }

  return (
    <section
      aria-label="Targeted Catalog retry"
      className="mt-3 border-t border-line pt-2.5"
    >
        <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">
          Retry failed Catalog components
        </p>
        <p className="mt-1.5 text-[11.5px] leading-snug text-ink-muted">
          Select failed or truncated work to execute again. Leave every box clear for grounding only; successful components are reused.
        </p>
        <div className="mt-2 space-y-1.5 text-[11.5px] text-ink">
          {retryDocument && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label="Retry failed or truncated document metadata"
                checked={selection.retryDocument}
                disabled={active}
                onChange={(event) =>
                  setSelection((current) => ({ ...current, retryDocument: event.target.checked }))
                }
              />
              <span>Document metadata (failed or truncated)</span>
            </label>
          )}
          {rediscover && (
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                aria-label="Rediscover Catalog record boundaries"
                checked={selection.rediscover}
                disabled={active}
                onChange={(event) =>
                  setSelection((current) => ({ ...current, rediscover: event.target.checked }))
                }
              />
              <span>Rediscover record boundaries (and rerun dependent records)</span>
            </label>
          )}
          {records.map((record) => {
            const id = record.boundary.startBlockId
            const checked = selection.retryRecordStartBlockIds.includes(id)
            return (
              <label key={id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  aria-label={`Retry record ${record.ordinal + 1}: ${record.boundary.headingText}`}
                  checked={checked}
                  disabled={active}
                  onChange={(event) =>
                    setSelection((current) => ({
                      ...current,
                      retryRecordStartBlockIds: event.target.checked
                        ? [...current.retryRecordStartBlockIds, id]
                        : current.retryRecordStartBlockIds.filter((candidate) => candidate !== id),
                    }))
                  }
                />
                <span>
                  Record {record.ordinal + 1}: {record.boundary.headingText} ({outcomeLabel(record.outcome)})
                </span>
              </label>
            )
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Button
            variant="primary"
            size="sm"
            disabled={active || !canRetrySelected}
            onClick={() => submit(selection)}
          >
            Retry selected components
          </Button>
          {canGroundOnly && (
            <Button
              variant="secondary"
              size="sm"
              disabled={active}
              onClick={() => submit(emptyRetrySelection)}
            >
              Grounding only
            </Button>
          )}
        </div>
    </section>
  )
}

function AttemptDetails({
  controller,
  attempt,
  readOnly,
}: {
  controller: ExtractionController
  attempt: ExtractionAttempt
  readOnly: boolean
}) {
  return (
    <details className="mt-3 border-t border-line pt-2.5">
      <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">
        Run details
      </summary>
      <div className="scrollbar-subtle max-h-64 overflow-y-auto pr-1">
        <ExtractionDiagnostics attempt={attempt} />
        {!readOnly && attempt.strategy === 'CATALOG' && (
          <CatalogRetryControls key={attempt.extractionId} controller={controller} attempt={attempt} />
        )}
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

function ResultsTab({ controller, schemaReady, documentMarkdown, pinnedSchema = null, inspectedAttempt, readOnly = false, onSelectEvidence, onResultPathChange }: ResultsTabProps) {
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
    if (Array.isArray(node)) return node.map((v, i) => ({ pathKey: String(i), displayName: `Item ${i + 1}`, value: v }))
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
                {!readOnly && controller.review.available && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!controller.review.canAccept}
                    title={
                      controller.review.reviewedExtractionId
                        ? 'This result is already saved with its Review Decisions'
                        : 'Save this result and its reviewed Evidence to the Source Representation'
                    }
                    onClick={() => void controller.review.accept()}
                  >
                    {controller.review.reviewedExtractionId
                      ? 'Review saved'
                      : controller.review.saving
                        ? 'Saving…'
                        : 'Accept result'}
                  </Button>
                )}
                {!readOnly && attempt?.strategy !== 'CATALOG' && (
                  <Button variant="secondary" size="sm" onClick={() => void controller.runExtraction()}>
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
            {controller.review.error && (
              <p role="alert" className="mt-2 text-[11.5px] leading-snug text-danger">
                {controller.review.error}
              </p>
            )}
            {state.ungroundedCount > 0 && (
              <p className="mt-2 text-[11.5px] leading-snug text-ink-muted">
                {state.ungroundedCount} value{state.ungroundedCount === 1 ? '' : 's'} could not be grounded and will not create Evidence highlights.
              </p>
            )}
            {attempt && <AttemptDetails controller={controller} attempt={attempt} readOnly={readOnly} />}
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
                    const label = !isNaN(idx) && String(idx) === seg ? `Item ${idx + 1}` : seg
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
                    defaultExpanded={navPath.length === 0}
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
          {!readOnly && attempt?.strategy !== 'CATALOG' && (
            <Button variant="primary" size="md" className="mt-2.5" onClick={() => void controller.runExtraction()}>
              Retry extraction
            </Button>
          )}
          {attempt && <AttemptDetails controller={controller} attempt={attempt} readOnly={readOnly} />}
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
              disabled={!controller.canRun}
              onClick={() => void controller.runExtraction()}
            >
              {schemaReady ? 'Run extraction' : 'Generate a schema first'}
            </Button>
          )}
        </div>
      )}

      {state.status === 'cancelled' && (
        <div className="m-3.25 rounded-xl border border-line bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-ink">Extraction cancelled</p>
          {!readOnly && <Button variant="primary" size="md" className="mt-2.5" onClick={() => void controller.runExtraction()}>
            Run a new extraction
          </Button>}
          {attempt && <AttemptDetails controller={controller} attempt={attempt} readOnly={readOnly} />}
        </div>
      )}
    </div>
  )
}

export default ResultsTab
