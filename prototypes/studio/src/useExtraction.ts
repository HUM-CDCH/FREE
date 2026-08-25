import { useEffect, useRef, useState } from 'react'
import {
  cancelExtraction,
  finalizeExtractionReview,
  readExtraction,
  requestExtraction,
} from './api'
import type { ExtractionState } from './extraction'
import type {
  ExtractionAttempt,
  ReviewDecisionAction,
  ReviewDecisionInput,
} from '../shared/extraction.contract'

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
  if (attempt.outcome === 'CANCELLED') return { status: 'cancelled' }
  if (attempt.outcome === 'FAILED')
    return {
      status: 'error',
      message: attempt.failure?.message ?? 'Extraction failed.',
    }
  if (!attempt.resultPayload || !attempt.evidenceLinks)
    return { status: 'error', message: 'The stored Extraction Result is invalid.' }
  return {
    status: 'ready',
    result: attempt.resultPayload,
    evidenceLinks: attempt.evidenceLinks,
    ungroundedCount:
      attempt.diagnostics.grounding?.ungroundedPaths.length ?? 0,
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
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [cancellationRequested, setCancellationRequested] = useState(false)
  const [cancellationError, setCancellationError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const runInputsKey = `${reviewTarget?.sourceRepresentationId ?? ''}\n${reviewTarget?.schemaRevisionId ?? ''}`
  const previousInputsRef = useRef(runInputsKey)
  const previousDocumentKeyRef = useRef(documentKey)
  const reviewLoadRef = useRef(0)

  function abandonRunning() {
    const id = activeIdRef.current
    if (id) void cancelExtraction(id).catch(() => {})
    activeIdRef.current = null
    abortRef.current?.abort()
    abortRef.current = null
  }

  useEffect(() => () => abandonRunning(), [])
  useEffect(() => {
    if (previousInputsRef.current === runInputsKey) return
    previousInputsRef.current = runInputsKey
    abandonRunning()
    setState((current) =>
      current.status === 'running' ? { status: 'idle' } : current,
    )
    setReviewDecisions([])
    setReviewError(null)
  }, [runInputsKey])
  // The active Source Document changed under an unmounted hook — reseed the
  // inspected attempt from its own persisted Extraction rather than the
  // previous document's.
  useEffect(() => {
    if (previousDocumentKeyRef.current === documentKey) return
    previousDocumentKeyRef.current = documentKey
    abandonRunning()
    setAttempt(initialAttempt)
    setState(extractionStateFromAttempt(initialAttempt))
    setReviewDecisions([])
    setReviewError(null)
    setCancellationRequested(false)
    setCancellationError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentKey])

  const hasResults = state.status === 'ready'
  const stale = attempt !== null && !sameTarget(attempt, reviewTarget)
  const canRun =
    reviewTarget !== null &&
    schemaReady &&
    state.status !== 'running' &&
    !indexing
  const reviewAvailable = Boolean(
    attempt?.outcome === 'SUCCEEDED' &&
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
    const load = ++reviewLoadRef.current
    void Promise.resolve().then(async () => {
      if (reviewLoadRef.current !== load) return
      setReviewError(null)
      if (!reviewAvailable || !attempt) {
        setReviewLoading(false)
        setReviewDecisions(
          attempt?.reviewedAt ? attempt.reviewDecisions.map(pendingDecision) : [],
        )
        return
      }
      if (attempt.reviewedAt) {
        setReviewLoading(false)
        setReviewDecisions(attempt.reviewDecisions.map(pendingDecision))
        return
      }
      setReviewLoading(true)
      setReviewDecisions([])
      try {
        const prepared = await readExtraction(attempt.extractionId)
        if (reviewLoadRef.current !== load) return
        setReviewDecisions([...prepared.pendingReviewDecisions])
      } catch (error) {
        if (reviewLoadRef.current !== load) return
        setReviewError(
          error instanceof Error ? error.message : 'Loading the review failed.',
        )
      } finally {
        if (reviewLoadRef.current === load) setReviewLoading(false)
      }
    })
  }, [attempt, reviewAvailable])

  async function requestCancellation() {
    const id = activeIdRef.current
    if (state.status !== 'running' || !id || cancellationRequested) return
    setCancellationRequested(true)
    setCancellationError(null)
    try {
      await cancelExtraction(id)
    } catch (error) {
      setCancellationRequested(false)
      setCancellationError(error instanceof Error ? error.message : 'Cancellation failed.')
    }
  }

  async function runRequest(isRerun: boolean, target: ReviewTarget) {
    if (
      !schemaReady ||
      state.status === 'running' ||
      indexing
    )
      return null
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
      const terminal = await requestExtraction(
        {
          id: extractionId,
          sourceRepresentationRevisionId: target.sourceRepresentationId,
          schemaRevisionId: target.schemaRevisionId,
          strategy: 'ARTICLE',
        },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setAttempt(terminal)
      setState(extractionStateFromAttempt(terminal))
      setReviewDecisions([])
      onTerminal(terminal, isRerun)
      return terminal
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

  async function runExtraction(target: ReviewTarget | null = reviewTarget) {
    if (!target) return null
    return runRequest(attempt !== null, target)
  }

  async function acceptResult() {
    if (!attempt || !canAccept) return
    setSaving(true)
    setReviewError(null)
    try {
      setAttempt(
        await finalizeExtractionReview(
          attempt.extractionId,
          reviewDecisions,
        ),
      )
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
    const key = JSON.stringify(resultPath)
    setReviewDecisions((current) => current.map((decision) =>
      JSON.stringify(decision.resultPath) === key
        ? {
            ...decision,
            action,
            reviewedValue: action === 'EDITED' ? reviewedValue : null,
          }
        : decision,
    ))
  }

  return {
    state,
    attempt,
    canRun,
    hasResults,
    stale,
    runExtraction,
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
      reviewedExtractionId: attempt?.reviewedAt
        ? attempt.extractionId
        : null,
      error: reviewError,
      setDecision: setReviewDecision,
      accept: acceptResult,
    },
  }
}
