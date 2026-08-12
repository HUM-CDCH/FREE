import { useEffect, useRef, useState } from 'react'
import {
  cancelExtraction,
  finalizeExtractionReview,
  requestExtraction,
} from './api'
import type { ExtractionState } from './extraction'
import { anchorOccurrences } from './evidenceNavigation'
import type { ParsedDocument } from '../shared/parsedDocument'
import type {
  ExtractionAttempt,
  ExtractionRetrySelection,
  ExtractionStrategy,
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
  parsedDocument?: ParsedDocument | null
  reviewTarget?: ReviewTarget | null
}

export type ExtractionController = ReturnType<typeof useExtraction>

type ExtractionRetryInput = Omit<ExtractionRetrySelection, 'retryOfId'>
type ExtractionRunInput =
  | {
      sourceRepresentationRevisionId: string
      schemaRevisionId: string
      strategy: ExtractionStrategy
    }
  | {
      retryOfId: string
      retryDocument?: boolean
      rediscover?: boolean
      retryRecordStartBlockIds?: string[]
    }

function reviewDecisions(
  document: ParsedDocument,
  attempt: ExtractionAttempt,
): ReviewDecisionInput[] {
  const anchors = new Map(
    document.evidence_index.anchors.map((anchor) => [anchor.anchor_id, anchor]),
  )
  return [
    ...new Set(
      (attempt.evidenceLinks ?? []).map((link) => link.evidenceAnchorId),
    ),
  ].flatMap((evidenceAnchorId) => {
    const anchor = anchors.get(evidenceAnchorId)
    return anchor
      ? [
          {
            evidenceAnchorId,
            reviewedOccurrenceIds: anchorOccurrences(anchor).map(
              (occurrence) => occurrence.occurrence_id,
            ),
          },
        ]
      : []
  })
}

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
  parsedDocument = null,
  reviewTarget = null,
}: UseExtractionOptions) {
  const [attempt, setAttempt] = useState<ExtractionAttempt | null>(
    initialAttempt,
  )
  const [state, setState] = useState<ExtractionState>(() =>
    extractionStateFromAttempt(initialAttempt),
  )
  const [saving, setSaving] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [cancellationRequested, setCancellationRequested] = useState(false)
  const [cancellationError, setCancellationError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const runInputsKey = `${reviewTarget?.sourceRepresentationId ?? ''}\n${reviewTarget?.schemaRevisionId ?? ''}`
  const previousInputsRef = useRef(runInputsKey)

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
    setReviewError(null)
  }, [runInputsKey])

  const hasResults = state.status === 'ready'
  const canRun =
    reviewTarget !== null &&
    schemaReady &&
    state.status !== 'running' &&
    !indexing
  const pendingDecisions =
    attempt?.outcome === 'SUCCEEDED' && parsedDocument
      ? reviewDecisions(parsedDocument, attempt)
      : []
  const canAccept = Boolean(
    !saving &&
    attempt?.outcome === 'SUCCEEDED' &&
    attempt.reviewable &&
    attempt.reviewedAt === null &&
    sameTarget(attempt, reviewTarget),
  )

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

  async function runRequest(
    request: ExtractionRunInput,
    isRerun: boolean,
  ) {
    const targetedRetry = 'retryOfId' in request
    if (
      targetedRetry
        ? !schemaReady || indexing || state.status === 'running'
        : !canRun || !reviewTarget
    )
      return
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
        { ...request, id: extractionId },
        controller.signal,
      )
      if (controller.signal.aborted) return
      setAttempt(terminal)
      setState(extractionStateFromAttempt(terminal))
      onTerminal(terminal, isRerun)
    } catch (error) {
      if (controller.signal.aborted) return
      const message =
        error instanceof Error ? error.message : 'Extraction failed.'
      setState({ status: 'error', message })
      onError(message)
    } finally {
      if (activeIdRef.current === extractionId) activeIdRef.current = null
      if (abortRef.current === controller) abortRef.current = null
    }
  }

  async function runExtraction(strategy: ExtractionStrategy = 'ARTICLE') {
    if (!reviewTarget) return
    await runRequest(
      {
        sourceRepresentationRevisionId: reviewTarget.sourceRepresentationId,
        schemaRevisionId: reviewTarget.schemaRevisionId,
        strategy,
      },
      attempt !== null,
    )
  }

  async function retryExtraction(selection: ExtractionRetryInput) {
    const parent = attempt
    if (!parent || parent.strategy !== 'CATALOG') return
    await runRequest(
      {
        retryOfId: parent.extractionId,
        retryDocument: selection.retryDocument,
        rediscover: selection.rediscover,
        retryRecordStartBlockIds: selection.retryRecordStartBlockIds,
      },
      true,
    )
  }

  async function acceptResult() {
    if (!attempt || !canAccept) return
    setSaving(true)
    setReviewError(null)
    try {
      setAttempt(
        await finalizeExtractionReview(attempt.extractionId, pendingDecisions),
      )
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : 'Saving the review failed.',
      )
    } finally {
      setSaving(false)
    }
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
    review: {
      available: Boolean(
        attempt?.outcome === 'SUCCEEDED' &&
        attempt.reviewable &&
        sameTarget(attempt, reviewTarget),
      ),
      canAccept,
      saving,
      reviewedExtractionId: attempt?.reviewedAt
        ? attempt.extractionId
        : null,
      error: reviewError,
      accept: acceptResult,
    },
  }
}
