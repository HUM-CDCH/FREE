import { useEffect, useRef, useState } from 'react'
import type { ExtractionMethodIntent } from 'extraction/extraction-method'
import { forgetReviewDraft, recoverReviewDraft, rememberReviewDraft, REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import {
  ApiRequestError,
  cancelExtraction,
  finalizeExtractionReview,
  saveExtractionReviewDraft,
  readExtraction,
  requestExtraction,
} from './api'
import type { ExtractionState } from './extraction'
import {
  type ExtractionAttempt,
  type ExtractionStrategy,
  type ReviewDecisionAction,
  type ReviewDecisionInput,
  type ReviewPairing,
  type ReviewTransferVerdicts,
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
  /** The saved method the start view showed; admission refuses it if the account's changed since. */
  method: ExtractionMethodIntent
  /** A Sample Extraction's pages; absent for the whole document. */
  pages?: number[]
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
  /** The account's saved advanced settings changed after the start view showed them: nothing started. */
  onMethodChanged?: (message: string) => void
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
  /** The request this monitor posted, when the server has not acknowledged it (JSON). */
  unacknowledged?: string
}

function isActive(attempt: ExtractionAttempt | null): boolean {
  return attempt?.executionStatus === 'QUEUED' || attempt?.executionStatus === 'RUNNING'
}

function definiteRejection(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && error.status >= 400 && error.status < 500
}

/** PR #140: a run on a Source Representation that reprocessing replaced is refused before anything starts. */
const SOURCE_REPRESENTATION_SUPERSEDED = 'source_representation_superseded'
const METHOD_CHANGED = 'method_changed'

export type ExtractionController = ReturnType<typeof useExtraction>

export function extractionStateFromAttempt(attempt: ExtractionAttempt | null): ExtractionState {
  if (!attempt) return { status: 'idle' }
  const active = isActive(attempt)
  if (!attempt.resultPayload) {
    if (active) return { status: 'running', step: 'extraction' }
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
  // The review transfer's verdicts, for the attempt they were read with.
  const [transfer, setTransfer] = useState<{
    extractionId: string; verdicts: ReviewTransferVerdicts; pairings: ReviewPairing[]; sources: { extractionId: string; record: number; label: string }[]
  }>({ extractionId: '', verdicts: {}, pairings: [], sources: [] })
  const [draftSaving, setDraftSaving] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
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
    setDraftSaved(false)
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
        monitor.unacknowledged = undefined
        setAttempt(latest)
        setState(extractionStateFromAttempt(latest))
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
      setDraftSaved(false)
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
        setTransfer({ extractionId: attempt.extractionId, verdicts: prepared.reviewDraft?.transfer ?? {},
          pairings: prepared.reviewDraft?.pairings ?? [], sources: prepared.reviewDraft?.sources ?? [] })
        const recovered = recoverReviewDraft(attempt.extractionId, prepared.reviewDraft, prepared.pendingReviewDecisions ?? [])
        draftSaveRef.current = { version: recovered.version, pending: Promise.resolve(), writes: 0, conflict: recovered.conflict }
        // Carried decisions can be prepared at version zero without a saved draft.
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
  }, [attempt, reviewAvailable, documentKey, reviewReload])

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
    setState({ status: 'running', step: 'extraction' })
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
      if (definiteRejection(error) && error.code === METHOD_CHANGED) {
        // Nothing started: the previous attempt stays, and the start view refreshes its summary.
        monitorRef.current = null
        setState(extractionStateFromAttempt(attempt))
        onMethodChanged?.(error.message)
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
    pages: number[] | null = null,
  ) {
    if (!target?.schemaRevisionId) return null
    return runRequest(attempt !== null, {
      sourceRepresentationRevisionId: target.sourceRepresentationId,
      schemaRevisionId: target.schemaRevisionId,
      strategy,
      ...(strategy === 'CATALOG' && catalogRecipe ? { catalogRecipe } : {}),
      method,
      ...(pages ? { pages } : {}),
    })
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
    setDraftSaved(false)
    setDraftError(null)
    const write = saveExtractionReviewDraft(attempt.extractionId,
      decisions.filter((decision) => touched.has(resultPathKey(decision.resultPath))), scope.version)
    scope.pending = write.then((saved) => {
      scope.version = saved.version
      if (draftSaveRef.current === scope) setDraftSaved(true)
    })
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
    reviewedEvidence: ReviewDecisionInput['reviewedEvidence'] = null,
    touch = true,
  ) {
    if (saveScopeRef.current.saving || !reviewAvailable || reviewLoading || attempt?.reviewedAt) return
    const key = resultPathKey(resultPath)
    if (!reviewDecisions.some((decision) => resultPathKey(decision.resultPath) === key)) return
    const touched = new Set(draftRef.current.touched)
    if (touch) touched.add(key)
    else touched.delete(key)
    updateReview(draftRef.current.decisions.map((decision) => {
      if (resultPathKey(decision.resultPath) !== key) return decision
      const next = { ...decision, action, reviewedValue: action === 'EDITED' ? reviewedValue : null }
      // The researcher's own decision now, no longer one carried from a sample.
      delete (next as { carriedFrom?: unknown }).carriedFrom
      if (action === 'EDITED' && reviewedEvidence) return { ...next, reviewedEvidence }
      delete (next as { reviewedEvidence?: unknown }).reviewedEvidence
      return next
    }), touched)
  }

  /** Saves the hand pairings with the draft (the server carries a paired record's decisions or drops an unpaired
   *  one's), then reads the review again. */
  function pairRecords(pairings: ReviewPairing[]) {
    const scope = draftSaveRef.current
    if (!attempt || saveScopeRef.current.saving || attempt.reviewedAt || scope.conflict) return
    const { decisions, touched } = draftRef.current
    scope.writes += 1
    setDraftSaving(true)
    setDraftSaved(false)
    setDraftError(null)
    scope.pending = saveExtractionReviewDraft(attempt.extractionId,
      decisions.filter((decision) => touched.has(resultPathKey(decision.resultPath))), scope.version, pairings)
      .then((saved) => {
        scope.version = saved.version
        if (draftSaveRef.current !== scope) return
        setDraftSaved(true)
        setReviewReload((value) => value + 1)
      })
    void scope.pending.catch((error: unknown) => {
      if (draftSaveRef.current === scope) setDraftError(error instanceof Error ? error.message : 'Draft could not be saved.')
    }).finally(() => {
      scope.writes -= 1
      if (draftSaveRef.current === scope) setDraftSaving(scope.writes > 0)
    })
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
      /** The server prepares one required decision per grounded value. */
      requiredCount: reviewDecisions.length,
      untouchedCount: reviewDecisions.filter(
        (decision) => !touchedPaths.has(resultPathKey(decision.resultPath)),
      ).length,
      isTouched: (resultPath: ReviewDecisionInput['resultPath']) =>
        touchedPaths.has(resultPathKey(resultPath)),
      /** Each value's verdict against the reviewed samples this run pinned; empty when it pinned none. */
      transfer: transfer.extractionId === attempt?.extractionId ? transfer.verdicts : {},
      /** Hand pairings of unmatched records, the pinned sample records still pairable, and the pairing action. */
      pairing: {
        pairings: transfer.extractionId === attempt?.extractionId ? transfer.pairings : [],
        sources: transfer.extractionId === attempt?.extractionId ? transfer.sources : [],
        pair: pairRecords,
      },
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
