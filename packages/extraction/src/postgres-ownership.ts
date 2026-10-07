/**
 * Owns the Researcher Account guards every cluster checks inside its own transaction: an Extraction, a Source
 * Document or a batch belongs to the researcher only through their Project Context. A row
 * another researcher owns answers as missing.
 */

import type { DatabaseTransaction } from 'db'

export async function ownsResearcherExtraction(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  extractionId: string,
): Promise<boolean> {
  const { sql } = transaction
  const query = sql.public.extraction
    .innerJoin(sql.public.sourceDocument, (fields, functions) =>
      functions.eq(fields.extraction.sourceDocumentId, fields.sourceDocument.id),
    )
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(fields.sourceDocument.projectContextId, fields.projectContext.id),
    )
    .select('extractionId', (fields) => fields.extraction.id)
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.extraction.id, extractionId),
        functions.eq(fields.projectContext.researcherAccountId, researcherAccountId),
      ),
    )
  return (await transaction.execute(query.build()).first()) !== null
}

export async function ownsResearcherDocument(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  sourceDocumentId: string,
): Promise<boolean> {
  const { sql } = transaction
  const query = sql.public.sourceDocument
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.sourceDocument.projectContextId,
        fields.projectContext.id,
      ),
    )
    .select('sourceDocumentId', (fields) => fields.sourceDocument.id)
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.sourceDocument.id, sourceDocumentId),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  const row = await transaction.execute(query.build()).first()
  return row !== null
}

export async function ownsResearcherBatch(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  projectContextId: string,
  batchExtractionId: string,
): Promise<boolean> {
  const { sql } = transaction
  const query = sql.public.batchExtraction
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.batchExtraction.projectContextId,
        fields.projectContext.id,
      ),
    )
    .select('batchExtractionId', (fields) => fields.batchExtraction.id)
    .where((fields, functions) =>
      functions.and(
        functions.eq(fields.batchExtraction.id, batchExtractionId),
        functions.eq(
          fields.batchExtraction.projectContextId,
          projectContextId,
        ),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  const row = await transaction.execute(query.build()).first()
  return row !== null
}
