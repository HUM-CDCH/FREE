import { useEffect, useRef, useState } from 'react'
import { forgetReviewDraft, recoverReviewDraft, rememberReviewDraft, REVIEW_DRAFT_CONFLICT } from './reviewDrafts'
import {
  cancelExtraction,
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
  schemaRevisionId: string
}

type UseExtractionOptions = {
  schemaReady: boolean
  indexing: boolean
  onTerminal: (attempt: ExtractionAttempt, isRerun: boolean) => void
  onError: (message: string) => void
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

export type ExtractionController = ReturnType<typeof useExtraction>

export function extractionStateFromAttempt(attempt: ExtractionAttempt | null): ExtractionState {
  if (!attempt) return { status: 'idle' }
  const active = attempt.executionStatus === 'QUEUED' || attempt.executionStatus === 'RUNNING'
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

function sameTarget(
  attempt: ExtractionAttempt | null,
  target: ReviewTarget | null,
) {
  return (
    attempt?.sourceRepresentationRevisionId ===
      target?.sourceRepresentationId &&
    attempt?.schemaRevisionId === target?.schemaRevisionId
  )
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
  const abortRef = useRef<AbortController | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const runInputsKey = `${reviewTarget?.sourceRepresentationId ?? ''}\n${reviewTarget?.schemaRevisionId ?? ''}`
  const previousInputsRef = useRef(runInputsKey)
  const reviewLoadRef = useRef(0)
  const saveScopeRef = useRef({ saving: false })
  useEffect(() => {
    saveScopeRef.current = { saving: false }
    draftSaveRef.current = { version: 0, pending: Promise.resolve(), writes: 0, conflict: false }
    setDraftSaving(false)
    setSaving(false)
    return () => { saveScopeRef.current = { saving: false } }
  }, [documentKey, attempt?.extractionId])
  const [renderedDocumentKey, setRenderedDocumentKey] = useState(documentKey)

  if (renderedDocumentKey !== documentKey) {
    activeIdRef.current = null
    setRenderedDocumentKey(documentKey)
    setAttempt(initialAttempt)
    setState(extractionStateFromAttempt(initialAttempt))
    setReviewDecisions([])
    setTouchedPaths(new Set())
    setReviewError(null)
    setDraftError(null)
    setCancellationRequested(false)
    setCancellationError(null)
  }

  function abandonRunning() {
    activeIdRef.current = null
    abortRef.current?.abort()
    abortRef.current = null
  }

  useEffect(() => () => abandonRunning(), [])
  useEffect(() => {
    if (!initialAttempt ||
        (initialAttempt.executionStatus !== 'QUEUED' &&
          initialAttempt.executionStatus !== 'RUNNING')) return
    const controller = new AbortController()
    abortRef.current = controller
    activeIdRef.current = initialAttempt.extractionId
    void (async () => {
      let current = initialAttempt
      try {
        while (current.executionStatus === 'QUEUED' || current.executionStatus === 'RUNNING') {
          await pollingDelay(controller.signal)
          if (controller.signal.aborted) return
          current = (await readExtraction(
            initialAttempt.extractionId,
            controller.signal,
          )).extraction
          if (
            controller.signal.aborted ||
            activeIdRef.current !== initialAttempt.extractionId
          )
            return
          setAttempt(current)
          setState(extractionStateFromAttempt(current))
        }
        if (
          controller.signal.aborted ||
          activeIdRef.current !== initialAttempt.extractionId
        )
          return
        onTerminal(current, true)
      } catch (error) {
        if (
          !controller.signal.aborted &&
          activeIdRef.current === initialAttempt.extractionId
        )
          onError(error instanceof Error ? error.message : 'Extraction polling failed.')
      } finally {
        if (
          activeIdRef.current === initialAttempt.extractionId &&
          abortRef.current === controller
        )
          activeIdRef.current = null
        if (abortRef.current === controller) abortRef.current = null
      }
    })()
    return () => controller.abort()
  }, [documentKey, initialAttempt?.extractionId])
  useEffect(() => {
    if (previousInputsRef.current === runInputsKey) return
    previousInputsRef.current = runInputsKey
    if (reviewTarget === null || sameTarget(attempt, reviewTarget)) return
    abandonRunning()
    setState((current) =>
      current.status === 'running' ? { status: 'idle' } : current,
    )
    setReviewDecisions([])
    setTouchedPaths(new Set())
    setReviewError(null)
  }, [runInputsKey])

  const hasResults = state.status === 'ready'
  const stale = attempt !== null && !sameTarget(attempt, reviewTarget)
  const activeAttempt = attempt?.executionStatus === 'QUEUED' ||
    attempt?.executionStatus === 'RUNNING'
  const canRun =
    reviewTarget !== null &&
    schemaReady &&
    !activeAttempt &&
    !indexing
  const reviewAvailable = Boolean(
    attempt?.outcome === 'SUCCEEDED' &&
    attempt.executionStatus === 'COMPLETED' &&
    attempt.reviewable &&
    (attempt.evidenceLinks?.length ?? 0) > 0 &&
    sameTarget(attempt, reviewTarget),
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
    const id = attempt?.extractionId ?? activeIdRef.current
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

  async function runRequest(isRerun: boolean, request: ExtractionRunRequest) {
    if (
      !schemaReady ||
      activeAttempt ||
      activeIdRef.current !== null ||
      indexing
    )
      return null
    abandonRunning()
    const controller = new AbortController()
    const extractionId = crypto.randomUUID()
    abortRef.current = controller
    activeIdRef.current = extractionId
    setReviewError(null)
    setDraftError(null)
    setCancellationRequested(false)
    setCancellationError(null)
    setState({ status: 'running', step: 'extraction' })
    try {
      let current = await requestExtraction(
        { id: extractionId, ...request },
        controller.signal,
      )
      if (controller.signal.aborted || activeIdRef.current !== extractionId) return
      setAttempt(current)
      setState(extractionStateFromAttempt(current))
      setReviewDecisions([])
      setTouchedPaths(new Set())
      while (
        current.executionStatus === 'QUEUED' ||
        current.executionStatus === 'RUNNING'
      ) {
        await pollingDelay(controller.signal)
        if (controller.signal.aborted) return
        current = (await readExtraction(extractionId, controller.signal)).extraction
        if (controller.signal.aborted || activeIdRef.current !== extractionId) return
        setAttempt(current)
        setState(extractionStateFromAttempt(current))
      }
      if (controller.signal.aborted || activeIdRef.current !== extractionId) return
      onTerminal(current, isRerun)
      return current
    } catch (error) {
      if (controller.signal.aborted) return
      const message =
        error instanceof Error ? error.message : 'Extraction failed.'
      setState({ status: 'error', message })
      onError(message)
      return null
    } finally {
      if (activeIdRef.current === extractionId) activeIdRef.current = null
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  async function runExtraction(
    target: ReviewTarget | null = reviewTarget,
    strategy: ExtractionStrategy = 'ARTICLE',
  ) {
    if (!target) return null
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
    stale,
    runExtraction,
    retryExtraction,
    requestCancellation,
    cancellationRequested,
    cancellationError,
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
