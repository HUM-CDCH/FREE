import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { exportExtractionResult, type ExtractionProvenance, type ProvenanceClaim } from 'extraction-result-export'
import ExtractionResultExportControl from './ExtractionResultExportControl'
import { MethodUsed } from './MethodUsed'
import ResultValue, { RecordHeader, singularItemLabel } from './ui/ResultValue'
import PartialResults from './PartialResults'
import { Overline, Spinner, Button, ModalDialog, Pill } from './ui'
import { isRecord } from '../shared/template'
import { schemaDefinitionToTemplate, type SchemaDefinition } from 'extraction/schema'
import { resultStats } from './resultStats'
import { extractionStateFromAttempt, type ExtractionController } from './useExtraction'
import type { ExtractionState } from './extraction'
import type { ExtractionAttempt, ReviewDecisionAction } from '../shared/extraction.contract'
import type { EvidenceLink } from '../shared/groundedExtraction'
import { reviewAttention } from 'extraction/review-attention'
import { ReviewAttention } from './ReviewAttention'
import { REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import { CatalogReview } from './CatalogReview'
import { RecipeReview } from './RecipeReview'
import { claimStatuses, describeClaimStatus, fieldLabel, linkOrigin, reasonText, type ClaimStatus } from './claimStates'
import {
  applyReviewDecisions,
  orderResultFields,
  resultPathKey,
  schemaNodeAtResultPath,
} from './reviewDecisions'

type PinnedSchema = SchemaDefinition & {
  revisionNumber?: number
  schemaRevisionId?: string
}

/** One way to run (decision 03): the tab strip's "▶ Run extraction". The Results tab starts no Extraction itself; its
 *  empty state points at that button, or says why it cannot start (`runUnavailableReason`). Nowhere else: a view of an
 *  earlier Source Representation, whose Run is disabled, shows the other states too. */
const RUN_POINTER = 'Press ▶ Run extraction above.'

type ResultsTabProps = {
  controller: ExtractionController
  /** Why the tab strip's Run cannot start now, in its own words (its title); the empty state says it instead of
   *  pointing at the button. Null or absent when Run can start. */
  runUnavailableReason?: string | null
  schemaReady: boolean
  documentMarkdown: string | null
  sourceDocumentName: string
  onSelectEvidence?: (anchorId: string) => void
  onResultPathChange?: (path: string[] | null) => void
  /** Extraction Schema the displayed attempt ran with; also the used-schema preview. */
  pinnedSchema?: PinnedSchema | null
  /** Extraction Schema of the displayed Extraction Result; leads the export columns. */
  exportSchema?: SchemaDefinition | null
  /** Acknowledged Current Schema Revision; null before the first durable save. */
  currentSchemaRevision?: { schemaRevisionId: string; revisionNumber: number } | null
  inspectedAttempt?: ExtractionAttempt
  readOnly?: boolean
  onEditField?: (nodeId: string, path: (string | number)[]) => void
  /** Each Evidence anchor's first page (anchor id → page), for the export's Evidence sheet. */
  evidencePages?: ReadonlyMap<string, number>
  /** The workspace's own header controls (snapshot choice, "Open latest reviewed"), before the attempt details. */
  headerExtras?: ReactNode
}

type View = 'review' | 'json' | 'markdown'

const preClasses =
  'scrollbar-subtle m-0 min-h-0 flex-1 overflow-auto whitespace-pre bg-canvas px-4 py-3.5 font-mono text-compact leading-relaxed text-ink'

/** Tactile press for the panel's own actions; still only opt-in per button. */
const pressable = 'active:scale-96 motion-reduce:active:scale-100'

const noticeClasses =
  'mt-2 rounded-md border border-stale bg-stale-soft px-2.5 py-2 text-compact leading-snug text-stale-ink'

function outcomeLabel(outcome: string) {
  return outcome.replaceAll('_', ' ')
}

function summaryItem(label: string, value: string | number) {
  return (
    <span className="rounded-full border border-line bg-surface-muted px-2 py-1 text-compact font-semibold text-ink-muted">
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

/** A recipe or unified Catalog value's grounding in the researcher's words; like the checks, it describes the original
 *  value, so after an edit or rejection it names that extracted value instead. */
function evidenceDetail(link: EvidenceLink, action: ReviewDecisionAction | undefined, extracted: unknown): string | undefined {
  const grounding = link.grounding
  if (action === 'EDITED' || action === 'REJECTED') return `Extracted value: ${String(extracted)}`
  const location =
    link.precision === 'cell'
      ? 'Located to a table cell'
      : link.precision === 'segment'
        ? 'Located to the source block'
        : link.precision === 'input'
          ? 'Located to the whole input only'
          : undefined
  // Without a recipe or unified grounding, a link is the verifier's unless code linked it by a lexical match.
  if (!grounding) return [linkOrigin(link) === 'rule' ? 'Linked by rule; no verifier checked it' : 'Verifier-supported', location].filter(Boolean).join(' · ')
  const parts = [grounding.linkedBy === 'verification'
    ? (grounding.support === 'literal' ? 'Verifier-supported; the value is printed in the entry' : 'Verifier-supported from a supporting passage; the value is not printed as such')
    : grounding.linkedBy === 'key' ? 'Read after its printed key'
      : grounding.provenance === 'inherited' ? 'Inherited from the heading in force'
        : 'Entry number from the segmentation']
  const others = grounding.alternatives.length
  if (others > 0) parts.push(`${others} other match${others === 1 ? '' : 'es'} in the entry`)
  if (grounding.precision === 'input') parts.push('located to the whole page only')
  if (grounding.precision === 'cell') parts.push('located to a table cell')
  if (grounding.linkedBy !== 'verification' && grounding.normalized) parts.push(`glossary: ${grounding.normalized.value}`)
  return parts.join(' · ')
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

function InfoIcon() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="10" cy="6.5" r="1" fill="currentColor" />
      <path d="M10 9.5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function AttemptDetails({ attempt }: { attempt: ExtractionAttempt }) {
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
            <p className="text-compact font-bold uppercase tracking-[0.08em] text-ink-muted">Run details</p>
            <button
              type="button"
              className="cursor-pointer rounded px-1.5 py-0.5 text-compact font-semibold text-ink-muted hover:text-ink"
              onClick={() => setOpen(false)}
            >
              Close
            </button>
          </div>
          <div className="scrollbar-subtle mt-1.5 max-h-64 overflow-y-auto pr-1">
            <MethodUsed attempt={attempt} />
            <ExtractionDiagnostics attempt={attempt} />
          </div>
        </ModalDialog>
      )}
    </>
  )
}

