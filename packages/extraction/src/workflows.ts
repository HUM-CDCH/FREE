/** Studio's unrestricted `studio` queue (server/dbos.ts STUDIO_QUEUE; server/workflows.test.ts pins the two equal). */
export const EXTRACTION_QUEUE = 'studio'

/** The pins an admitted Extraction's dispatch is attributed with. */
type AttributedExtraction = Readonly<{
  projectContextId: string
  sourceDocumentId: string
  sourceRepresentationRevisionId: string
  extractionSchemaId: string
  batchExtractionId: string | null
}>

/** A scope's work is found by these attributes. Its pinned source run is protected by the durable head's `sourcePin`,
 *  written in the same admission transaction (db garbage-references). */
export function extractionAttributes(admitted: AttributedExtraction): Record<string, string> {
  return {
    projectContextId: admitted.projectContextId,
    sourceDocumentId: admitted.sourceDocumentId,
    sourceRepresentationRevisionId: admitted.sourceRepresentationRevisionId,
    extractionSchemaId: admitted.extractionSchemaId,
    ...(admitted.batchExtractionId === null ? {} : { batchExtractionId: admitted.batchExtractionId }),
  }
}
