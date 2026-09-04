import { useEffect, useRef, useState } from 'react'
import {
  cancelExtraction,
  finalizeExtractionReview,
  readExtraction,
  requestExtraction,
} from './api'
import type { ExtractionState } from './extraction'
import {
  reviewDecisionInputSchema,
  type ExtractionAttempt,
  type ExtractionRetrySelection,
  type ExtractionStrategy,
  type ReviewDecisionAction,
  type ReviewDecisionInput,
} from '../shared/extraction.contract'
import { resultPathKey } from '../shared/groundedExtraction'
import {
  consumeSessionRecovery,
  registerSessionRecoveryCapture,
  removeSessionRecovery,
} from './auth/sessionRecovery'

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

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
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

function recoveredReview(
  value: unknown,
  prepared: readonly ReviewDecisionInput[],
): { decisions: ReviewDecisionInput[]; touchedPaths: Set<string> } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (!Array.isArray(candidate.decisions) || !Array.isArray(candidate.touchedPaths))
    return null
  const parsed = candidate.decisions.map((decision) =>
    reviewDecisionInputSchema.safeParse(decision),
  )
  if (parsed.some((decision) => !decision.success)) return null
  const decisions = parsed.map((decision) => decision.data!)
  if (decisions.length !== prepared.length) return null
  const byPath = new Map(
    decisions.map((decision) => [resultPathKey(decision.resultPath), decision]),
  )
  if (byPath.size !== decisions.length) return null
  const ordered = prepared.map((serverDecision) => {
    const recovered = byPath.get(resultPathKey(serverDecision.resultPath))
    return recovered &&
      recovered.evidenceAnchorId === serverDecision.evidenceAnchorId &&
      sameStrings(
        recovered.reviewedOccurrenceIds,
        serverDecision.reviewedOccurrenceIds,
      )
      ? recovered
      : null
  })
  if (ordered.some((decision) => decision === null)) return null
  if (!candidate.touchedPaths.every((path) => typeof path === 'string'))
    return null
  const validPaths = new Set(byPath.keys())
  const touchedPaths = new Set(candidate.touchedPaths as string[])
  if ([...touchedPaths].some((path) => !validPaths.has(path))) return null
  return {
    decisions: ordered as ReviewDecisionInput[],
    touchedPaths,
  }
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
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [cancellationRequested, setCancellationRequested] = useState(false)
  const [cancellationError, setCancellationError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const runInputsKey = `${reviewTarget?.sourceRepresentationId ?? ''}\n${reviewTarget?.schemaRevisionId ?? ''}`
  const previousInputsRef = useRef(runInputsKey)
  const reviewLoadRef = useRef(0)
  const [renderedDocumentKey, setRenderedDocumentKey] = useState(documentKey)

  if (renderedDocumentKey !== documentKey) {
    activeIdRef.current = null
    setRenderedDocumentKey(documentKey)
    setAttempt(initialAttempt)
    setState(extractionStateFromAttempt(initialAttempt))
    setReviewDecisions([])
    setTouchedPaths(new Set())
    setReviewError(null)
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
    !reviewLoading &&
    reviewAvailable &&
    attempt?.reviewedAt === null &&
    reviewDecisions.length > 0
  )

  useEffect(() => {
    if (
      !attempt ||
      attempt.reviewedAt !== null ||
      !reviewAvailable
    )
      return
    return registerSessionRecoveryCapture(
      'extraction-review',
      attempt.extractionId,
      () =>
        touchedPaths.size === 0
          ? null
          : {
              decisions: reviewDecisions,
              touchedPaths: [...touchedPaths],
            },
    )
  }, [attempt, reviewAvailable, reviewDecisions, touchedPaths])

  useEffect(() => {
    const controller = new AbortController()
    const load = ++reviewLoadRef.current
    void Promise.resolve().then(async () => {
      if (reviewLoadRef.current !== load) return
      setReviewError(null)
      if (!reviewAvailable || !attempt) {
        setReviewLoading(false)
        if (attempt?.reviewedAt) {
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
        removeSessionRecovery('extraction-review', attempt.extractionId)
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
          removeSessionRecovery('extraction-review', attempt.extractionId)
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
        const recovered = consumeSessionRecovery(
          'extraction-review',
          attempt.extractionId,
          (value) => recoveredReview(value, prepared.pendingReviewDecisions ?? []),
        )
        setReviewDecisions(
          recovered?.decisions ?? [...(prepared.pendingReviewDecisions ?? [])],
        )
        setTouchedPaths(recovered?.touchedPaths ?? new Set())
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
  }, [attempt, reviewAvailable])

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
    if (attempt)
      removeSessionRecovery('extraction-review', attempt.extractionId)
    abandonRunning()
    const controller = new AbortController()
    const extractionId = crypto.randomUUID()
    abortRef.current = controller
    activeIdRef.current = extractionId
    setReviewError(null)
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
    if (!attempt || !canAccept) return
    setSaving(true)
    setReviewError(null)
    try {
      const finalized = await finalizeExtractionReview(
        attempt.extractionId,
        reviewDecisions,
      )
      setAttempt(finalized)
      removeSessionRecovery('extraction-review', attempt.extractionId)
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : 'Saving the review failed.',
      )
    } finally {
      setSaving(false)
    }
  }

  function setReviewDecision(
    resultPath: ReviewDecisionInput['resultPath'],
    action: ReviewDecisionAction,
    reviewedValue: ReviewDecisionInput['reviewedValue'] = null,
  ) {
    const key = resultPathKey(resultPath)
    setReviewDecisions((current) => current.map((decision) =>
      resultPathKey(decision.resultPath) === key
        ? {
            ...decision,
            action,
            reviewedValue: action === 'EDITED' ? reviewedValue : null,
          }
        : decision,
    ))
    setTouchedPaths((current) => new Set(current).add(key))
  }

  // Marks every field the researcher hasn't explicitly acted on as touched,
  // without changing its recorded action — every field already defaults to
  // 'APPROVED', so this only affects what the review UI displays.
  function approveAllRemaining() {
    setTouchedPaths(
      (current) => new Set([...current, ...reviewDecisions.map((decision) => resultPathKey(decision.resultPath))]),
    )
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
      setDecision: setReviewDecision,
      approveAll: approveAllRemaining,
      accept: acceptResult,
    },
  }
}