function statusLabel(state: ExtractionState, attempt: ExtractionAttempt | null): string | null {
  switch (state.status) {
    case 'idle':
      return null
    case 'error':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'running':
      return attempt?.executionStatus === 'QUEUED'
        ? 'Queued'
        : attempt?.executionStatus === 'RUNNING'
          ? 'Running'
          : 'Starting'
    case 'ready':
      return attempt?.complete === false ? 'Completed · incomplete' : 'Completed'
  }
}

/**
 * Progress, Schema Revision comparison and connection state, each readable on
 * its own: the status never hides behind the revision badge, and a lost
 * connection keeps the last known status on screen.
 */
function ExtractionStatus({
  controller,
  state,
  attempt,
  usedSchema,
  currentSchemaRevision,
  readOnly,
}: {
  controller: ExtractionController
  state: ExtractionState
  attempt: ExtractionAttempt | null
  usedSchema: PinnedSchema | null
  currentSchemaRevision: { schemaRevisionId: string; revisionNumber: number } | null
  readOnly: boolean
}) {
  const [schemaOpen, setSchemaOpen] = useState(false)
  const label = statusLabel(state, attempt)
  if (label === null) return null
  const active = attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING'
  // While a request is in flight the previous attempt is still mounted; its
  // revision must not be read as the new run's.
  const known = state.status === 'running' && !active ? null : attempt
  // The caller pins the displayed attempt's schema; an id on it only guards
  // against a stale pin while the attempt changes underneath.
  const usedSchemaShown =
    known && usedSchema && (usedSchema.schemaRevisionId ?? known.schemaRevisionId) === known.schemaRevisionId
      ? usedSchema
      : null
  const usedRevisionNumber = usedSchemaShown?.revisionNumber ?? null
  const previousSchema =
    known !== null &&
    currentSchemaRevision !== null &&
    known.schemaRevisionId !== currentSchemaRevision.schemaRevisionId
  const running = state.status === 'running' || active
  const completed = state.status === 'ready' && !active && known !== null
  const usedRevisionLabel = usedRevisionNumber === null
    ? 'the Extraction’s Schema Revision'
    : `Schema Revision ${usedRevisionNumber}`
  return (
    <section aria-label="Extraction status" className="shrink-0 border-b border-line bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p role="status" className="text-compact font-semibold text-ink">{label}</p>
        {previousSchema && <Pill tone="stale" outline>Previous schema</Pill>}
      </div>
      <p className="mt-0.5 text-compact text-ink-muted">
        {known === null
          ? 'Schema Revision loading…'
          : usedRevisionNumber === null
            ? 'Using Schema Revision (loading…)'
            : `Using Schema Revision ${usedRevisionNumber}`}
        {currentSchemaRevision && ` · Current revision: ${currentSchemaRevision.revisionNumber}`}
      </p>
      {controller.monitorError && !readOnly && (
        <div role="alert" className={noticeClasses}>
          <p>{controller.monitorError}</p>
          <Button variant="secondary" size="sm" className={`mt-1.5 ${pressable}`} onClick={controller.reconnect}>
            Reconnect
          </Button>
        </div>
      )}
      {running && !readOnly && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <p className="text-compact text-ink-muted">You can continue working on other documents.</p>
          {/* Nothing to cancel until the server acknowledges the run ("Starting extraction…"). */}
          <Button
            variant="secondary"
            size="sm"
            className={pressable}
            disabled={controller.cancellationRequested || !active}
            onClick={() => void controller.requestCancellation()}
          >
            {controller.cancellationRequested ? 'Cancellation requested…' : 'Cancel extraction'}
          </Button>
          {controller.cancellationError && (
            <p role="alert" className="basis-full text-compact text-danger">
              Cancellation failed: {controller.cancellationError}
            </p>
          )}
        </div>
      )}
      {completed && previousSchema && (
        <p className="mt-2 text-compact text-ink-muted">Review applies to {usedRevisionLabel}</p>
      )}
      <button
        type="button"
        aria-expanded={schemaOpen}
        aria-controls="results-used-schema"
        disabled={usedSchemaShown === null}
        title={usedSchemaShown === null ? 'The used Schema Revision is still loading' : undefined}
        className={`mt-1.5 cursor-pointer rounded px-1 py-0.5 text-compact font-semibold text-accent outline-none hover:bg-accent-ghost/40 disabled:cursor-default disabled:text-ink-muted ${pressable}`}
        onClick={() => setSchemaOpen((open) => !open)}
      >
        {schemaOpen ? 'Hide used schema' : 'View used schema'}
      </button>
      {schemaOpen && usedSchemaShown && (
        <div id="results-used-schema" className="mt-1.5 flex max-h-56 flex-col rounded-md border border-line">
          <p className="shrink-0 border-b border-line bg-surface-muted px-3 py-1.5 text-compact text-ink-muted">
            {usedRevisionLabel} · <span className="font-mono text-ink">{usedSchemaShown.schemaRevisionId ?? known?.schemaRevisionId ?? 'unknown'}</span> · read-only
          </p>
          <pre className={`${preClasses} rounded-b-md px-3 py-2`}>{JSON.stringify(schemaDefinitionToTemplate({ recordDescription: usedSchemaShown.recordDescription, schemaNodes: usedSchemaShown.schemaNodes }), null, 2)}</pre>
        </div>
      )}
    </section>
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

function ResultsTab({ controller, runUnavailableReason = null, schemaReady, documentMarkdown, sourceDocumentName, pinnedSchema = null, exportSchema = null, currentSchemaRevision = null, inspectedAttempt, readOnly = false, onSelectEvidence, evidencePages, onResultPathChange, onEditField, headerExtras }: ResultsTabProps) {
  const approvalDescriptionId = useId()
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
  const attention = attempt?.resultPayload && pinnedSchema ? reviewAttention(attempt.resultPayload, pinnedSchema.schemaNodes, attempt.evidenceLinks ?? [],
    attempt.reviewedAt ? attempt.reviewDecisions : controller.review.decisions.filter((decision) => controller.review.isTouched(decision.resultPath))) : null
  useEffect(() => {
    if (!readOnly && !inspectedAttempt && editingPaths.size === 0 &&
      controller.review.canAccept && !controller.review.error &&
      controller.review.decisions.some((decision) => decision.evidenceAnchorId !== null))
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
  const stats = useMemo(
    () => (displayResult !== null ? resultStats(displayResult) : null),
    [displayResult],
  )

  const [navPath, setNavPath] = useState<string[]>([])
  const [backStack, setBackStack] = useState<string[][]>([])
  const [forwardStack, setForwardStack] = useState<string[][]>([])

  const partialShown = state.status === 'running' && state.partial !== null
  useEffect(
    () => onResultPathChange?.(
      partialShown ? ['records'] : view === 'review' ? [...articlePathPrefix, ...navPath] : null,
    ),
    [articlePathPrefix, navPath, onResultPathChange, partialShown, view],
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
  // The same links keyed by their absolute result path, as `statuses` and `reviewDecisionByPath` are: for the export.
  const evidenceByAbsolutePath = useMemo(
    () => new Map(state.status === 'ready' ? state.evidenceLinks.map((link) => [resultPathKey(link.resultPath), link]) : []),
    [state],
  )
  const reviewDecisionByPath = useMemo(
    () => new Map(visibleReviewDecisions.map((decision) => [
      resultPathKey(decision.resultPath),
      decision,
    ])),
    [visibleReviewDecisions],
  )
  // The decisions the Completion line and the export report: before the review is saved, only those the researcher
  // made. A seeded approval or a decision carried from a sample is a default until touched, as `attention` reads it.
  const madeDecisions = attempt?.reviewedAt || inspectedAttempt
    ? visibleReviewDecisions
    : visibleReviewDecisions.filter((decision) => controller.review.isTouched(decision.resultPath))
  // Values the service left empty because their sources disagreed, keyed like the Evidence links; one a review has
  // filled or rejected is no longer an open conflict.
  const openContested = useMemo(
    () => (state.status === 'ready' ? attempt?.diagnostics?.contested ?? [] : []).flatMap(({ resultPath, candidates }) => {
      const path = resultPath.map(String).slice(articlePathPrefix.length)
      const value = getAtPath(displayResult, path)
      return (value === null || value === undefined || value === '') &&
        reviewDecisionByPath.get(resultPathKey(resultPath))?.action !== 'REJECTED'
        ? [{ path, candidates }]
        : []
    }),
    [articlePathPrefix.length, attempt, displayResult, reviewDecisionByPath, state.status],
  )
  const contestedByPath = useMemo(
    () => new Map(openContested.map(({ path, candidates }) => [JSON.stringify(path), candidates])),
    [openContested],
  )
  const checkCount = state.status === 'ready'
    ? state.evidenceLinks.filter((link) => evidenceCheck(link, reviewDecisionByPath.get(resultPathKey(link.resultPath))?.action) !== undefined).length
    : 0
  const noGroundedValues = state.status === 'ready' && state.evidenceLinks.length === 0
  const reviewReadOnly = readOnly || Boolean(inspectedAttempt)
  const requiredCount = attempt?.reviewedAt
    ? visibleReviewDecisions.length
    : reviewReadOnly && state.status === 'ready'
      ? state.evidenceLinks.length
      : controller.review.requiredCount
  // Each claim once, in its verifier state. The accounting is derived on read from the persisted evidence and
  // diagnostics, a historical attempt's too; it is null only when the attempt persisted no evidence or no diagnostics.
  const statuses = useMemo(() => attempt ? claimStatuses(attempt) : new Map<string, ClaimStatus>(), [attempt])
  const claims = attempt?.diagnostics?.grounding?.claims ?? null
  // Each linked value once, by who made its link: only the verifier's count as verifier-supported, with or without an accounting.
  const linkCounts = useMemo(() => {
    const origins = new Map(state.status === 'ready' ? state.evidenceLinks.map((link) => [resultPathKey(link.resultPath), linkOrigin(link)]) : [])
    const verifier = [...origins.values()].filter((origin) => origin === 'verifier').length
    return { verifier, rule: origins.size - verifier }
  }, [state])
  // With a claim accounting the workbook carries the Extraction and Evidence sheets; without one (no evidence or no
  // diagnostics persisted) unsupported and unfinished values cannot be told apart, so the export stays values-only.
  const evidenceSheets = attempt !== null && claims !== null && state.status === 'ready'
  const reviewSaved = Boolean(controller.review.reviewedExtractionId || attempt?.reviewedAt)

  /** Opens the claim's parent so its row, with its note, is on screen. */
  function showClaim(resultPath: readonly (string | number)[]) {
    const relative = resultPath.map(String).slice(articlePathPrefix.length)
    setView('review')
    navTo(relative.slice(0, -1))
  }

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
    { value: 'json', label: 'Values as code' },
    { value: 'markdown', label: 'Markdown' },
  ]

  const currentEntries = useMemo((): Array<{ pathKey: string; displayName: string; value: unknown }> => {
    const node = navPath.length === 0 ? displayResult : (displayResult ? getAtPath(displayResult, navPath) : null)
    if (Array.isArray(node)) return node.map((v, i) => ({ pathKey: String(i), displayName: singularItemLabel(navPath[navPath.length - 1] ?? 'item', i), value: v }))
    if (isRecord(node)) return Object.entries(node as Record<string, unknown>).map(([k, v]) => ({ pathKey: k, displayName: k, value: v }))
    return []
  }, [displayResult, navPath])
  // A Catalog record's entries open on its heading and the page its first Evidence names (§8): one record of several
  // once opened, or a single-record Catalog's only record at the top. An Article result is one object: no heading.
  const openRecord = articleRecords?.length === 1 && attempt?.strategy === 'CATALOG' && navPath.length === 0
    ? 0
    : articleRecords && articleRecords.length > 1 && navPath.length === 1 && /^\d+$/.test(navPath[0]!)
      ? Number(navPath[0]) : null
  const openRecordLink = openRecord !== null && state.status === 'ready'
    ? state.evidenceLinks.find((link) => link.resultPath[0] === 'records' && Number(link.resultPath[1]) === openRecord)
    : undefined
  const recordPage = openRecordLink ? evidencePages?.get(openRecordLink.evidenceAnchorId) ?? null : null

  return (
    <div className="scrollbar-subtle flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="flex items-center justify-between gap-2 px-4 py-2.5">
        <Overline as="h2">Extraction results</Overline>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {headerExtras}
          {attempt && <AttemptDetails attempt={attempt} />}
        </div>
      </div>
      {attention && <ReviewAttention attention={attention} onEditField={onEditField}
        onSelect={(path) => { onResultPathChange?.(path.map(String)); const link = attempt?.evidenceLinks?.find((each) => resultPathKey(each.resultPath) === resultPathKey(path)); if (link) onSelectEvidence?.(link.evidenceAnchorId) }} />}
      <ExtractionStatus
        controller={controller}
        state={state}
        attempt={attempt}
        usedSchema={pinnedSchema}
        currentSchemaRevision={currentSchemaRevision}
        readOnly={readOnly || Boolean(inspectedAttempt)}
      />

      {state.status === 'ready' && stats && (
        <>
          <div className="shrink-0 border-b border-line bg-surface px-3 py-2">
            <div className="flex flex-wrap gap-1.5">
              {/* {summaryItem(
                'Status',
                attempt?.complete === false ? 'incomplete' : 'ready',
              )} */}
              {attempt && summaryItem('Strategy', attempt.strategy.toLowerCase())}
              {summaryItem('Fields', stats.fields)}
              {summaryItem('Missing', stats.missing - openContested.length)}
              {openContested.length > 0 && summaryItem('Contested', openContested.length)}
              {summaryItem('Verifier-supported', linkCounts.verifier)}
              {linkCounts.rule > 0 && summaryItem('Rule-linked', linkCounts.rule)}
              {claims && claims.unsupported > 0 && summaryItem('Unsupported', claims.unsupported)}
              {claims && claims.notCompleted > 0 && summaryItem('Not completed', claims.notCompleted)}
              {claims && claims.excluded > 0 && summaryItem('Excluded', claims.excluded)}
              {/* Grounding's doubts: a linked value not found in its passage, or found in others too. Not "to check", which
                  is the badge's and the row marker's word for undecided values. */}
              {checkCount > 0 && summaryItem('Doubtful links', checkCount)}
              {/* {stats.arrayItems > 0 && summaryItem('Array items', stats.arrayItems)} */}
            </div>
            {(requiredCount > 0 || attempt?.reviewedAt || (!reviewReadOnly && (controller.review.loading || controller.review.error))) && (
              <section aria-label="Review progress" className="mt-2 text-compact text-ink-muted">
                <span role={reviewReadOnly ? undefined : 'status'} aria-atomic="true">
                  {attempt?.reviewedAt ? <><span>Review saved</span> · {requiredCount} decision{requiredCount === 1 ? '' : 's'}</>
                    : reviewReadOnly ? `Not reviewed · ${requiredCount} required decision${requiredCount === 1 ? '' : 's'}`
                    : controller.review.loading ? 'Loading Review Decisions…'
                    : controller.review.error && requiredCount === 0 ? 'Review Decisions could not be loaded'
                    : <>
                      {`${controller.review.untouchedCount} of ${requiredCount} required decisions remaining`}
                      {controller.review.saving ? ' · Saving review…' : controller.review.error ? <> · <span>Review not saved</span></> : ''}
                    </>}
                </span>
                {!reviewReadOnly && !attempt?.reviewedAt && !controller.review.loading && !controller.review.draftError && !controller.review.saving && (
                  <span aria-live="off">{controller.review.draftSaving ? ' · Saving draft…' : controller.review.draftSaved ? <> · <span>Draft saved</span></> : ''}</span>
                )}
              </section>
            )}
            {claims && (
              <section aria-label="Completion" className="mt-2 space-y-0.5 text-compact leading-snug text-ink-muted">
                <p data-dimension="processing">Extraction: {attempt?.complete ? 'complete' : 'not shown complete'} · record recall unmeasured</p>
                <p data-dimension="evidence">Evidence checks: {linkCounts.verifier} verifier-supported · {linkCounts.rule > 0 && `${linkCounts.rule} linked by rule · `}{claims.unsupported} unsupported · {claims.notCompleted} not completed · {claims.excluded} excluded by policy ({claims.claims} claims)</p>
                <p data-dimension="review">Review: {attempt?.reviewedAt ? `${madeDecisions.length} decisions saved` : `${madeDecisions.length} decisions pending`}{state.ungroundedCount > 0 && ` · ${state.ungroundedCount} value${state.ungroundedCount === 1 ? '' : 's'} without evidence ${state.ungroundedCount === 1 ? 'is' : 'are'} not reviewable`}</p>
                {claims.unfinished.length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-semibold text-ink">Checks not completed ({claims.unfinished.length})</summary>
                    <ul className="mt-1 space-y-1">
                      {claims.unfinished.map(({ resultPath, reasons }) => {
                        const label = fieldLabel(resultPath, articleRecords?.length ?? 1)
                        return (
                          <li key={JSON.stringify(resultPath)} className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-mono text-ink">{label}</span>
                            <span>{reasons.map(reasonText).join('; ')}</span>
                            <Button size="sm" variant="secondary" onClick={() => showClaim(resultPath)}>Show {label}</Button>
                          </li>
                        )
                      })}
                    </ul>
                  </details>
                )}
              </section>
            )}
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap gap-1.5">
                <ExtractionResultExportControl
                  schema={exportSchema}
                  disabled={displayResult === null}
                  contestedCount={openContested.length}
                  evidenceSheets={evidenceSheets}
                  onExport={async (format, choices) => {
                    if (displayResult === null || exportSchema === null) return
                    // Built here, not per render: the identity names the moment of export.
                    const madeDecisionByPath = new Map(madeDecisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
                    const provenance: ExtractionProvenance | undefined = attempt && claims && state.status === 'ready' ? {
                      identity: [
                        ['Extraction ID', attempt.extractionId], ['Strategy', attempt.strategy], ['Source Document', sourceDocumentName],
                        ['Source Document ID', attempt.sourceDocumentId], ['Source Representation Revision ID', attempt.sourceRepresentationRevisionId],
                        ['Schema Revision ID', attempt.schemaRevisionId], ['Reviewed at', attempt.reviewedAt ?? 'Not finalized'],
                        ['Decisions', madeDecisions.length],
                        ['Versions', Object.entries(attempt.diagnostics?.effectiveMethod?.versions ?? {}).map(([name, version]) => `${name} ${version}`).join(' · ') || 'Not recorded'],
                        ['Field model', attempt.diagnostics?.models?.fields ?? 'Not recorded'], ['Reasoning model', attempt.diagnostics?.models?.reasoning ?? 'Not recorded'],
                        ['Extraction complete', attempt.complete ? 'Yes (record recall unmeasured)' : 'Not shown complete: record recall unmeasured'],
                        ['Claims', claims.claims], ['Verifier-supported', linkCounts.verifier],
                        ...(linkCounts.rule > 0 ? [['Linked by rule', linkCounts.rule] as const] : []), ['Unsupported', claims.unsupported],
                        ['Not completed', claims.notCompleted], ['Excluded by policy', claims.excluded],
                        ['Document-level fields (not verified)', exportSchema.schemaNodes.filter((node) => node.valueSource === 'document').map((node) => node.name).join(', ') || 'None'],
                        ['Exported at', new Date().toISOString()],
                      ],
                      claims: [...statuses].map(([key, status]): ProvenanceClaim => {
                        const resultPath = JSON.parse(key) as (string | number)[]
                        const link = evidenceByAbsolutePath.get(key)
                        const decision = madeDecisionByPath.get(key)
                        // A records envelope's paths start `['records', n]`: the field path is the rest.
                        const path = articleRecords ? resultPath.slice(2) : resultPath
                        return {
                          ...(articleRecords && articleRecords.length > 1 ? { record: Number(resultPath[1]) } : {}),
                          path, extracted: getAtPath(state.result, resultPath.map(String)),
                          ...(decision ? { decision: decision.action, reviewed: decision.reviewedValue } : {}),
                          outcome: status.state, ...(status.linkedBy ? { linkedBy: status.linkedBy } : {}), reasons: status.state === 'excluded' ? [status.policy ?? 'unverified'] : status.reasons,
                          ...(link ? { anchorId: link.evidenceAnchorId, page: evidencePages?.get(link.evidenceAnchorId), precision: link.precision, verbatim: link.verbatim, lexicalHits: link.lexicalHits } : {}),
                        }
                      }),
                    } : undefined
                    await exportExtractionResult(displayResult, {
                      format,
                      filename: sourceDocumentName,
                      schemaNodes: exportSchema.schemaNodes,
                      choices,
                      ...(openContested.length > 0 ? {
                        contested: openContested.map(({ path, candidates }) => {
                          const steps = path.map((step) => /^\d+$/.test(step) ? Number(step) : step)
                          // Several records display as an array: its first step is the record.
                          return Array.isArray(displayResult) && typeof steps[0] === 'number'
                            ? { record: steps[0], path: steps.slice(1), candidates }
                            : { path: steps, candidates }
                        }),
                      } : {}),
                      ...(provenance ? { provenance } : {}),
                    })
                  }}
                />
                {!readOnly && !inspectedAttempt && controller.review.available && !controller.review.reviewedExtractionId && (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={controller.review.loading || controller.review.saving || editingPaths.size > 0 || controller.review.untouchedCount === 0}
                    aria-describedby={approvalDescriptionId}
                    onClick={() => controller.review.approveAll()}
                  >
                    {controller.review.untouchedCount > 0 ? `Approve remaining (${controller.review.untouchedCount})` : 'Approve remaining'}
                  </Button>
                )}
                {!readOnly && !inspectedAttempt && controller.review.available && (
                  <>
                    {controller.review.error && !controller.review.loading && requiredCount === 0 && (
                      <Button size="sm" variant="secondary" onClick={controller.review.reload}>Retry</Button>
                    )}
                    {(controller.review.error || !controller.review.decisions.some((decision) => decision.evidenceAnchorId !== null)) && controller.review.canAccept && (
                      <Button size="sm" variant={controller.review.error ? 'secondary' : 'positive'} disabled={editingPaths.size > 0}
                        onClick={() => void controller.review.accept()}>{controller.review.error ? 'Retry' : 'Save review'}</Button>
                    )}
                  </>
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
                      className={`cursor-pointer border-b-2 px-0.5 pb-1 text-compact font-semibold outline-none transition-colors hover:text-ink focus-visible:text-ink ${
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
            {!reviewReadOnly && controller.review.available && !attempt?.reviewedAt && (
              <p id={approvalDescriptionId} className="mt-2 text-compact leading-snug text-ink-muted">
                Approve only the remaining required decisions. Existing edits and rejections, and ungrounded values, are unchanged.{' '}
                The review saves automatically when all required decisions are made.
              </p>
            )}
            {controller.review.draftError && !readOnly && !inspectedAttempt && (
              <div role="alert" className="text-xs text-danger">
                Draft not saved: {controller.review.draftError}
                <Button onClick={controller.review.retryDraft} disabled={controller.review.draftSaving}>{controller.review.draftError === REVIEW_DRAFT_CONFLICT ? 'Reload server review' : 'Retry draft'}</Button>
              </div>
            )}
            {reviewSaved && (state.ungroundedCount > 0 || (claims?.notCompleted ?? 0) > 0) && (
              <p role="status" className="text-compact text-ink-muted">
                {state.ungroundedCount} value{state.ungroundedCount === 1 ? '' : 's'} without evidence {state.ungroundedCount === 1 ? 'was' : 'were'} not reviewed{claims && `; ${claims.notCompleted} check${claims.notCompleted === 1 ? '' : 's'} never completed`}
              </p>
            )}
            {controller.review.error && (
              <p role="alert" className="mt-2 text-compact leading-snug text-danger">
                {controller.review.error}
              </p>
            )}
            {attempt?.complete === false && (
              <div className={noticeClasses} role="status">
                <p className="font-semibold">Incomplete Extraction</p>
                <p>Successful values remain visible. See the persisted stage diagnostics for details.</p>
                {attempt.diagnostics?.grounding?.issueCodes.includes('text_truncated') && (
                  <p>Some extraction calls omitted source text because of their text budget; affected values may be missing.</p>
                )}
              </div>
            )}
            {noGroundedValues && (
              <div className="mt-2 rounded-md border border-line-strong bg-surface-muted px-2.5 py-2 text-compact leading-snug text-ink" role="status">
                <p className="font-semibold">No grounded values</p>
                <p className="text-ink-muted">No populated value has model Evidence. Values remain visible; optional cells do not block finalizing a review.</p>
              </div>
            )}
            {attempt?.diagnostics?.grounded && <RecipeReview grounded={attempt.diagnostics.grounded} />}
            {attempt?.diagnostics?.unified && <CatalogReview unified={attempt.diagnostics.unified} />}
            {/* An attempt without a claim accounting cannot tell unsupported from unfinished values; with one, the
                Completion section names both apart. */}
            {!claims && state.ungroundedCount > 0 && (
              <p className="mt-2 text-compact leading-snug text-ink-muted">
                {state.ungroundedCount} ungrounded value{state.ungroundedCount === 1 ? ' is' : 's are'} excluded from required review and {state.ungroundedCount === 1 ? 'remains' : 'remain'} recorded without Evidence.
              </p>
            )}
          </div>

          {view === 'review' && (
            <div
              id="results-panel-review"
              role="tabpanel"
              aria-labelledby="results-tab-review"
              className="flex flex-col"
            >
              {/* Breadcrumb bar — scrolls with Extraction status until it
                  reaches the top, then sticks there (root is the scroll
                  container: overflow-y-auto above). */}
              <nav aria-label="Result navigation" className="sticky top-0 z-10 flex shrink-0 items-center gap-0.5 border-b border-line bg-surface px-2 py-1">
                <button
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-content font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30"
                  type="button"
                  title="Back"
                  disabled={backStack.length === 0}
                  onClick={goBack}
                >‹</button>
                <button
                  className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-content font-bold leading-none text-ink-muted hover:bg-accent-ghost/40 hover:text-ink disabled:cursor-default disabled:opacity-30"
                  type="button"
                  title="Forward"
                  disabled={forwardStack.length === 0}
                  onClick={goForward}
                >›</button>
                <span className="mx-1 h-3.5 w-px shrink-0 bg-line" />
                <div className="scrollbar-subtle flex min-w-0 flex-1 items-center overflow-x-auto">
                  <button
                    aria-current={navPath.length === 0 ? 'page' : undefined}
                    className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-secondary font-semibold text-accent hover:bg-accent-ghost/40 disabled:cursor-default disabled:text-ink"
                    type="button"
                    disabled={navPath.length === 0}
                    onClick={() => navTo([])}
                  >Root</button>
                  {navPath.map((seg, i) => {
                    const idx = parseInt(seg, 10)
                    const label = !isNaN(idx) && String(idx) === seg ? singularItemLabel(navPath[i - 1] ?? 'item', idx) : seg
                    return (
                      <span key={i} className="flex items-center gap-0.5">
                        <span className="text-compact text-ink-faint">›</span>
                        {i < navPath.length - 1 ? (
                          <button
                            className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-secondary font-semibold text-ink-muted hover:text-accent"
                            type="button"
                            onClick={() => navTo(navPath.slice(0, i + 1))}
                          >{label}</button>
                        ) : (
                          <span aria-current="page" className="shrink-0 px-1.5 py-0.5 text-secondary font-semibold text-ink">{label}</span>
                        )}
                      </span>
                    )
                  })}
                </div>
                {navPath.length > 0 && (
                  <>
                    <span className="mx-1 h-3.5 w-px shrink-0 bg-line" />
                    <button
                      className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-compact font-semibold text-ink-muted hover:bg-accent-ghost/40 hover:text-accent"
                      type="button"
                      title="Return to root"
                      onClick={clearNavigation}
                    >Clear</button>
                  </>
                )}
              </nav>
              {/* Content */}
              <div className="bg-canvas px-3 py-2">
                {openRecord !== null && <RecordHeader label={singularItemLabel('records', openRecord)} page={recordPage} />}
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
                    getEvidenceDetail={(path) => {
                      const link = evidenceLinkByPath.get(JSON.stringify(path))
                      return link && evidenceDetail(
                        link,
                        reviewDecisionByPath.get(resultPathKey(link.resultPath))?.action,
                        state.status === 'ready' ? getAtPath(state.result, link.resultPath.map(String)) : undefined,
                      )
                    }}
                    getContested={(path) => contestedByPath.get(JSON.stringify(path))}
                    getValueState={(path) => {
                      const key = JSON.stringify(path)
                      if (evidenceLinkByPath.has(key)) return 'grounded'
                      if (contestedByPath.has(key)) return 'contested'
                      const value = getAtPath(displayResult, path.map(String))
                      return value === null || value === undefined || value === '' ? 'empty' : undefined
                    }}
                    getClaimStatus={(path) => {
                      const status = statuses.get(JSON.stringify(absoluteReviewPath(path)))
                      return status && status.state !== 'supported' ? describeClaimStatus(status) : undefined
                    }}
                    onSelectEvidence={onSelectEvidence}
                    review={noGroundedValues ? undefined : {
                      getDecision: (path) => reviewDecisionByPath.get(resultPathKey(absoluteReviewPath(path))),
                      getSchemaNode: (path) => pinnedSchema
                        ? schemaNodeAtResultPath(pinnedSchema.schemaNodes, absoluteReviewPath(path))
                        : null,
                      // An inspected attempt's decisions are its persisted ones, all made; the live controller's untouched set
                      // belongs to the current attempt.
                      isTouched: inspectedAttempt ? () => true : (path) => controller.review.isTouched(absoluteReviewPath(path)),
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
                  <p className="text-content font-semibold text-ink">Markdown unavailable</p>
                  <p className="mt-1.5 max-w-[34ch] text-compact leading-snug text-ink-muted">
                    Parsed Markdown has not been received for this source document.
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {state.status === 'running' && state.partial && (
        <PartialResults partial={state.partial} schemaNodes={pinnedSchema?.schemaNodes} onSelectEvidence={onSelectEvidence} />
      )}
      {state.status === 'running' && !state.partial && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6">
          {/* Queued or running only once the server acknowledged the attempt: until then the attempt on screen is
              the previous one, and the new run may not exist yet. */}
          <Spinner
            label={attempt?.executionStatus === 'QUEUED'
              ? 'Queued extraction…'
              : attempt?.executionStatus === 'RUNNING'
                ? 'Running extraction…'
                : 'Starting extraction…'}
            hint={attempt?.executionStatus === 'QUEUED'
              ? 'Waiting for the extraction worker to start this attempt.'
              : attempt?.executionStatus === 'RUNNING'
                ? 'The server is extracting values, grounding Evidence, and saving the terminal attempt.'
                : 'Sending the extraction to the server.'}
          />
        </div>
      )}

      {state.status === 'error' && (
        <div className="m-3.25 rounded-xl border border-danger/40 bg-surface px-4 py-3">
          <p className="text-content font-semibold text-danger">Extraction failed</p>
          <p className="mt-1 wrap-anywhere text-secondary leading-snug text-ink-muted">{state.message}</p>
        </div>
      )}

      {state.status === 'idle' && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
          <p className="text-content font-semibold text-ink">No results yet</p>
          <p className="mt-1.5 max-w-[34ch] text-compact leading-snug text-ink-muted">
            {schemaReady
              ? 'Run extraction to apply the schema across the source document.'
              : 'Generate a schema in the Schema tab first, then run extraction.'}
          </p>
          {!readOnly && schemaReady && <p className="mt-1.5 text-compact font-semibold text-ink">{runUnavailableReason ?? RUN_POINTER}</p>}
        </div>
      )}

      {state.status === 'cancelled' && (
        <div className="m-3.25 rounded-xl border border-line bg-surface px-4 py-3">
          <p className="text-content font-semibold text-ink">Extraction cancelled</p>
        </div>
      )}
    </div>
  )
}

export default ResultsTab
