import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtractionMethodIntent } from 'extraction/extraction-method'
import { forgetReviewDraft, recoverReviewDraft, rememberReviewDraft, REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import { reconcileAtSettlement } from './reviewReconcile'
import {
  ApiRequestError,
  cancelExtraction,
  finalizeExtractionReview,
  saveExtractionReviewDraft,
  readExtraction,
  requestExtraction,
} from './api'
import type { ExtractionState } from './extraction'
import { draftDecisionsFromPartial, partialValueAt, retainFinished } from './partialResult'
import {
  type ExtractionAttempt,
  type ExtractionStrategy,
  type PartialResult,
  type ReviewDecisionAction,
  type ReviewDecisionInput,
} from '../shared/extraction.contract'
import { resultPathKey } from '../shared/groundedExtraction'

/** Shown when a status read fails; the last known state stays on screen. */
export const MONITOR_DISCONNECTED =
  'Unable to update status. The extraction may still be running.'
/** Shown when the server denies or cannot find the monitored Extraction. */
export const EXTRACTION_UNAVAILABLE =
  'Extraction status is unavailable: it was not found or access was denied.'


type ExtractionRunRequest = Readonly<{
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  catalogRecipe?: string
  /** One-based page the researcher was reading when Run was clicked. */
  startPage?: number
  /** The saved method read at the click; admission refuses it if the account's changed since. */
  method: ExtractionMethodIntent
}>

export type ReviewTarget = {
  sourceRepresentationId: string
  /**
   * Current Schema Revision safe to extract with, or null while the editor
   * draft differs from the acknowledged revision. Review Decisions never
   * depend on it: they always apply to the Extraction's own revision.
   */
  schemaRevisionId: string | null
}

type UseExtractionOptions = {
  schemaReady: boolean
  indexing: boolean
  onTerminal: (attempt: ExtractionAttempt, isRerun: boolean) => void
  onError: (message: string) => void
  /**
   * The server refused a run because the Source Representation it names was
   * superseded by reprocessing. Nothing failed, so `onError` is not called:
   * the earlier attempt stays on screen and the page re-reads the document so
   * it stops offering runs on the old revision.
   */
  onSuperseded?: () => void
  /** Admission refused the run's method or scope (`code`: a changed saved method, a pending migration, a record-scope
   *  refusal): nothing started. The caller re-reads the saved method on `METHOD_CHANGED`. */
  onMethodChanged?: (message: string, code: string) => void
  initialAttempt?: ExtractionAttempt | null
  reviewTarget?: ReviewTarget | null
  /**
   * Identifies which Source Document `initialAttempt` belongs to. The caller
   * no longer remounts this hook when the active Source Document changes
   * (schema state above it must survive that switch), so `attempt`/`state`
   * are reseeded from `initialAttempt` whenever this key changes instead of
   * relying on `useState`'s initializer, which only runs once.
   */
  documentKey?: string
  /** Every Evidence Anchor's occurrence IDs in the pinned document: a running Extraction's decisions name them all. */
  occurrenceIdsByAnchor?: ReadonlyMap<string, readonly string[]> | null
}

/**
 * One in-flight or paused watch over a single Extraction. Every status read,
 * callback, and cancellation is bound to the monitor that started it, so a
 * late response for a previous Source Document or Extraction is ignored.
 */
type Monitor = {
  extractionId: string
  isRerun: boolean
  /** A read failed; polling resumes only through `reconnect()`. */
  paused: boolean
  controller: AbortController
  /** The request this monitor posted, when the server has not acknowledged it (JSON). */
  unacknowledged?: string
  /** Last server partial for this Extraction; survives a paused monitor and reconnect. */
  partial?: PartialResult | null
  /** The server's Review Draft was adopted from this monitor's first RUNNING read; later reads never overwrite it. */
  draftSeen?: boolean
}

function isActive(attempt: ExtractionAttempt | null): boolean {
  return Boolean(attempt && ['QUEUED','RUNNING','PAUSING','STOPPING'].includes(attempt.executionStatus))
}

function definiteRejection(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500
}

/** PR #140: a run on a Source Representation that reprocessing replaced is refused before anything starts. */
const SOURCE_REPRESENTATION_SUPERSEDED = 'source_representation_superseded'
export const METHOD_CHANGED = 'method_changed'
/** Legacy Catalog preferences wait for their migration: refreshable, like a changed method. */
const MIGRATION_REQUIRED = 'catalog_migration_required'
/** A strategy the schema's saved Article/Catalog scope does not name (or none saved): said like a changed method. */
const RECORD_SCOPE_REFUSALS: ReadonlySet<string> = new Set(['record_scope_required', 'record_scope_mismatch'])

/** The server's own words for a refusal: `ApiRequestError` prefixes its message with `<code>: `. */
function serverMessage(error: ApiRequestError): string {
  const prefix = `${error.code}: `
  return error.code && error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message
}

export type ExtractionController = ReturnType<typeof useExtraction>

/** Every decision with Evidence has the researcher's decision: the review may be saved. */
function everyRequiredTouched(decisions: readonly ReviewDecisionInput[], touched: ReadonlySet<string>) {
  return decisions.every((decision) => decision.evidenceAnchorId === null || touched.has(resultPathKey(decision.resultPath)))
}

export function extractionStateFromAttempt(attempt: ExtractionAttempt | null, partial: PartialResult | null = null): ExtractionState {
  if (!attempt) return { status: 'idle' }
  if (attempt.durable) return {status:'retained',executionStatus:attempt.executionStatus}
  const active = isActive(attempt)
  if (!attempt.resultPayload) {
    if (active) return { status: 'running', step: 'extraction', partial }
    if (attempt.failure?.code === 'cancelled') return { status: 'cancelled' }
    return {
      status: 'error',
      message: attempt.failure?.message ?? 'Extraction failed.',
    }
  }
  return {
    status: 'ready',
    result: attempt.resultPayload,
    evidenceLinks: attempt.evidenceLinks ?? [],
    ungroundedCount:
      attempt.diagnostics?.grounding?.ungroundedPaths.length ?? 0,
  }
}

function pendingDecision(
  decision: ExtractionAttempt['reviewDecisions'][number],
): ReviewDecisionInput {
  return {
    resultPath: decision.resultPath,
    evidenceAnchorId: decision.evidenceAnchorId,
    reviewedOccurrenceIds: decision.reviewedOccurrenceIds,
    action: decision.action,
    reviewedValue: decision.reviewedValue,
    ...(decision.reviewedEvidence ? { reviewedEvidence: decision.reviewedEvidence } : {}),
  }
}

function pollingDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = window.setTimeout(done, 2_000)
    const onAbort = () => done()
    function done() {
      window.clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function useExtraction({
  schemaReady,
  indexing,
  onTerminal,
  onError,
  onSuperseded,
  onMethodChanged,
  initialAttempt = null,
  reviewTarget = null,
  documentKey = '',
  occurrenceIdsByAnchor = null,
}: UseExtractionOptions) {
  const [attempt, setAttempt] = useState<ExtractionAttempt | null>(
    initialAttempt,
  )
  const currentAttemptRef=useRef(attempt)
  currentAttemptRef.current=attempt
  const [state, setState] = useState<ExtractionState>(() =>
    extractionStateFromAttempt(initialAttempt),
  )
  const [saving, setSaving] = useState(false)
  const [reviewLoading, setReviewLoading] = useState(false)
  const [reviewDecisions, setReviewDecisions] = useState<ReviewDecisionInput[]>([])
  // Fields the researcher has explicitly acted on, keyed like reviewDecisions
  // (resultPathKey). A field with no entry here is showing its unreviewed
  // default (every field is seeded 'APPROVED' by prepareReview) rather than a
  // decision the researcher actually made.
  const [touchedPaths, setTouchedPaths] = useState<ReadonlySet<string>>(new Set())
  const draftRef = useRef<{ decisions: ReviewDecisionInput[]; touched: ReadonlySet<string> }>({ decisions: reviewDecisions, touched: touchedPaths })
  draftRef.current = { decisions: reviewDecisions, touched: touchedPaths }
  // The draft as the server last accepted it: a running draft it refuses reverts to this.
  const draftAcceptedRef = useRef<{ decisions: ReviewDecisionInput[]; touched: ReadonlySet<string> } | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const draftSaveRef = useRef({ version: 0, pending: Promise.resolve(), writes: 0, conflict: false })
  const [reviewReload, setReviewReload] = useState(0)
  // The Extraction whose server review was last read; nothing is accepted before that read.
  const [reviewReadFor, setReviewReadFor] = useState('')
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [cancellationRequested, setCancellationRequested] = useState(false)
  const [cancellationError, setCancellationError] = useState<string | null>(null)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const monitorRef = useRef<Monitor | null>(null)
  const reviewLoadRef = useRef(0)
  const saveScopeRef = useRef({ saving: false })
  // Review during a run (ADR 0016). The server's draft as the first RUNNING read carried it; the Extraction the
  // decisions on screen belong to; and, per decision made during the run, the value it was made on (§5.3).
  const [runDraft, setRunDraft] = useState<{ extractionId: string; version: number; decisions: ReviewDecisionInput[] } | null>(null)
  const adoptedRunDraftRef = useRef<typeof runDraft>(null)
  const reviewReloadRef = useRef(reviewReload)
  const decisionsForRef = useRef<string | null>(null)
  // The Extraction this session watched while it was active: its settled review load reports a settlement (§5.3).
  const watchedRunRef = useRef<string | null>(null)
  const decidedOnRef = useRef<{ extractionId: string | null; values: Map<string, unknown> }>({ extractionId: null, values: new Map() })
  const [changedAfterReview, setChangedAfterReview] = useState<ReadonlySet<string>>(new Set())
  const [settlement, setSettlement] = useState<{ kept: number; changed: number } | null>(null)
  const [discarded, setDiscarded] = useState<number | null>(null)
  const [draftRefused, setDraftRefused] = useState<string | null>(null)

  function stopMonitor() {
    monitorRef.current?.controller.abort()
    monitorRef.current = null
  }

  // Reset during render (not in an effect) when the document or attempt
  // change, so no frame renders the previous document's state. A change of
  // the Current Schema Revision alone touches nothing here: polling, drafts
  // and decisions stay bound to the Extraction's own revision.
  const [rendered, setRendered] = useState({ documentKey, extractionId: attempt?.extractionId, initialExtractionId: initialAttempt?.extractionId })
  const documentChanged = rendered.documentKey !== documentKey
  const initialChanged = rendered.initialExtractionId !== initialAttempt?.extractionId
  // Explicit history navigation can select another Extraction on this same
  // document. A prop catching up to a run admitted here is not a new scope.
  const scopeChanged = documentChanged || initialChanged && initialAttempt?.extractionId !== attempt?.extractionId
  const nextAttempt = scopeChanged ? initialAttempt : attempt
  const attemptChanged = rendered.extractionId !== nextAttempt?.extractionId
  if (documentChanged || initialChanged || attemptChanged) {
    setRendered({ documentKey, extractionId: nextAttempt?.extractionId, initialExtractionId: initialAttempt?.extractionId })
    if (scopeChanged || attemptChanged) {
      // In-flight saves and draft writes belong to the previous document or attempt.
      saveScopeRef.current = { saving: false }
      draftSaveRef.current = { version: 0, pending: Promise.resolve(), writes: 0, conflict: false }
      setDraftSaving(false)
      setDraftSaved(false)
      setSaving(false)
      setReviewLoading(false)
      draftAcceptedRef.current = null
      adoptedRunDraftRef.current = null
      decisionsForRef.current = null
      decidedOnRef.current = { extractionId: null, values: new Map() }
      if (documentChanged || runDraft?.extractionId !== nextAttempt?.extractionId) setRunDraft(null)
      setChangedAfterReview(new Set())
      setSettlement(null)
      setDraftRefused(null)
      setDiscarded(null)
    }
    if (scopeChanged) {
      // Orphaned reads notice the missing monitor and drop their response.
      stopMonitor()
      setAttempt(initialAttempt)
      setState(extractionStateFromAttempt(initialAttempt))
      setReviewDecisions([])
      setTouchedPaths(new Set())
      setReviewError(null)
      setDraftError(null)
      setCancellationRequested(false)
      setCancellationError(null)
      setMonitorError(null)
    }
  }

  /**
   * The only polling loop. `seed` is the last attempt read for this monitor
   * (null when nothing has been read yet, e.g. after an uncertain POST);
   * `immediate` skips the first delay. A read failure pauses the monitor and
   * keeps the last known state; `reconnect()` resumes it.
   */
  async function watch(monitor: Monitor, seed: ExtractionAttempt | null, immediate: boolean) {
    const { signal } = monitor.controller
    const live = () => monitorRef.current === monitor && !signal.aborted
    if (!live()) return
    // Monitoring starts before the first poll: a fast run may already be terminal when it answers.
    watchedRunRef.current = monitor.extractionId
    let latest = seed
    try {
      while (latest === null || isActive(latest)) {
        if (!immediate) await pollingDelay(signal)
        immediate = false
        if (!live()) return
        const draftScope = draftSaveRef.current
        const pendingAtRead = draftScope.pending
        const response = await readExtraction(monitor.extractionId, signal)
        if (!live()) return
        latest = response.extraction
        monitor.partial = retainFinished(monitor.partial ?? null, response.partial ?? null)
        monitor.unacknowledged = undefined
        if (!latest.durable && latest.executionStatus === 'RUNNING' && !monitor.draftSeen &&
          draftSaveRef.current === draftScope && draftScope.writes === 0 && draftScope.pending === pendingAtRead) {
          monitor.draftSeen = true
          setRunDraft({ extractionId: latest.extractionId, version: response.reviewDraft?.version ?? 0,
            decisions: [...(response.reviewDraft?.decisions ?? [])] })
        }
        setAttempt(latest)
        setState(extractionStateFromAttempt(latest, monitor.partial))
      }
      monitorRef.current = null
      onTerminal(latest, monitor.isRerun)
    } catch (error) {
      if (!live()) return
      monitor.paused = true
      setMonitorError(
        error instanceof ApiRequestError && (error.status === 403 || error.status === 404)
          ? EXTRACTION_UNAVAILABLE
          : MONITOR_DISCONNECTED,
      )
    }
  }

  useEffect(() => () => stopMonitor(), [])
  useEffect(() => {
    if (!isActive(initialAttempt)) return
    stopMonitor()
    const monitor: Monitor = {
      extractionId: initialAttempt!.extractionId,
      isRerun: true,
      paused: false,
      controller: new AbortController(),
    }
    monitorRef.current = monitor
    // Deferred so the effect body itself schedules no state update; an
    // aborted monitor (StrictMode re-run, unmount) exits on its first check.
    void Promise.resolve().then(() => watch(monitor, initialAttempt, false))
    return () => {
      monitor.controller.abort()
      if (monitorRef.current === monitor) monitorRef.current = null
    }
  }, [documentKey, initialAttempt?.extractionId])

  function reconnect() {
    const monitor = monitorRef.current
    if (!monitor?.paused) return
    monitor.paused = false
    monitor.draftSeen = false
    setMonitorError(null)
    void watch(monitor, attempt?.extractionId === monitor.extractionId ? attempt : null, true)
  }

  const hasResults = state.status === 'ready' || state.status === 'retained'
  const activeAttempt = isActive(attempt)
  const canRun =
    reviewTarget?.schemaRevisionId != null &&
    schemaReady &&
    !activeAttempt &&
    (!attempt?.durable || ['COMPLETED','STOPPED'].includes(attempt.executionStatus)) &&
    !indexing
  // A different Source Representation still blocks new decisions; a newer
  // Current Schema Revision does not, because the backend validates decisions
  // against the revision pinned by the Extraction itself.
  const reviewAvailable = Boolean(
    attempt?.outcome === 'SUCCEEDED' &&
    attempt.executionStatus === 'COMPLETED' &&
    attempt.reviewable &&
    attempt.sourceRepresentationRevisionId === reviewTarget?.sourceRepresentationId,
  )
  const canSave = Boolean(
    !saving &&
    !draftError &&
    !reviewLoading &&
    reviewAvailable &&
    reviewReadFor === attempt?.extractionId &&
    attempt?.reviewedAt === null
  )
  const canAccept = canSave && everyRequiredTouched(reviewDecisions, touchedPaths)
  // One function per touched set: the rail's model and the document's marks recompute only when it changes.
  const isTouched = useCallback((resultPath: ReviewDecisionInput['resultPath']) => touchedPaths.has(resultPathKey(resultPath)), [touchedPaths])
  // A record kei has finished can be decided on while the run goes on, as a draft (ADR 0016; §5.1).
  const runningPartial = state.status === 'running' ? state.partial : null
  const draftAvailable = Boolean(
    !attempt?.durable &&
    attempt?.executionStatus === 'RUNNING' &&
    attempt.sourceRepresentationRevisionId === reviewTarget?.sourceRepresentationId &&
    occurrenceIdsByAnchor &&
    runningPartial?.records.some((record) => record.state === 'finished'),
  )
  const reviewable = reviewAvailable || draftAvailable
  const acceptDurableStatus=useCallback((extractionId:string,executionStatus:ExtractionAttempt['executionStatus'])=> {
    const previous=currentAttemptRef.current
    if(!previous?.durable||previous.extractionId!==extractionId)return
    // One observer owns native status after the retained reader is mounted.
    if(monitorRef.current?.extractionId===extractionId){monitorRef.current.controller.abort();monitorRef.current=null}
    if(previous.executionStatus===executionStatus)return
    const next={...previous,executionStatus}
    currentAttemptRef.current=next
    setAttempt(next);setState(extractionStateFromAttempt(next))
  },[])

  // While the run reads: the draft adopted once from the server, then every record kei finishes adds its prepared
  // decisions. A poll never overwrites a decision made on screen (plan Ruling 21).
  useEffect(() => {
    if (!draftAvailable || !attempt || !runningPartial || !occurrenceIdsByAnchor) return
    let current = true
    // Deferred, as the review load is, so the effect body schedules no state update.
    void Promise.resolve().then(() => { if (current) mergeRunningDraft(attempt, runningPartial, occurrenceIdsByAnchor) })
    return () => { current = false }
    // mergeRunningDraft is redeclared each render and reads the draft through refs; runDraft is its one other input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftAvailable, attempt, runningPartial, occurrenceIdsByAnchor, runDraft])

  function mergeRunningDraft(attempt: ExtractionAttempt, runningPartial: PartialResult, occurrenceIdsByAnchor: ReadonlyMap<string, readonly string[]>) {
    const prepared = draftDecisionsFromPartial(runningPartial, occurrenceIdsByAnchor)
    // A decision made after a reconnect GET began owns its pending write; read again after it settles.
    if (decisionsForRef.current === attempt.extractionId && adoptedRunDraftRef.current !== runDraft &&
      (draftSaveRef.current.writes > 0 || (runDraft?.version ?? 0) < draftSaveRef.current.version)) {
      adoptedRunDraftRef.current = runDraft
      if (monitorRef.current?.extractionId === attempt.extractionId) monitorRef.current.draftSeen = false
    }
    if (decisionsForRef.current !== attempt.extractionId || adoptedRunDraftRef.current !== runDraft) {
      if (runDraft?.extractionId !== attempt.extractionId) return
      const restored = recoverReviewDraft(attempt.extractionId, runDraft, prepared)
      // A decision on a record the retained partial no longer shows stays in the draft; saves keep sending it.
      const shown = new Set(prepared.map((decision) => resultPathKey(decision.resultPath)))
      const decisions = [...restored.decisions, ...runDraft.decisions.filter((decision) => !shown.has(resultPathKey(decision.resultPath)))]
      // A failed write still belongs to this run. Reconnect must not silently replace it.
      const retainLocal = decisionsForRef.current === attempt.extractionId && Boolean(draftError)
      const conflict = retainLocal ? draftSaveRef.current.version !== runDraft.version : restored.conflict
      const adopted = retainLocal ? draftRef.current : { decisions, touched: restored.touchedPaths }
      if (!retainLocal && decidedOnRef.current.extractionId === attempt.extractionId) {
        const previous = new Map(draftRef.current.decisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
        for (const decision of adopted.decisions) {
          const key = resultPathKey(decision.resultPath)
          if (JSON.stringify(previous.get(key)) !== JSON.stringify(decision)) decidedOnRef.current.values.delete(key)
        }
      }
      adoptedRunDraftRef.current = runDraft
      decisionsForRef.current = attempt.extractionId
      draftSaveRef.current = { version: retainLocal && conflict ? draftSaveRef.current.version : restored.version,
        pending: Promise.resolve(), writes: 0, conflict }
      setDraftError(conflict ? REVIEW_DRAFT_CONFLICT : null)
      setDiscarded(null)
      setDraftSaved(!conflict && !retainLocal && !restored.retry && runDraft.version > 0)
      draftRef.current = adopted
      draftAcceptedRef.current = { decisions, touched: restored.touchedPaths }
      setReviewDecisions(adopted.decisions)
      setTouchedPaths(adopted.touched)
      if (!conflict && (retainLocal || restored.retry)) updateReview(adopted.decisions, adopted.touched)
      return
    }
    const present = new Set(draftRef.current.decisions.map((decision) => resultPathKey(decision.resultPath)))
    const added = prepared.filter((decision) => !present.has(resultPathKey(decision.resultPath)))
    if (added.length === 0) return
    const decisions = [...draftRef.current.decisions, ...added]
    draftRef.current = { ...draftRef.current, decisions }
    setReviewDecisions(decisions)
  }

  // Polling replaces RUNNING attempt objects; it must not cancel an explicit reload of the same Extraction.
  const reviewAttempt = activeAttempt ? attempt?.extractionId : attempt
  useEffect(() => {
    const controller = new AbortController()
    const load = ++reviewLoadRef.current
    void Promise.resolve().then(async () => {
      if (reviewLoadRef.current !== load) return
      setReviewError(null)
      const reloadRequested = reviewReloadRef.current !== reviewReload
      reviewReloadRef.current = reviewReload
      // Native corrections and their explicit reload belong to the durable review actor.
      if (attempt?.durable) {
        setReviewLoading(false)
        return
      }
      // Ordinary polls add records without replacing decisions. An explicit reload reads server authority.
      if (attempt && isActive(attempt)) {
        if (!reloadRequested) return
        setReviewLoading(true)
        try {
          const response = await readExtraction(attempt.extractionId, controller.signal)
          if (controller.signal.aborted || reviewLoadRef.current !== load) return
          setDraftError(null)
          decidedOnRef.current = { extractionId: null, values: new Map() }
          if (response.extraction.executionStatus === 'RUNNING') {
            setRunDraft({ extractionId: attempt.extractionId, version: response.reviewDraft?.version ?? 0,
              decisions: [...(response.reviewDraft?.decisions ?? [])] })
            setState((current) => current.status === 'running'
              ? extractionStateFromAttempt(response.extraction, retainFinished(current.partial, response.partial ?? null)) : current)
          } else {
            setAttempt(response.extraction)
            setState(extractionStateFromAttempt(response.extraction))
          }
        } catch (error) {
          if (reviewLoadRef.current === load) setReviewError(error instanceof Error ? error.message : 'Loading the review failed.')
        } finally {
          if (reviewLoadRef.current === load) setReviewLoading(false)
        }
        return
      }
      if (!reviewAvailable || !attempt) {
        setReviewLoading(false)
        if (attempt && decisionsForRef.current === attempt.extractionId) {
          // A run that stopped or failed has no result: its draft is never read again (§5.2).
          decisionsForRef.current = null
          setDiscarded(draftRef.current.touched.size)
        }
        if (attempt?.reviewedAt) {
          forgetReviewDraft(attempt.extractionId)
          const decisions = attempt.reviewDecisions.map(pendingDecision)
          setReviewDecisions(decisions)
          setTouchedPaths(new Set(decisions.map((decision) => resultPathKey(decision.resultPath))))
        } else {
          setReviewDecisions([])
          setTouchedPaths(new Set())
        }
        return
      }
      if (attempt.reviewedAt) {
        forgetReviewDraft(attempt.extractionId)
        setDraftError(null)
        setReviewLoading(false)
        const decisions = attempt.reviewDecisions.map(pendingDecision)
        setReviewDecisions(decisions)
        // Already-saved decisions were all explicitly made, not defaulted —
        // this is a read of a finalized review, so every field is "touched".
        setTouchedPaths(new Set(decisions.map((decision) => resultPathKey(decision.resultPath))))
        return
      }
      setReviewLoading(true)
      setReviewReadFor('')
      const fromRun = decisionsForRef.current === attempt.extractionId
      // Settlement keeps the run's decisions on screen while the settled review loads: nothing moves (§5.3).
      if (!fromRun) {
        setDraftSaved(false)
        setReviewDecisions([])
        setTouchedPaths(new Set())
      }
      try {
        const prepared = await readExtraction(
          attempt.extractionId,
          controller.signal,
        )
        if (controller.signal.aborted || reviewLoadRef.current !== load) return
        if (prepared.extraction.reviewedAt) {
          forgetReviewDraft(attempt.extractionId)
          setAttempt(prepared.extraction)
          setState(extractionStateFromAttempt(prepared.extraction))
          const decisions =
            prepared.extraction.reviewDecisions.map(pendingDecision)
          setReviewDecisions(decisions)
          setTouchedPaths(
            new Set(
              decisions.map((decision) => resultPathKey(decision.resultPath)),
            ),
          )
          return
        }
        const restored = recoverReviewDraft(attempt.extractionId, prepared.reviewDraft, prepared.pendingReviewDecisions ?? [])
        const dropped = prepared.reviewDraft?.dropped ?? []
        const decidedOn = decidedOnRef.current.extractionId === attempt.extractionId ? decidedOnRef.current.values : new Map<string, unknown>()
        const reconciled = fromRun || dropped.length > 0
          ? reconcileAtSettlement({ recovered: restored, prepared: prepared.pendingReviewDecisions ?? [], result: prepared.extraction.resultPayload,
              decidedOn, dropped })
          : null
        const recovered = reconciled ? { ...restored, decisions: reconciled.decisions, touchedPaths: reconciled.touchedPaths } : restored
        decisionsForRef.current = attempt.extractionId
        if (reconciled) setChangedAfterReview(reconciled.changed)
        if (fromRun || watchedRunRef.current === attempt.extractionId) {
          watchedRunRef.current = null
          setSettlement({ kept: reconciled?.kept ?? 0, changed: reconciled?.changed.size ?? 0 })
        }
        setReviewReadFor(attempt.extractionId)
        draftSaveRef.current = { version: recovered.version, pending: Promise.resolve(), writes: 0, conflict: recovered.conflict }
        // Version-zero drafts have not been acknowledged by the server.
        setDraftSaved(!recovered.conflict && !recovered.retry && (prepared.reviewDraft?.version ?? 0) > 0)
        setDraftError(recovered.conflict ? REVIEW_DRAFT_CONFLICT : null)
        draftRef.current = { decisions: recovered.decisions, touched: recovered.touchedPaths }
        setReviewDecisions(
          recovered.decisions,
        )
        setTouchedPaths(recovered.touchedPaths)
        if (recovered.retry) updateReview(recovered.decisions, recovered.touchedPaths)
      } catch (error) {
        if (reviewLoadRef.current !== load) return
        setReviewError(
          error instanceof Error ? error.message : 'Loading the review failed.',
        )
      } finally {
        if (reviewLoadRef.current === load) setReviewLoading(false)
      }
    })
    return () => {
      controller.abort()
      reviewLoadRef.current += 1
    }
    // The active attempt identity, rather than each poll object, owns a running reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewAttempt, reviewAvailable, documentKey, reviewReload])

  /** Cancels the acknowledged active attempt; before the server acknowledges a run there is nothing to cancel. */
  async function requestCancellation() {
    if (!activeAttempt || !attempt || cancellationRequested) return
    setCancellationRequested(true)
    setCancellationError(null)
    try {
      await cancelExtraction(attempt.extractionId)
    } catch (error) {
      setCancellationRequested(false)
      setCancellationError(error instanceof Error ? error.message : 'Cancellation failed.')
    }
  }

  /**
   * Posts the Extraction, then hands the generated identity to the monitor.
   * Resolves with the persisted attempt once the server has acknowledged it,
   * or null when the request was definitely rejected. An uncertain outcome
   * (network failure, gateway error) is reconciled by reading the same
   * identity rather than by posting again, so the admitted run keeps the
   * method it was requested with (design §7).
   */
  async function runRequest(isRerun: boolean, request: ExtractionRunRequest) {
    const running = monitorRef.current
    if (!schemaReady || activeAttempt || (running !== null && !running.paused) || indexing)
      return null
    stopMonitor()
    // Only while an uncertain admission of this same request is unresolved (its monitor paused before any read
    // answered) does running it again post the same identity, which admission replays if it did commit (design §4).
    // A refusal, an acknowledgement, a reopened document or another request always starts a new identity.
    const unacknowledged = JSON.stringify(request)
    const monitor: Monitor = {
      extractionId: running?.paused && running.unacknowledged === unacknowledged ? running.extractionId : crypto.randomUUID(),
      unacknowledged,
      isRerun,
      paused: false,
      controller: new AbortController(),
    }
    monitorRef.current = monitor
    setReviewError(null)
    setDraftError(null)
    setCancellationRequested(false)
    setCancellationError(null)
    setMonitorError(null)
    setState({ status: 'running', step: 'extraction', partial: null })
    let seed: ExtractionAttempt | null = null
    try {
      seed = await requestExtraction(
        { id: monitor.extractionId, ...request },
        monitor.controller.signal,
      )
    } catch (error) {
      if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
      if (definiteRejection(error) && error.code === SOURCE_REPRESENTATION_SUPERSEDED) {
        // Nothing started: the earlier attempt and its results stay as they were.
        monitorRef.current = null
        setState(extractionStateFromAttempt(attempt))
        onSuperseded?.()
        return null
      }
      if (definiteRejection(error) && (error.code === METHOD_CHANGED || error.code === MIGRATION_REQUIRED || RECORD_SCOPE_REFUSALS.has(error.code ?? ''))) {
        // Nothing started: the previous attempt stays, and the caller re-reads the saved method or says why.
        monitorRef.current = null
        setState(extractionStateFromAttempt(attempt))
        onMethodChanged?.(serverMessage(error), error.code!)
        return null
      }
      if (definiteRejection(error)) {
        monitorRef.current = null
        setState({ status: 'error', message: error.message })
        onError(error.message)
        return null
      }
    }
    if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
    if (seed) {
      monitor.unacknowledged = undefined
      setAttempt(seed)
      setState(extractionStateFromAttempt(seed))
      setReviewDecisions([])
      setTouchedPaths(new Set())
    }
    void watch(monitor, seed, seed === null)
    return seed
  }

  async function runExtraction(
    method: ExtractionMethodIntent,
    target: ReviewTarget | null = reviewTarget,
    strategy: ExtractionStrategy = 'ARTICLE',
    catalogRecipe: string | null = null,
    startPage: number | null = null,
  ) {
    if (!target?.schemaRevisionId) return null
    return runRequest(attempt !== null, {
      sourceRepresentationRevisionId: target.sourceRepresentationId,
      schemaRevisionId: target.schemaRevisionId,
      strategy,
      ...(strategy === 'CATALOG' && catalogRecipe ? { catalogRecipe } : {}),
      ...(startPage === null ? {} : { startPage }),
      method,
    })
  }

  /** Saves the review; true once the server finalized it. */
  async function acceptResult(): Promise<boolean> {
    const scope = saveScopeRef.current
    // The draft ref, not this render's state: a researcher's last decision and its save happen in one handler.
    const { decisions, touched } = draftRef.current
    if (!attempt || !canSave || !everyRequiredTouched(decisions, touched) || scope.saving) return false
    scope.saving = true
    setSaving(true)
    setReviewError(null)
    try {
      const draft = draftSaveRef.current
      await draft.pending
      const finalized = await finalizeExtractionReview(
        attempt.extractionId,
        decisions.filter((decision) => touched.has(resultPathKey(decision.resultPath))),
        draft.version,
      )
      if (saveScopeRef.current !== scope) return false
      forgetReviewDraft(attempt.extractionId)
      setDraftError(null)
      setAttempt(finalized)
      return true
    } catch (error) {
      if (saveScopeRef.current !== scope) return false
      setReviewError(
        error instanceof Error ? error.message : 'Saving the review failed.',
      )
      return false
    } finally {
      if (saveScopeRef.current === scope) {
        scope.saving = false
        setSaving(false)
      }
    }
  }

  function updateReview(decisions: ReviewDecisionInput[], touched: ReadonlySet<string>) {
    if (!attempt) return
    draftRef.current = { decisions, touched }
    setReviewDecisions(decisions)
    setTouchedPaths(touched)
    const scope = draftSaveRef.current
    const saved = decisions.filter((decision) => touched.has(resultPathKey(decision.resultPath)))
    if (scope.conflict) {
      rememberReviewDraft(attempt.extractionId, { version: scope.version, decisions: saved })
      return
    }
    scope.writes += 1
    setDraftSaving(true)
    setDraftSaved(false)
    setDraftError(null)
    const previous = draftAcceptedRef.current
    const write = saveExtractionReviewDraft(attempt.extractionId, saved, scope.version)
    scope.pending = write.then((result) => {
      scope.version = result.version
      if (draftSaveRef.current === scope) {
        draftAcceptedRef.current = { decisions, touched }
        setDraftSaved(true)
      }
    })
    void scope.pending.catch((error: unknown) => {
      if (draftSaveRef.current !== scope) return
      if (isActive(attempt) && previous && error instanceof ApiRequestError && error.code === 'invalid_review') {
        // A running draft the server refused (an anchor not in the pinned document): back to the last accepted draft.
        draftRef.current = previous
        setReviewDecisions(previous.decisions)
        setTouchedPaths(previous.touched)
        setDraftRefused('This value can’t be reviewed: its Evidence is not in this document.')
        return
      }
      const message = error instanceof Error ? error.message : 'Draft could not be saved.'
      // Retrying a stale version can never succeed; only reloading server state can.
      if (message === REVIEW_DRAFT_CONFLICT) scope.conflict = true
      setDraftError(message)
    }).finally(() => {
      scope.writes -= 1
      if (draftSaveRef.current === scope) setDraftSaving(scope.writes > 0)
    })
  }

  function setReviewDecision(
    resultPath: ReviewDecisionInput['resultPath'],
    action: ReviewDecisionAction,
    reviewedValue: ReviewDecisionInput['reviewedValue'] = null,
    reviewedEvidence: ReviewDecisionInput['reviewedEvidence'] = null,
    touch = true,
  ): { last: boolean } {
    if (saveScopeRef.current.saving || !reviewable || reviewLoading || attempt?.reviewedAt) return { last: false }
    const key = resultPathKey(resultPath)
    if (!reviewDecisions.some((decision) => resultPathKey(decision.resultPath) === key)) return { last: false }
    const touched = new Set(draftRef.current.touched)
    if (touch) touched.add(key)
    else touched.delete(key)
    const decisions = draftRef.current.decisions.map((decision) => {
      if (resultPathKey(decision.resultPath) !== key) return decision
      const next = { ...decision, action, reviewedValue: action === 'EDITED' ? reviewedValue : null }
      if (action === 'EDITED' && reviewedEvidence) return { ...next, reviewedEvidence }
      delete (next as { reviewedEvidence?: unknown }).reviewedEvidence
      return next
    })
    if (!draftAcceptedRef.current) draftAcceptedRef.current = draftRef.current
    setDraftRefused(null)
    if (draftAvailable && attempt && runningPartial) {
      if (decidedOnRef.current.extractionId !== attempt.extractionId)
        decidedOnRef.current = { extractionId: attempt.extractionId, values: new Map() }
      decidedOnRef.current.values.set(key, partialValueAt(runningPartial, resultPath))
    }
    updateReview(decisions, touched)
    // The decision that leaves nothing to check saves the review; the tab says so before it and calls accept (§6).
    // While the run goes on nothing is the last: the review cannot be saved until it settles (§5.1).
    return { last: touch && !draftAvailable && everyRequiredTouched(decisions, touched) }
  }

  // Marks every field the researcher hasn't explicitly acted on as touched,
  // without changing its recorded action — every field already defaults to
  // 'APPROVED', so this only affects what the review UI displays.
  function approveAllRemaining() {
    if (saveScopeRef.current.saving || !reviewAvailable || reviewLoading || attempt?.reviewedAt) return
    const { decisions, touched } = draftRef.current
    updateReview(decisions, new Set([...touched, ...decisions.filter((decision) => decision.evidenceAnchorId !== null).map((decision) => resultPathKey(decision.resultPath))]))
  }

  return {
    state,
    attempt,
    canRun,
    hasResults,
    acceptDurableStatus,
    runExtraction,
    requestCancellation,
    cancellationRequested,
    cancellationError,
    /** Last status read failed; the last known attempt stays on screen. */
    monitorError,
    /** Reads the same Extraction again and resumes polling; never posts. */
    reconnect,
    review: {
      available: reviewAvailable,
      /** Decisions may be drafted on the records kei has finished while the run goes on (ADR 0016). */
      draftAvailable,
      /** Per decision made during the run in this session, the value it was made on (§5.3). */
      decidedOn: decidedOnRef.current.extractionId === attempt?.extractionId ? decidedOnRef.current.values as ReadonlyMap<string, unknown> : new Map<string, unknown>(),
      /** Result paths whose run-time decision was not kept at settlement: "changed after you reviewed it". */
      changedAfterReview,
      /** Set once at the terminal read of a run with drafted decisions: how many were kept, how many changed. */
      settlement,
      /** Decisions discarded with a run that stopped or failed; null when there were none to discard. */
      discarded,
      /** The server refused a running draft: the decision was reverted. */
      draftRefused,
      canAccept,
      saving,
      loading: reviewLoading,
      decisions: reviewDecisions,
      /** Decisions without Evidence are optional and do not count as required review. */
      requiredCount: reviewDecisions.filter((decision) => decision.evidenceAnchorId !== null).length,
      untouchedCount: reviewDecisions.filter(
        (decision) => decision.evidenceAnchorId !== null && !touchedPaths.has(resultPathKey(decision.resultPath)),
      ).length,
      isTouched,
      reviewedExtractionId: attempt?.reviewedAt
        ? attempt.extractionId
        : null,
      error: reviewError,
      draftError,
      draftSaving,
      draftSaved: draftSaved && !draftSaving && !draftError,
      /** Reads the review again after it failed to load. */
      reload: () => setReviewReload((value) => value + 1),
      retryDraft: () => {
        if (draftSaveRef.current.conflict && attempt) {
          forgetReviewDraft(attempt.extractionId)
          setReviewReload((value) => value + 1)
        } else updateReview(draftRef.current.decisions, draftRef.current.touched)
      },
      setDecision: setReviewDecision,
      /** Back to the untouched default: approved, no correction, not yet decided by the researcher. */
      undo: (resultPath: ReviewDecisionInput['resultPath']) => setReviewDecision(resultPath, 'APPROVED', null, null, false),
      approveAll: approveAllRemaining,
      accept: acceptResult,
    },
  }
}
