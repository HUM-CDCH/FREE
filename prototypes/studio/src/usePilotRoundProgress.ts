import { useEffect, useState } from 'react'
import { getBatchExtraction } from './projectContexts/batchExtractions'
import { batchExtractionProgress } from '../shared/batchExtraction.contract'

export type PilotRoundProgress = {
  reviewed: number
  total: number
  /** The next not-yet-reviewed member after the current document, wrapping
   *  around the round; `null` once every member is reviewed (or has no
   *  Extraction to review yet). */
  nextMember: { sourceDocumentId: string; extractionId: string } | null
}

/**
 * Tracks review progress across a Batch Extraction's members for the
 * document tab bar's "reviewed N/M · next document" affordance
 * (guided-pilot-extraction-workflow, pilot-review-rounds). Silently yields
 * `null` on any fetch failure — this is a convenience indicator, not
 * something a broken request should block the document view over.
 */
export function usePilotRoundProgress(
  projectContextId: string | null,
  batchExtractionId: string | null,
  currentSourceDocumentId: string | null,
): PilotRoundProgress | null {
  const key = [projectContextId ?? '', batchExtractionId ?? '', currentSourceDocumentId ?? ''].join(':')
  // Keyed by the request it answers: a new request reads as "no progress yet"
  // without setting state synchronously from the effect.
  const [state, setState] = useState<{
    key: string
    value: PilotRoundProgress | null
  }>({ key, value: null })

  useEffect(() => {
    // No ids: the keyed read below already answers `null`, so nothing to set.
    if (!projectContextId || !batchExtractionId) return
    const controller = new AbortController()
    getBatchExtraction(projectContextId, batchExtractionId, controller.signal)
      .then((batch) => {
        if (controller.signal.aborted) return
        const { reviewed, total } = batchExtractionProgress(batch)
        const currentIndex = batch.members.findIndex(
          (member) => member.sourceDocumentId === currentSourceDocumentId,
        )
        const ordered =
          currentIndex >= 0
            ? [
                ...batch.members.slice(currentIndex + 1),
                ...batch.members.slice(0, currentIndex + 1),
              ]
            : batch.members
        const next = ordered.find(
          (member) =>
            member.sourceDocumentId !== currentSourceDocumentId &&
            member.latestExtraction &&
            !member.latestExtraction.reviewedAt,
        )
        setState({
          key,
          value: {
            reviewed,
            total,
            nextMember: next
              ? {
                  sourceDocumentId: next.sourceDocumentId,
                  extractionId: next.latestExtraction!.extractionId,
                }
              : null,
          },
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ key, value: null })
      })
    return () => controller.abort()
  }, [key, projectContextId, batchExtractionId, currentSourceDocumentId])

  return state.key === key ? state.value : null
}
