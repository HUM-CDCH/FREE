import type { ExportChoices, ExportFormat } from 'extraction-result-export'
import type { BatchExtraction, LatestExtraction } from '../../shared/batchExtraction.contract'
import type { ProjectContextActivitySummary } from './transport'
import { listProjectExtractions, projectLatest } from './batchExtractions'

type ExportableResult = Pick<LatestExtraction, 'extractionId' | 'sourceRepresentationRevisionId' | 'batchExtractionId' | 'review'>

/** What the project's export reads: its Current Template Revision, its Batch Extractions, and each document's newest
 *  reviewed Extraction where the server says so. */
export type ExportableProject = {
  summary: Pick<ProjectContextActivitySummary, 'currentSchemaRevisionId'>
  batches: readonly BatchExtraction[] | null
  latest: { reviewed: readonly LatestExtraction[] } | null
}

/** Each document's result to export: only a reviewed one, at its finalized cut, on the Current Template Revision. Its
 *  newest review, as the project's read has it (a run of the document alone included); else, from a server without that
 *  read, its newest reviewed round member, which only offers the export: the export itself refuses without the read. */
export function exportableResults(project: ExportableProject): Map<string, ExportableResult> {
  const results = new Map<string, ExportableResult>()
  const revisionId = project.summary.currentSchemaRevisionId
  if (project.latest) {
    for (const reviewed of project.latest.reviewed)
      if (reviewed.schemaRevisionId === revisionId) results.set(reviewed.sourceDocumentId, reviewed)
    return results
  }
  const newestFirst = (project.batches ?? []).filter((batch) => batch.schemaRevisionId === revisionId)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))
  for (const batch of newestFirst)
    for (const { currentReview, ...member } of batch.members)
      if (!results.has(member.sourceDocumentId) && currentReview)
        results.set(member.sourceDocumentId, { ...member, batchExtractionId: batch.batchExtractionId,
          review: { snapshotVersion: currentReview.snapshotVersion, feedbackVersion: currentReview.feedbackVersion } })
  return results
}

/** Downloads every reviewed document's results as one table (ADR 0041, the project page's export): each its newest
 *  reviewed result on the Current Template Revision at its reviewed cut, named by its document and Batch Extraction.
 *  The project is read again first, so a result reviewed since the page's last read is the one exported. False when no
 *  document has a reviewed result. */
export async function exportProjectResults(
  projectContextId: string,
  project: { summary: Pick<ProjectContextActivitySummary, 'currentSchemaRevisionId'>; documents: readonly { id: string; name: string }[] },
  name: string,
  format: ExportFormat,
  choices: ExportChoices,
): Promise<boolean> {
  const read = await listProjectExtractions(projectContextId)
  const results = exportableResults({ summary: project.summary, batches: read.batchExtractions, latest: projectLatest(read) })
  const members = project.documents.filter(({ id }) => results.has(id)).map(({ id, name: documentName }) => {
    const result = results.get(id)!
    return { extractionId: result.extractionId, sourceDocumentId: id, batchExtractionId: result.batchExtractionId ?? undefined,
      sourceDocumentName: documentName, sourceRevisionId: result.sourceRepresentationRevisionId, review: result.review ?? undefined }
  })
  if (members.length === 0) return false
  const { downloadDurableBatch } = await import('../durableExport')
  return downloadDurableBatch({ batchExtractionId: '', name }, members, format, choices)
}
