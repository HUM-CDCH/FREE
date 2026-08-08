import { useEffect, useRef, useState } from 'react'
import {
  postExtractionReview,
  requestExtraction,
  requestGrounding,
} from './api'
import type { ExtractionState } from './extraction'
import { stripDescriptions, compileInstructions } from './template'
import { anchorOccurrences } from './evidenceNavigation'
import type { ParsedDocument } from './parsedDocument'
import { groundExtraction } from './extractionGrounding'
import { canonicalSource } from './anchoredDocument'
import type {
  EvidenceLink,
  GroundedModelAttribution,
} from '../shared/groundedExtraction'

type PdfSource = { url: string; filename: string }

/**
 * What an accepted Extraction Result is written against: the exact retained
 * Source Representation and the Schema Revision the extraction used.
 */
export type ReviewTarget = {
  sourceRepresentationId: string
  schemaRevisionId: string
}

type UseExtractionOptions = {
  pdfSource: PdfSource | null
  template: unknown
  schemaReady: boolean
  markdown: string | null
  indexing: boolean
  onComplete: (isRerun: boolean) => void
  onError: (message: string) => void
  initialState?: ExtractionState
  /** The canonical Evidence the model may cite and the review write validates. */
  parsedDocument?: ParsedDocument | null
  /** Null while the result cannot be attributed to a durable review target. */
  reviewTarget?: ReviewTarget | null
  /** The Extraction this result was reopened from, if it is already persisted. */
  persistedExtractionId?: string | null
}

export type ExtractionController = ReturnType<typeof useExtraction>

function reviewDecisions(
  document: ParsedDocument,
  evidenceLinks: readonly EvidenceLink[],
) {
  const anchors = new Map(
    document.evidence_index.anchors.map((anchor) => [
      anchor.anchor_id,
      anchor,
    ]),
  )
  // Only exact links to anchors the Parsing Service published are reviewable.
  return [...new Set(evidenceLinks.map((link) => link.evidenceAnchorId))].flatMap(
    (evidenceAnchorId) => {
      const anchor = anchors.get(evidenceAnchorId)
      if (!anchor) return []
      return [
        {
          evidenceAnchorId,
          reviewedOccurrenceIds: anchorOccurrences(anchor).map(
            (occurrence) => occurrence.occurrence_id,
          ),
        },
      ]
    },
  )
}

type GroundingContext = {
  document: ParsedDocument
  result: Record<string, unknown>
  extractionAttribution: GroundedModelAttribution['extraction']
  isRerun: boolean
  reviewTarget: ReviewTarget | null
}

function sameReviewTarget(
  left: ReviewTarget | null,
  right: ReviewTarget | null,
): boolean {
  return (
    left?.sourceRepresentationId === right?.sourceRepresentationId &&
    left?.schemaRevisionId === right?.schemaRevisionId
  )
}

