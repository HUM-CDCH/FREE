import type { DBOSClient } from '@dbos-inc/dbos-sdk'
import { LIVE_WORKFLOW_STATUSES } from 'db'
import { createKeiHandoff, keiConvertWorkflowId } from 'extraction/kei-handoff'
import { studioDbos } from '../server/dbos.js'

type Clients = {
  admission: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow'>
  kei: Pick<DBOSClient, 'listWorkflows' | 'cancelWorkflow' | 'enqueuePortable'>
}

/** Stops live work after the ownership-scoped deletion has committed. A failed cancel is left for M6 repair. */
export async function cancelScopeWork(
  scope: { projectContextId: string; sourceDocumentId?: string },
  interruptedAttempts: readonly { batchSchemaSuggestionId: string; attempt: number }[] = [],
  clients: Clients = studioDbos(),
): Promise<void> {
  const attributes = scope.sourceDocumentId
    ? { sourceDocumentId: scope.sourceDocumentId }
    : { projectContextId: scope.projectContextId }
  let live: { workflowID: string }[] = []
  try {
    live = await clients.admission.listWorkflows({
      attributes, status: ['ENQUEUED', 'DELAYED', 'PENDING'], loadInput: false, loadOutput: false,
    })
  } catch {
    console.warn('Could not list live Studio work after deletion; continuing with known attempts and kei work.')
  }
  const ids = new Set([
    ...live.map((workflow) => workflow.workflowID),
    ...interruptedAttempts.map(({ batchSchemaSuggestionId, attempt }) => `suggest:${batchSchemaSuggestionId}:${attempt}`),
  ])
  const kei = createKeiHandoff(clients.kei)
  const childIds = new Set<string>()
  for (const id of ids) {
    try {
      const [status] = await clients.admission.listWorkflows({ workflowIDs: [id], loadInput: false, loadOutput: false })
      if (status && LIVE_WORKFLOW_STATUSES.has(status.status)) await clients.admission.cancelWorkflow(id)
    } catch {
      console.warn(`Could not cancel Studio workflow ${id} after deletion.`)
    }
    if (id.startsWith('ingest:') || id.startsWith('reprocess:')) childIds.add(keiConvertWorkflowId(id))
  }
  try {
    const liveChildren = await clients.kei.listWorkflows({
      attributes, workflowName: ['convert'], status: ['ENQUEUED', 'DELAYED', 'PENDING'],
      loadInput: false, loadOutput: false,
    })
    for (const child of liveChildren) childIds.add(child.workflowID)
  } catch {
    console.warn('Could not list live kei work after deletion; garbage collection will retry.')
  }
  for (const id of childIds) {
    try { await kei.cancel(id) }
    catch { console.warn(`Could not cancel kei workflow ${id} after deletion.`) }
  }
}
