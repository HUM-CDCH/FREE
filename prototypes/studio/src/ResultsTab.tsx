import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { exportExtractionResult } from 'extraction-result-export'
import ExtractionResultExportControl from './ExtractionResultExportControl'
import ResultValue, { singularItemLabel } from './ui/ResultValue'
import { Overline, Spinner, Button, ModalDialog } from './ui'
import { isRecord } from '../shared/template'
import { schemaDefinitionToTemplate, type SchemaDefinition } from 'extraction/schema'
import { resultStats } from './resultStats'
import { extractionStateFromAttempt, type ExtractionController, type ExtractionRetryInput } from './useExtraction'
import type { ExtractionAttempt, ReviewDecisionAction } from '../shared/extraction.contract'
import { REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import {
  applyReviewDecisions,
  orderResultFields,
  resultPathKey,
  schemaNodeAtResultPath,
} from './reviewDecisions'

type ResultsTabProps = {
  controller: ExtractionController
  onRunExtraction: () => void | Promise<void>
  runExtractionDisabled: boolean
  schemaReady: boolean
  documentMarkdown: string | null
  sourceDocumentName: string
  onSelectEvidence?: (anchorId: string) => void
  onResultPathChange?: (path: string[] | null) => void
  pinnedSchema?: (SchemaDefinition & {
    revisionNumber?: number
    schemaRevisionId?: string
  }) | null
  /** Extraction Schema of the displayed Extraction Result; leads the export columns. */
  exportSchema?: SchemaDefinition | null
  inspectedAttempt?: ExtractionAttempt
  readOnly?: boolean
}

type View = 'review' | 'json' | 'markdown' | 'schema'

const preClasses =
  'scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-[11px] leading-relaxed text-ink'

function outcomeLabel(outcome: string) {
  return outcome.replaceAll('_', ' ')
}

function summaryItem(label: string, value: string | number) {
  return (
    <span className="rounded-full border border-line bg-surface-muted px-2 py-1 text-[11px] font-semibold text-ink-muted">
      {label}: <span className="font-mono text-ink">{value}</span>
    </span>
  )
}

/** Checks describe the original value, so hide them after an edit or rejection. */
function evidenceCheck(link: { verbatim?: boolean; lexicalHits?: number }, action?: ReviewDecisionAction): string | undefined {
  if (action === 'EDITED' || action === 'REJECTED') return undefined
  if (link.verbatim === false) return 'Value not found in the linked passage'
  const others = (link.lexicalHits ?? 1) - 1
  if (link.verbatim && others > 0) return `Value also appears in ${others} other passage${others === 1 ? '' : 's'}`
  return undefined
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
  diagnostics: NonNullable<NonNullable<ExtractionAttempt['diagnostics']>['grounding']>
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
  if (!diagnostics)
    return <p className="text-[11.5px] text-ink-muted">Diagnostics are not available yet.</p>
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
          {catalog && (
            <div className="space-y-2" aria-label="Catalog diagnostics">
              <p className="text-[11.5px] font-semibold text-ink">Catalog stages</p>
              {catalog.stages.map((stage) => (
                <div
                  key={stage.stage}
                  aria-label={`Catalog stage ${stage.stage}: ${stage.outcome}, ${stage.provenance}`}
                  className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5"
                >
                  <p className="text-[11.5px] text-ink">
                    {stage.stage} · {outcomeLabel(stage.outcome)} · {stage.provenance}
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
                  <div
                    key={record.ordinal}
                    aria-label={`Catalog record ${record.ordinal + 1}: ${record.outcome}, ${record.provenance}, ${record.boundary.headingText}`}
                    className="rounded-md border border-line bg-surface-muted px-2.5 py-1.5"
                  >
                    <p className="text-[11.5px] text-ink">
                      Record {record.ordinal + 1} · {outcomeLabel(record.outcome)} · {record.provenance} · {record.boundary.headingText}
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

const emptyRetrySelection: ExtractionRetryInput = {
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
  const catalog = attempt.strategy === 'CATALOG'
    ? attempt.diagnostics?.catalog ?? null
    : null
  const [selection, setSelection] = useState<ExtractionRetryInput>(emptyRetrySelection)
  const active =
    attempt.executionStatus === 'QUEUED' || attempt.executionStatus === 'RUNNING'

  if (!catalog || active || attempt.outcome === 'CANCELLED') return null
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

  const selectedCount = selection.retryRecordStartBlockIds.length
  const canRetrySelected = selection.retryDocument || selection.rediscover || selectedCount > 0
  const submit = (next: ExtractionRetryInput) => {
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

function InfoIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="6.5" r="1" fill="currentColor" />
      <path d="M10 9.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
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
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Run details"
        className="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-ink-muted hover:text-ink"
        onClick={() => setOpen(true)}
      >
        <InfoIcon />
        <span className="sr-only">Run details</span>
      </button>
      {open && (
        <ModalDialog
          ariaLabel="Run details"
          className="m-auto w-96 max-w-[90vw] rounded-md border border-line bg-surface p-3 text-ink shadow-float backdrop:bg-ink/35"
          returnFocusRef={triggerRef}
          onDismiss={() => setOpen(false)}
        >
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-bold uppercase tracking-[0.08em] text-ink-muted">Run details</p>
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-muted hover:text-ink"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
          <div className="scrollbar-subtle mt-1.5 max-h-64 overflow-y-auto pr-1">
            <ExtractionDiagnostics attempt={attempt} />
            {!readOnly && attempt.strategy === 'CATALOG' && (
              <CatalogRetryControls key={attempt.extractionId} controller={controller} attempt={attempt} />
            )}
          </div>
        </ModalDialog>
      )}
    </>
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
  const state = useMemo(
    () => inspectedAttempt
      ? extractionStateFromAttempt(inspectedAttempt)
      : controller.state,
    [controller.state, inspectedAttempt],
  )
  const visibleReviewDecisions = inspectedAttempt?.reviewDecisions ??
    (attempt?.reviewedAt ? attempt.reviewDecisions : controller.review.decisions)
  const reviewedResult = useMemo(
    () => state.status === 'ready'
      ? applyReviewDecisions(state.result, visibleReviewDecisions)
      : null,
    [state, visibleReviewDecisions],
  )
  const [view, setView] = useState<View>('review')
  const [editingPaths, setEditingPaths] = useState<ReadonlySet<string>>(new Set())
  const onEditingChange = useCallback((key: string, editing: boolean) => {
    setEditingPaths((current) => {
      const next = new Set(current)
      if (editing) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  useEffect(() => {
    if (!readOnly && !inspectedAttempt && editingPaths.size === 0 &&
      controller.review.canAccept && !controller.review.error)
      void controller.review.accept()
  })
  const articleRecords =
    state.status === 'ready' &&
    isRecord(reviewedResult) &&
    Array.isArray(reviewedResult.records)
      ? reviewedResult.records
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
  const absoluteReviewPath = (path: readonly string[]) => [
    ...(articleRecords
      ? articleRecords.length === 1
        ? ['records', 0]
        : ['records']
      : []),
    ...path.map((segment) => /^\d+$/.test(segment) ? Number(segment) : segment),
  ]
  const unorderedResult =
    articleRecords?.length === 1
      ? articleRecords[0]
      : articleRecords ?? reviewedResult
  const displayResult = useMemo(() => pinnedSchema
    ? orderResultFields(unorderedResult, pinnedSchema.schemaNodes)
    : unorderedResult, [unorderedResult, pinnedSchema])
  const provisional = attempt !== null && attempt.executionStatus !== 'COMPLETED'
  const activeAttempt =
    attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING'
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
  const evidenceLinkByPath = useMemo(
    () =>
      new Map(
        state.status === 'ready'
          ? state.evidenceLinks.map((link) => [
              JSON.stringify(
                link.resultPath.map(String).slice(articlePathPrefix.length),
              ),
              link,
            ])
          : [],
      ),
    [articlePathPrefix.length, state],
  )
  const reviewDecisionByPath = useMemo(
    () => new Map(visibleReviewDecisions.map((decision) => [
      resultPathKey(decision.resultPath),
      decision,
    ])),
    [visibleReviewDecisions],
  )
  const checkCount = state.status === 'ready'
    ? state.evidenceLinks.filter((link) => evidenceCheck(link, reviewDecisionByPath.get(resultPathKey(link.resultPath))?.action) !== undefined).length
    : 0
  const noReviewableResult = state.status === 'ready' && state.evidenceLinks.length === 0

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

  const resultViewTabs: Array<{ value: View; label: string }> = [
    { value: 'review', label: 'Review' },
    { value: 'json', label: 'Raw JSON' },
    { value: 'markdown', label: 'Markdown' },
    ...(pinnedSchema ? [{ value: 'schema' as const, label: 'Pinned schema' }] : []),
  ]

  const currentEntries = useMemo((): Array<{ pathKey: string; displayName: string; value: unknown }> => {
    const node = navPath.length === 0 ? displayResult : (displayResult ? getAtPath(displayResult, navPath) : null)
    if (Array.isArray(node)) return node.map((v, i) => ({ pathKey: String(i), displayName: singularItemLabel(navPath[navPath.length - 1] ?? 'item', i), value: v }))
    if (isRecord(node)) return Object.entries(node as Record<string, unknown>).map(([k, v]) => ({ pathKey: k, displayName: k, value: v }))
    return []
  }, [displayResult, navPath])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* <header className="flex min-h-9.5 shrink-0 items-center gap-2 border-b border-line px-4">
        <Overline as="h2">Extraction results</Overline>
      </header> */}
      <div className="flex items-center justify-between px-4 py-2.5">
        <Overline as="h2">Extraction results</Overline>
        {attempt && (
          <AttemptDetails
            controller={controller}
            attempt={attempt}
            readOnly={readOnly || Boolean(inspectedAttempt)}
          />
        )}
      </div>

      {state.status === 'ready' && stats && (
        <>
          <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
            {provisional && (
              <p className="mb-2 text-[11.5px] font-semibold text-ink-muted" role="status">
                {attempt?.executionStatus === 'FAILED'
                  ? `Evidence linking stopped: ${attempt.failure?.message ?? 'the Extraction failed.'}`
                  : 'Values extracted · linking Evidence…'}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {/* {summaryItem(
                'Status',
                attempt?.complete === false ? 'incomplete' : 'ready',
              )} */}
              {attempt && summaryItem('Strategy', attempt.strategy.toLowerCase())}
              {summaryItem('Fields', stats.fields)}
              {summaryItem('Missing', stats.missing)}
              {summaryItem('Grounded', state.evidenceLinks.length)}
              {checkCount > 0 && summaryItem('To check', checkCount)}
              {state.evidenceLinks.length > 0 && summaryItem(
                'Decisions',
                attempt?.reviewedAt
                  ? `${visibleReviewDecisions.length} saved`
                  : controller.review.loading
                    ? 'loading'
                    : `${visibleReviewDecisions.length} pending`,
              )}
              {/* {stats.arrayItems > 0 && summaryItem('Array items', stats.arrayItems)} */}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1.5">
                <ExtractionResultExportControl
                  schema={exportSchema}
                  disabled={displayResult === null || provisional}
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
                {!readOnly && !inspectedAttempt && controller.review.available && !controller.review.reviewedExtractionId && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={controller.review.loading || controller.review.saving || editingPaths.size > 0 || controller.review.untouchedCount === 0}
                    title="Mark every untouched field Approved, without changing fields you've already acted on"
                    onClick={() => controller.review.approveAll()}
                  >
                    {controller.review.untouchedCount > 0 ? `Approve remaining (${controller.review.untouchedCount})` : 'Approve remaining'}
                  </Button>
                )}
                {!readOnly && !inspectedAttempt && controller.review.available && (
                  <>
                    <span role="status" className="self-center text-[11px] text-ink-muted">
                      {controller.review.reviewedExtractionId ? 'Review saved'
                        : controller.review.saving ? 'Saving…'
                        : controller.review.error ? 'Review not saved'
                        : controller.review.loading ? 'Loading review…'
                        : 'Review all fields to save automatically'}
                    </span>
                    {controller.review.error && controller.review.canAccept && (
                      <Button size="sm" variant="secondary" disabled={editingPaths.size > 0}
                        onClick={() => void controller.review.accept()}>Retry</Button>
                    )}
                  </>
                )}
                {!readOnly && attempt?.strategy !== 'CATALOG' && (
                  <Button variant="secondary" size="sm" disabled={runExtractionDisabled || activeAttempt} onClick={() => void onRunExtraction()}>
                    Rerun
                  </Button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3" role="tablist" aria-label="Result view">
                {resultViewTabs.map(({ value, label }) => {
                  const active = view === value
                  return (
                    <button
                      key={value}
                      type="button"
                      role="tab"
                      id={`results-tab-${value}`}
                      aria-selected={active}
                      aria-controls={`results-panel-${value}`}
                      className={`cursor-pointer border-b-2 px-0.5 pb-1 text-[11px] font-semibold outline-none transition-colors hover:text-ink focus-visible:text-ink ${
                        active ? 'border-accent text-ink' : 'border-transparent text-ink-muted'
                      }`}
                      onClick={() => setView(value)}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
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
                  disabled={runExtractionDisabled || activeAttempt}
                  onClick={() => void onRunExtraction()}
                >
                  Re-run extraction
                </Button>
              </div>
            )}
            {controller.review.draftError && !readOnly && !inspectedAttempt && (
              <div role="alert" className="text-xs text-danger">
                Draft not saved: {controller.review.draftError}
                <Button onClick={controller.review.retryDraft} disabled={controller.review.draftSaving}>{controller.review.draftError === REVIEW_DRAFT_CONFLICT ? 'Reload server review' : 'Retry draft'}</Button>
              </div>
            )}
            {!readOnly && !inspectedAttempt && !controller.review.reviewedExtractionId && !controller.review.draftError && (
              <p role="status" className="text-xs text-ink-muted">
                {controller.review.draftSaving ? 'Saving draft…' : controller.review.untouchedCount < controller.review.reviewedCount ? 'Draft saved' : ''}
              </p>
            )}
            {controller.review.error && (
              <p role="alert" className="mt-2 text-[11.5px] leading-snug text-danger">
                {controller.review.error}
              </p>
            )}
            {attempt?.complete === false && (
              <div
                className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-2 text-[11.5px] leading-snug text-amber-900"
                role="status"
              >
                <p className="font-semibold">Incomplete Extraction</p>
                <p>Successful values remain visible. See the persisted stage diagnostics for details.</p>
              </div>
            )}
            {noReviewableResult && (
              <div className="mt-2 rounded-md border border-line-strong bg-surface-muted px-2.5 py-2 text-[11.5px] leading-snug text-ink" role="status">
                <p className="font-semibold">No reviewable result</p>
                <p className="text-ink-muted">No populated value has Evidence. Raw JSON and diagnostics remain available.</p>
              </div>
            )}
            {state.ungroundedCount > 0 && (
              <p className="mt-2 text-[11.5px] leading-snug text-ink-muted">
                {state.ungroundedCount} value{state.ungroundedCount === 1 ? '' : 's'} could not be grounded. {noReviewableResult ? 'No Review Decisions can be saved; ' : 'You can still save the grounded Review Decisions; '}{state.ungroundedCount === 1 ? 'it' : 'they'} will remain recorded without Evidence.
              </p>
            )}
          </div>

          {view === 'review' && (
            <div
              id="results-panel-review"
              role="tabpanel"
              aria-labelledby="results-tab-review"
              className="flex min-h-0 flex-1 flex-col"
            >
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
                {controller.review.loading && !readOnly && (
                  <p role="status" className="py-2 text-[11.5px] text-ink-muted">Loading Review Decisions…</p>
                )}
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
                      evidenceLinkByPath.get(JSON.stringify(path))?.evidenceAnchorId
                    }
                    getEvidenceCheck={(path) => {
                      const link = evidenceLinkByPath.get(JSON.stringify(path))
                      return link && evidenceCheck(link, reviewDecisionByPath.get(resultPathKey(link.resultPath))?.action)
                    }}
                    onSelectEvidence={onSelectEvidence}
                    review={noReviewableResult ? undefined : {
                      getDecision: (path) => reviewDecisionByPath.get(resultPathKey(absoluteReviewPath(path))),
                      getSchemaNode: (path) => pinnedSchema
                        ? schemaNodeAtResultPath(pinnedSchema.schemaNodes, absoluteReviewPath(path))
                        : null,
                      isTouched: (path) => controller.review.isTouched(absoluteReviewPath(path)),
                      onEditingChange,
                      onDecision: readOnly || inspectedAttempt || attempt?.reviewedAt || controller.review.saving
                        ? undefined
                        : (path, action, reviewedValue) => controller.review.setDecision(
                            absoluteReviewPath(path),
                            action,
                            reviewedValue,
                          ),
                      readOnly: readOnly || Boolean(inspectedAttempt) || Boolean(attempt?.reviewedAt) || controller.review.saving,
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {view === 'json' && (
            <pre
              id="results-panel-json"
              role="tabpanel"
              aria-labelledby="results-tab-json"
              className={preClasses}
            >{JSON.stringify(displayResult, null, 2)}</pre>
          )}

          {view === 'schema' && pinnedSchema && (
            <div
              id="results-panel-schema"
              role="tabpanel"
              aria-labelledby="results-tab-schema"
              className="flex min-h-0 flex-1 flex-col"
            >
              <p className="shrink-0 border-b border-line bg-surface-muted px-4 py-2 text-[11.5px] text-ink-muted">
                Schema Revision{pinnedSchema.revisionNumber ? ` ${pinnedSchema.revisionNumber}` : ''} · <span className="font-mono text-ink">{pinnedSchema.schemaRevisionId ?? attempt?.schemaRevisionId ?? 'unknown'}</span> · read-only
              </p>
              <pre className={preClasses}>{JSON.stringify(schemaDefinitionToTemplate({ recordDescription: pinnedSchema.recordDescription, schemaNodes: pinnedSchema.schemaNodes }), null, 2)}</pre>
            </div>
          )}

          {view === 'markdown' && (
            <div
              id="results-panel-markdown"
              role="tabpanel"
              aria-labelledby="results-tab-markdown"
              className="flex min-h-0 flex-1 flex-col"
            >
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
            label={attempt?.executionStatus === 'QUEUED' ? 'Queued extraction…' : 'Running extraction…'}
            hint={attempt?.executionStatus === 'QUEUED'
              ? 'Waiting for the extraction worker to start this attempt.'
              : 'The server is extracting values, grounding Evidence, and saving the terminal attempt.'}
          />
        </div>
      )}

      {state.status === 'error' && (
        <div className="m-3.25 rounded-xl border border-danger/40 bg-surface px-4 py-3">
          <p className="text-[13px] font-semibold text-danger">Extraction failed</p>
          <p className="mt-1 wrap-anywhere text-[12px] leading-snug text-ink-muted">{state.message}</p>
          {!readOnly && attempt?.strategy !== 'CATALOG' && (
            <Button variant="primary" size="md" className="mt-2.5" disabled={runExtractionDisabled} onClick={() => void onRunExtraction()}>
              Retry extraction
            </Button>
          )}
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
        </div>
      )}
    </div>
  )
}

export default ResultsTab