export function useExtraction({
  pdfSource,
  template,
  schemaReady,
  markdown,
  indexing,
  onComplete,
  onError,
  initialState = { status: 'idle' },
  parsedDocument = null,
  reviewTarget = null,
  persistedExtractionId = null,
}: UseExtractionOptions) {
  const [state, setState] = useState<ExtractionState>(initialState)
  const [modelAttribution, setModelAttribution] =
    useState<GroundedModelAttribution | null>(null)
  const [completedReviewTarget, setCompletedReviewTarget] =
    useState<ReviewTarget | null>(null)
  const [reviewedExtractionId, setReviewedExtractionId] = useState<string | null>(
    persistedExtractionId,
  )
  const [saving, setSaving] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const groundingContextRef = useRef<GroundingContext | null>(null)
  const runInputsKey = [
    pdfSource?.url ?? '',
    reviewTarget?.sourceRepresentationId ?? '',
    reviewTarget?.schemaRevisionId ?? '',
    parsedDocument?.document.content_sha256 ?? '',
    parsedDocument?.preprocessing.preprocess_id ?? '',
  ].join('\n')
  const previousRunInputsKeyRef = useRef(runInputsKey)

  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    if (previousRunInputsKeyRef.current === runInputsKey) return
    previousRunInputsKeyRef.current = runInputsKey
    abortRef.current?.abort()
    groundingContextRef.current = null
    setCompletedReviewTarget(null)
    setModelAttribution(null)
    setState((current) =>
      current.status === 'running' ? { status: 'idle' } : current,
    )
  }, [runInputsKey])

  const hasResults =
    state.status === 'ready' ||
    (state.status === 'running' && state.step === 'grounding')
  const canRun =
    Boolean(pdfSource) &&
    schemaReady &&
    state.status !== 'running' &&
    !indexing
  const pendingDecisions =
    state.status === 'ready' &&
    reviewTarget &&
    parsedDocument &&
    reviewedExtractionId === null
      ? reviewDecisions(parsedDocument, state.evidenceLinks)
      : []
  const canAccept =
    !saving &&
    modelAttribution !== null &&
    pendingDecisions.length > 0 &&
    sameReviewTarget(completedReviewTarget, reviewTarget)

  async function performGrounding(
    context: GroundingContext,
    abortController: AbortController,
  ) {
    setState({
      status: 'running',
      step: 'grounding',
      result: context.result,
    })
    try {
      const grounded = await groundExtraction({
        document: context.document,
        result: context.result,
        signal: abortController.signal,
        invokeModel: requestGrounding,
      })
      if (abortController.signal.aborted) return
      setState({
        status: 'ready',
        result: context.result,
        evidenceLinks: grounded.evidenceLinks,
        groundingIssues: grounded.issues,
      })
      setModelAttribution({
        extraction: context.extractionAttribution,
        grounding: grounded.modelAttribution,
      })
      setCompletedReviewTarget(context.reviewTarget)
      setReviewedExtractionId(null)
      setReviewError(null)
      onComplete(context.isRerun)
    } catch (error) {
      if (abortController.signal.aborted) return
      const message =
        error instanceof Error ? error.message : 'Evidence grounding failed.'
      setState({
        status: 'ready',
        result: context.result,
        evidenceLinks: [],
        groundingIssues: [],
        groundingError: message,
      })
      setModelAttribution({
        extraction: context.extractionAttribution,
        grounding: null,
      })
      setCompletedReviewTarget(null)
      setReviewedExtractionId(null)
    }
  }

  async function runExtraction() {
    if (state.status === 'running' || !pdfSource) {
      return
    }
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    const isRerun = hasResults
    groundingContextRef.current = null
    setCompletedReviewTarget(null)
    setState({ status: 'running', step: 'extraction' })

    try {
      const blob = await (
        await fetch(pdfSource.url, { signal: abortController.signal })
      ).blob()
      const cleanTemplate = stripDescriptions(template)
      const rawInstructions = compileInstructions(template)
      const extracted = await requestExtraction(
        blob,
        pdfSource.filename,
        { records: [cleanTemplate] },
        abortController.signal,
        parsedDocument ? canonicalSource(parsedDocument) : markdown,
        rawInstructions ? `Field descriptions:\n${rawInstructions}` : undefined,
      )
      if (abortController.signal.aborted) return
      if (
        !extracted.result ||
        typeof extracted.result !== 'object' ||
        Array.isArray(extracted.result)
      )
        throw new Error('Model returned a non-object Extraction result.')
      const result = extracted.result as Record<string, unknown>
      setReviewedExtractionId(null)
      setReviewError(null)
      if (parsedDocument) {
        const context: GroundingContext = {
          document: parsedDocument,
          result,
          extractionAttribution: extracted.modelAttribution,
          isRerun,
          reviewTarget,
        }
        groundingContextRef.current = context
        await performGrounding(context, abortController)
        return
      }
      setState({
        status: 'ready',
        result,
        evidenceLinks: [],
        groundingIssues: [],
      })
      setModelAttribution({
        extraction: extracted.modelAttribution,
        grounding: null,
      })
      setCompletedReviewTarget(reviewTarget)
      onComplete(isRerun)
    } catch (error) {
      if (abortController.signal.aborted) {
        return
      }
      const message = error instanceof Error ? error.message : 'Extraction failed.'
      setState({ status: 'error', message })
      onError(message)
    }
  }

  async function retryGrounding() {
    const context = groundingContextRef.current
    if (
      !context ||
      state.status === 'running' ||
      !sameReviewTarget(context.reviewTarget, reviewTarget)
    )
      return
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    await performGrounding(context, abortController)
  }

  // The researcher's explicit accept: the result, the Schema Revision it was
  // produced with, and one Review Decision per cited canonical anchor.
  async function acceptResult() {
    const acceptedTarget = completedReviewTarget
    if (
      state.status !== 'ready' ||
      !acceptedTarget ||
      !modelAttribution ||
      !canAccept ||
      !sameReviewTarget(acceptedTarget, reviewTarget)
    )
      return
    setSaving(true)
    setReviewError(null)
    try {
      const { extractionId } = await postExtractionReview(
        acceptedTarget.sourceRepresentationId,
        {
          schemaRevisionId: acceptedTarget.schemaRevisionId,
          result: state.result,
          evidenceLinks: [...state.evidenceLinks],
          modelAttribution,
          reviewDecisions: pendingDecisions,
        },
      )
      setReviewedExtractionId(extractionId)
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
    canRun,
    hasResults,
    runExtraction,
    retryGrounding,
    review: {
      available: reviewTarget !== null,
      canAccept,
      saving,
      reviewedExtractionId,
      error: reviewError,
      accept: acceptResult,
    },
  }
}
