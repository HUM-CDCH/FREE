import type { ResearcherProjectStore } from 'db'
import type { IngestionOutcome } from '../../api/_ingestion_workflow.js'
import { createSourceDocumentIngestion, type Dependencies } from '../../api/source_documents.js'
import { awaitWorkflowOutcome, studioDbos } from '../../server/dbos.js'
import { uploadRequest } from './ingestion.js'

/**
 * Uploads `pdf` through the handler and waits for the Source Document it becomes: a 201 replay at once, or the
 * admitted attempt (202) once its workflow published. Scenarios wait; the upload request itself never does.
 */
export async function uploadedDocument(
  store: ResearcherProjectStore,
  projectContextId: string,
  pdf: Uint8Array,
  dependencies: Dependencies = {},
): Promise<{ sourceDocumentId: string; sourceRepresentationId: string }> {
  const response = await createSourceDocumentIngestion(store, dependencies)(uploadRequest(projectContextId, pdf))
  if (response.status === 201) return await response.json() as { sourceDocumentId: string; sourceRepresentationId: string }
  if (response.status !== 202) throw new Error(`Ingestion answered ${response.status}: ${await response.text()}`)
  const { workflowId } = await response.json() as { workflowId: string }
  const outcome = await awaitWorkflowOutcome<IngestionOutcome>(studioDbos().admission, workflowId, { timeoutMs: 90_000, intervalMs: 50 })
  if (outcome.state !== 'finished' || !outcome.output.ok) throw new Error(`The upload ended ${JSON.stringify(outcome)}.`)
  return outcome.output.sourceDocument
}
