import { useEffect, useRef, useState } from 'react'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import type { ProjectGuideInput } from './chatGuide'
import { listProjectExtractions, projectLatest } from './projectContexts/batchExtractions'
import type { ProjectContextActivitySummary } from './projectContexts/transport'

/** How often a running Batch Extraction, and the project's summary that follows it, are read again. */
export const PROJECT_BATCH_POLL_MS = 4000

const running = (batch: BatchExtraction) => batch.executionStatus === 'QUEUED' || batch.executionStatus === 'RUNNING'

/**
 * The project's Batch Extractions, with each document's latest Extraction, for the chat's project steps, read again
 * whenever the project's summary changes.
 * While one runs, both are read again every few seconds, so its progress and the phase its end moves to reach the
 * chat. Null until the first read answers; a failed read keeps what was read before.
 */
export function useProjectBatches(
  projectContextId: string | null,
  summary: ProjectContextActivitySummary | null,
  refreshSummary?: () => void,
): { batches: readonly BatchExtraction[] | null; latest: ProjectGuideInput['latest'] } {
  const [state, setState] = useState<{ projectContextId: string; batches: BatchExtraction[]; latest: ProjectGuideInput['latest'] } | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!projectContextId) return
    const controller = new AbortController()
    listProjectExtractions(projectContextId, controller.signal)
      .then((read) => { if (!controller.signal.aborted) setState({ projectContextId, batches: read.batchExtractions, latest: projectLatest(read) }) })
      .catch(() => {})
    return () => controller.abort()
  }, [projectContextId, summary, tick])

  const read = projectContextId && state?.projectContextId === projectContextId ? state : null
  const batches = read?.batches ?? null
  const active = Boolean(summary?.runningBatch) || Boolean(batches?.some(running))
  const refresh = useRef(refreshSummary)
  useEffect(() => { refresh.current = refreshSummary })
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setTick((value) => value + 1)
      refresh.current?.()
    }, PROJECT_BATCH_POLL_MS)
    // Its end moves the project's phase: read the summary once more.
    return () => {
      clearInterval(timer)
      refresh.current?.()
    }
  }, [active])
  return { batches, latest: read?.latest ?? null }
}
