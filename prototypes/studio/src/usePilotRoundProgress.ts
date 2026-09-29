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
  const [progress, setProgress] = useState<PilotRoundProgress | null>(null)

  useEffect(() => {
    setProgress(null)
    if (!projectContextId || !batchExtractionId) return
    const controller = new AbortController()
    getBatchExtraction(projectContextId, batchExtractionId, controller.signal)
      .then((batch) => {
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
        setProgress({
          reviewed,
          total,
          nextMember: next
            ? {
                sourceDocumentId: next.sourceDocumentId,
                extractionId: next.latestExtraction!.extractionId,
              }
            : null,
        })
      })
      .catch(() => setProgress(null))
    return () => controller.abort()
  }, [projectContextId, batchExtractionId, currentSourceDocumentId])

  return progress
}
