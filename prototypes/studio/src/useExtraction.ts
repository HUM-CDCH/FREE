import { useEffect, useRef, useState } from 'react'
import { postExtractionReview, requestExtraction } from './api'
import type { ExtractionState } from './extraction'
import { stripDescriptions, compileInstructions } from './template'
import { anchorOccurrences } from './evidenceNavigation'
import {
  ANCHOR_CITATION_INSTRUCTION,
  anchoredSource,
  resolveResultAnchors,
  wrapTemplateWithAnchors,
} from './anchoredDocument'
import type { ParsedDocumentV2 } from './parsedDocument'
import { resultAnchorIds } from '../shared/resultAnchors'

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
  parsedDocument?: ParsedDocumentV2 | null
  /** Null while the result cannot be attributed to a durable review target. */
  reviewTarget?: ReviewTarget | null
  /** The Extraction this result was reopened from, if it is already persisted. */
  persistedExtractionId?: string | null
}

export type ExtractionController = ReturnType<typeof useExtraction>

function reviewDecisions(document: ParsedDocumentV2, result: unknown) {
  const anchors = new Map(
    document.evidence_index.anchors.map((anchor) => [
      anchor.anchor_id,
      anchor,
    ]),
  )
  // Only anchors the Parsing Service published are reviewable; a citation the
  // model invented is not turned into Evidence.
  return [...resultAnchorIds(result)].flatMap((evidenceAnchorId) => {
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
  })
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
  const [modelAttribution, setModelAttribution] = useState<unknown>(null)
  const [reviewedExtractionId, setReviewedExtractionId] = useState<string | null>(
    persistedExtractionId,
  )
  const [saving, setSaving] = useState(false)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => () => abortRef.current?.abort(), [])

  const hasResults = state.status === 'ready'
  const canRun = Boolean(pdfSource) && schemaReady && state.status !== 'running' && !indexing
  const pendingDecisions =
    state.status === 'ready' &&
    reviewTarget &&
    parsedDocument &&
    reviewedExtractionId === null
      ? reviewDecisions(parsedDocument, state.result)
      : []
  const canAccept = !saving && pendingDecisions.length > 0

  async function runExtraction() {
    if (state.status === 'running' || !pdfSource) {
      return
    }
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController
    const isRerun = state.status === 'ready'
    setState({ status: 'running' })

    try {
      const blob = await (await fetch(pdfSource.url, { signal: abortController.signal })).blob()
      const cleanTemplate = stripDescriptions(template)
      const rawInstructions = compileInstructions(template)
      // With the canonical document the model reads anchored passages and cites
      // their IDs; without it, it extracts plain values from the Markdown.
      const anchored = parsedDocument ? anchoredSource(parsedDocument) : null
      const instruction =
        [
          rawInstructions ? `Field descriptions:\n${rawInstructions}` : '',
          anchored ? ANCHOR_CITATION_INSTRUCTION : '',
        ]
          .filter(Boolean)
          .join('\n\n') || undefined
      const extracted = await requestExtraction(
        blob,
        pdfSource.filename,
        {
          records: [
            anchored ? wrapTemplateWithAnchors(cleanTemplate) : cleanTemplate,
          ],
        },
        abortController.signal,
        anchored?.text ?? markdown,
        instruction,
      )
      if (abortController.signal.aborted) {
        return
      }
      // The accepted result carries canonical anchor IDs, never our labels.
      setState({
        status: 'ready',
        result: anchored
          ? resolveResultAnchors(extracted.result, anchored.anchorIdByLabel)
          : extracted.result,
      })
      setModelAttribution(extracted.modelAttribution)
      setReviewedExtractionId(null)
      setReviewError(null)
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

  // The researcher's explicit accept: the result, the Schema Revision it was
  // produced with, and one Review Decision per cited canonical anchor.
  async function acceptResult() {
    if (state.status !== 'ready' || !reviewTarget || !canAccept) return
    setSaving(true)
    setReviewError(null)
    try {
      const { extractionId } = await postExtractionReview(
        reviewTarget.sourceRepresentationId,
        {
          schemaRevisionId: reviewTarget.schemaRevisionId,
          result: state.result,
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
