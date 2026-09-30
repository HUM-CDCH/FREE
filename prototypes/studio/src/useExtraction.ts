import { useEffect, useRef, useState } from 'react'
import { forgetReviewDraft, recoverReviewDraft, rememberReviewDraft, REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import {
  cancelExtraction,
  ExtractionRequestError,
  finalizeExtractionReview,
  saveExtractionReviewDraft,
  readExtraction,
  requestExtraction,
} from './api'
import type { ExtractionState } from './extraction'
import {
  type ExtractionAttempt,
  type ExtractionRetrySelection,
  type ExtractionStrategy,
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


export type ExtractionRetryInput = Omit<ExtractionRetrySelection, 'retryOfId'>

type ExtractionRunRequest =
  | Readonly<{
      sourceRepresentationRevisionId: string
      schemaRevisionId: string
      strategy: ExtractionStrategy
    }>
  | Readonly<{ retryOfId: string } & ExtractionRetryInput>

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
  /** Fired once a review is finalized (accepted) — the caller's cue that
   *  this can move the project's workflow phase (extract -> validate). */
  onReviewAccepted?: () => void
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
}

function isActive(attempt: ExtractionAttempt | null): boolean {
  return attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING'
}

function definiteRejection(error: unknown): error is ExtractionRequestError {
  return error instanceof ExtractionRequestError && error.status >= 400 && error.status < 500
}

export type ExtractionController = ReturnType<typeof useExtraction>

export function extractionStateFromAttempt(attempt: ExtractionAttempt | null): ExtractionState {
  if (!attempt) return { status: 'idle' }
  const active = isActive(attempt)
  if (!attempt.resultPayload) {
    if (active) return { status: 'running', step: 'extraction' }
    if (attempt.failure?.code === 'cancelled' || attempt.outcome === 'CANCELLED')
      return { status: 'cancelled' }
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
  onReviewAccepted,
  initialAttempt = null,
  reviewTarget = null,
  documentKey = '',
}: UseExtractionOptions) {
  const [attempt, setAttempt] = useState<ExtractionAttempt | null>(
    initialAttempt,
  )
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
  const draftRef = useRef({ decisions: reviewDecisions, touched: touchedPaths })
  draftRef.current = { decisions: reviewDecisions, touched: touchedPaths }
  const [reviewError, setReviewError] = useState<string | null>(null)
  const draftSaveRef = useRef({ version: 0, pending: Promise.resolve(), writes: 0, conflict: false })
  const [reviewReload, setReviewReload] = useState(0)
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [cancellationRequested, setCancellationRequested] = useState(false)
  const [cancellationError, setCancellationError] = useState<string | null>(null)
  const [monitorError, setMonitorError] = useState<string | null>(null)
  const monitorRef = useRef<Monitor | null>(null)
  const reviewLoadRef = useRef(0)
  const saveScopeRef = useRef({ saving: false })

  function stopMonitor() {
    monitorRef.current?.controller.abort()
    monitorRef.current = null
  }

  // Reset during render (not in an effect) when the document or attempt
  // change, so no frame renders the previous document's state. A change of
  // the Current Schema Revision alone touches nothing here: polling, drafts
  // and decisions stay bound to the Extraction's own revision.
  const [rendered, setRendered] = useState({ documentKey, extractionId: attempt?.extractionId })
  const documentChanged = rendered.documentKey !== documentKey
  const nextAttempt = documentChanged ? initialAttempt : attempt
  if (documentChanged || rendered.extractionId !== nextAttempt?.extractionId) {
    setRendered({ documentKey, extractionId: nextAttempt?.extractionId })
    // In-flight saves and draft writes belong to the previous document or attempt.
    saveScopeRef.current = { saving: false }
    draftSaveRef.current = { version: 0, pending: Promise.resolve(), writes: 0, conflict: false }
    setDraftSaving(false)
    setSaving(false)
    if (documentChanged) {
      // Orphaned reads notice the missing monitor and drop their response.
      monitorRef.current = null
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
    let latest = seed
    try {
      while (latest === null || isActive(latest)) {
        if (!immediate) await pollingDelay(signal)
        immediate = false
        if (!live()) return
        latest = (await readExtraction(monitor.extractionId, signal)).extraction
        if (!live()) return
        setAttempt(latest)
        setState(extractionStateFromAttempt(latest))
      }
      monitorRef.current = null
      onTerminal(latest, monitor.isRerun)
    } catch (error) {
      if (!live()) return
      monitor.paused = true
      setMonitorError(
        error instanceof ExtractionRequestError && (error.status === 403 || error.status === 404)
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
    setMonitorError(null)
    void watch(monitor, attempt?.extractionId === monitor.extractionId ? attempt : null, true)
  }

  const hasResults = state.status === 'ready'
  const activeAttempt = isActive(attempt)
  const canRun =
    reviewTarget?.schemaRevisionId != null &&
    schemaReady &&
    !activeAttempt &&
    !indexing
  // A different Source Representation still blocks new decisions; a newer
  // Current Schema Revision does not, because the backend validates decisions
  // against the revision pinned by the Extraction itself.
  const reviewAvailable = Boolean(
    attempt?.outcome === 'SUCCEEDED' &&
    attempt.executionStatus === 'COMPLETED' &&
    attempt.reviewable &&
    (attempt.evidenceLinks?.length ?? 0) > 0 &&
    attempt.sourceRepresentationRevisionId === reviewTarget?.sourceRepresentationId,
  )
  const canAccept = Boolean(
    !saving &&
    !draftError &&
    !reviewLoading &&
    reviewAvailable &&
    attempt?.reviewedAt === null &&
    reviewDecisions.length > 0 &&
    reviewDecisions.every((decision) => touchedPaths.has(resultPathKey(decision.resultPath)))
  )

  useEffect(() => {
    const controller = new AbortController()
    const load = ++reviewLoadRef.current
    void Promise.resolve().then(async () => {
      if (reviewLoadRef.current !== load) return
      setReviewError(null)
      if (!reviewAvailable || !attempt) {
        setReviewLoading(false)
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
      setReviewDecisions([])
      setTouchedPaths(new Set())
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
        const recovered = recoverReviewDraft(attempt.extractionId, prepared.reviewDraft, prepared.pendingReviewDecisions ?? [])
        draftSaveRef.current = { version: recovered.version, pending: Promise.resolve(), writes: 0, conflict: recovered.conflict }
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
  }, [attempt, reviewAvailable, documentKey, reviewReload])

  async function requestCancellation() {
    const id = monitorRef.current?.extractionId ?? attempt?.extractionId
    if ((!activeAttempt && state.status !== 'running') || !id || cancellationRequested) return
    setCancellationRequested(true)
    setCancellationError(null)
    try {
      await cancelExtraction(id)
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
   * identity rather than by posting again.
   */
  async function runRequest(isRerun: boolean, request: ExtractionRunRequest) {
    const running = monitorRef.current
    if (!schemaReady || activeAttempt || (running !== null && !running.paused) || indexing)
      return null
    stopMonitor()
    const monitor: Monitor = {
      extractionId: crypto.randomUUID(),
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
    setState({ status: 'running', step: 'extraction' })
    let seed: ExtractionAttempt | null = null
    try {
      seed = await requestExtraction(
        { id: monitor.extractionId, ...request },
        monitor.controller.signal,
      )
    } catch (error) {
      if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
      if (definiteRejection(error)) {
        monitorRef.current = null
        setState({ status: 'error', message: error.message })
        onError(error.message)
        return null
      }
    }
    if (monitorRef.current !== monitor || monitor.controller.signal.aborted) return null
    if (seed) {
      setAttempt(seed)
      setState(extractionStateFromAttempt(seed))
      setReviewDecisions([])
      setTouchedPaths(new Set())
    }
    void watch(monitor, seed, seed === null)
    return seed
  }

  async function runExtraction(
    target: ReviewTarget | null = reviewTarget,
    strategy: ExtractionStrategy = 'ARTICLE',
  ) {
    if (!target?.schemaRevisionId) return null
    return runRequest(attempt !== null, {
      sourceRepresentationRevisionId: target.sourceRepresentationId,
      schemaRevisionId: target.schemaRevisionId,
      strategy,
    })
  }

  async function retryExtraction(selection: ExtractionRetryInput) {
    const parent = attempt
    if (!parent || parent.strategy !== 'CATALOG') return null
    return runRequest(true, { retryOfId: parent.extractionId, ...selection })
  }

  async function acceptResult() {
    const scope = saveScopeRef.current
    if (!attempt || !canAccept || scope.saving) return
    scope.saving = true
    setSaving(true)
    setReviewError(null)
    try {
      const draft = draftSaveRef.current
      await draft.pending
      const finalized = await finalizeExtractionReview(
        attempt.extractionId,
        reviewDecisions,
        draft.version,
      )
      if (saveScopeRef.current !== scope) return
      forgetReviewDraft(attempt.extractionId)
      setDraftError(null)
      setAttempt(finalized)
      onReviewAccepted?.()
    } catch (error) {
      if (saveScopeRef.current !== scope) return
      setReviewError(
        error instanceof Error ? error.message : 'Saving the review failed.',
      )
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
    if (scope.conflict) {
      rememberReviewDraft(attempt.extractionId, { version: scope.version, decisions: decisions.filter((decision) => touched.has(resultPathKey(decision.resultPath))) })
      return
    }
    scope.writes += 1
    setDraftSaving(true)
    setDraftError(null)
    const write = saveExtractionReviewDraft(attempt.extractionId,
      decisions.filter((decision) => touched.has(resultPathKey(decision.resultPath))), scope.version)
    scope.pending = write.then((saved) => { scope.version = saved.version })
    void scope.pending.catch((error: unknown) => {
      if (draftSaveRef.current !== scope) return
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
  ) {
    if (saveScopeRef.current.saving || !reviewAvailable || reviewLoading || attempt?.reviewedAt) return
    const key = resultPathKey(resultPath)
    if (!reviewDecisions.some((decision) => resultPathKey(decision.resultPath) === key)) return
    updateReview(draftRef.current.decisions.map((decision) =>
      resultPathKey(decision.resultPath) === key
        ? { ...decision, action, reviewedValue: action === 'EDITED' ? reviewedValue : null }
        : decision,
    ), new Set(draftRef.current.touched).add(key))
  }

  // Marks every field the researcher hasn't explicitly acted on as touched,
  // without changing its recorded action — every field already defaults to
  // 'APPROVED', so this only affects what the review UI displays.
  function approveAllRemaining() {
    if (saveScopeRef.current.saving || !reviewAvailable || reviewLoading || attempt?.reviewedAt) return
    const { decisions, touched } = draftRef.current
    updateReview(decisions, new Set([...touched, ...decisions.map((decision) => resultPathKey(decision.resultPath))]))
  }

  return {
    state,
    attempt,
    canRun,
    hasResults,
    runExtraction,
    retryExtraction,
    requestCancellation,
    cancellationRequested,
    cancellationError,
    /** Last status read failed; the last known attempt stays on screen. */
    monitorError,
    /** Reads the same Extraction again and resumes polling; never posts. */
    reconnect,
    review: {
      available: reviewAvailable,
      canAccept,
      saving,
      loading: reviewLoading,
      decisions: reviewDecisions,
      reviewedCount: reviewDecisions.length,
      untouchedCount: reviewDecisions.filter(
        (decision) => !touchedPaths.has(resultPathKey(decision.resultPath)),
      ).length,
      isTouched: (resultPath: ReviewDecisionInput['resultPath']) =>
        touchedPaths.has(resultPathKey(resultPath)),
      reviewedExtractionId: attempt?.reviewedAt
        ? attempt.extractionId
        : null,
      error: reviewError,
      draftError,
      draftSaving,
      retryDraft: () => {
        if (draftSaveRef.current.conflict && attempt) {
          forgetReviewDraft(attempt.extractionId)
          setReviewReload((value) => value + 1)
        } else updateReview(draftRef.current.decisions, draftRef.current.touched)
      },
      setDecision: setReviewDecision,
      approveAll: approveAllRemaining,
      accept: acceptResult,
    },
  }
}
