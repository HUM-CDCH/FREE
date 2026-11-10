import type { DurableRead } from 'extraction/durable-types'
import type { BatchExtraction } from '../shared/batchExtraction.contract'
import { durableRequest, durableRoot } from './durableExtractionApi'

/** A member still reading its source with the model, or held to: Stop ends it. A failed member waits for a retry. */
const WORKING: ReadonlySet<string> = new Set(['QUEUED', 'RUNNING', 'PAUSING', 'PAUSED'])

/** The Batch Extraction still has members at work: it can be stopped. */
export const batchStoppable = (batch: BatchExtraction) => batch.members.some((member) => WORKING.has(member.executionStatus))

/**
 * Stops one Extraction under its current control version: read, then stop. A command that lands meanwhile moves the
 * version, so the stop is tried again on a fresh read; one that has ended meanwhile needs none.
 */
async function stopExtraction(extractionId: string) {
  for (let attempt = 0; ; attempt += 1) {
    const state = await durableRequest<DurableRead>(durableRoot(extractionId))
    if (!WORKING.has(state.status)) return
    try {
      await durableRequest(`${durableRoot(extractionId)}/control`,
        { id: crypto.randomUUID(), expectedVersion: state.controlVersion, action: 'stop' })
      return
    } catch (error) {
      if (attempt >= 2) throw error
    }
  }
}

/**
 * Stops a Batch Extraction: every member still at work is stopped, each as its own Extraction's Stop would. Finished
 * members keep their results, and stopped ones the values they saved. Rejects with the first failure once every stop
 * was tried.
 */
export async function stopBatchExtraction(batches: readonly BatchExtraction[]) {
  const results = await Promise.allSettled(batches.flatMap((batch) => batch.members)
    .filter((member) => WORKING.has(member.executionStatus))
    .map((member) => stopExtraction(member.extractionId)))
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) throw failed.reason
}
