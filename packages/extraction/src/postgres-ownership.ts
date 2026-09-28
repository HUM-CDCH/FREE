/**
 * Owns the Researcher Account guards every cluster checks inside its own transaction: an Extraction, a Source
 * Document, a batch, or an Extraction's inputs belong to the researcher only through their Project Context. A row
 * another researcher owns answers as missing.
 */

import type { Database, DatabaseTransaction } from 'db'
import { extractionSnapshot, readAttemptRows } from './postgres-attempts.js'
import type { ExtractionSnapshot } from './types.js'

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

export async function loadResearcherExtraction(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  extractionId: string,
): Promise<ExtractionSnapshot | null> {
  if (!(await ownsResearcherExtraction(transaction, researcherAccountId, extractionId))) return null
  const [row] = await readAttemptRows(transaction.orm, [extractionId])
  // Review reads a published result only.
  return row?.outcome === 'SUCCEEDED' ? extractionSnapshot(transaction.orm, row) : null
}

export function readResearcherExtraction(
  database: Database,
  researcherAccountId: string,
  extractionId: string,
): Promise<ExtractionSnapshot | null> {
  return database.transaction((transaction) =>
    loadResearcherExtraction(
      transaction,
      researcherAccountId,
      extractionId,
    ),
  )
}

export async function ownedInputs(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  sourceRepresentationRevisionId: string,
  schemaRevisionId: string,
) {
  const { sql } = transaction
  const query = sql.public.sourceRepresentationRevision
    .innerJoin(sql.public.sourceDocument, (fields, functions) =>
      functions.eq(
        fields.sourceRepresentationRevision.sourceDocumentId,
        fields.sourceDocument.id,
      ),
    )
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.sourceDocument.projectContextId,
        fields.projectContext.id,
      ),
    )
    .innerJoin(sql.public.extractionSchema, (fields, functions) =>
      functions.eq(
        fields.sourceDocument.projectContextId,
        fields.extractionSchema.projectContextId,
      ),
    )
    .innerJoin(sql.public.schemaRevision, (fields, functions) =>
      functions.eq(
        fields.extractionSchema.id,
        fields.schemaRevision.extractionSchemaId,
      ),
    )
    .select((fields) => ({
      sourceDocumentId: fields.sourceDocument.id,
      projectContextId: fields.projectContext.id,
      sourceRepresentationRevisionId:
        fields.sourceRepresentationRevision.id,
      artifactReference:
        fields.sourceRepresentationRevision.artifactReference,
      artifactSha256: fields.sourceRepresentationRevision.artifactSha256,
      schemaRevisionId: fields.schemaRevision.id,
      schemaTree: fields.schemaRevision.schemaTree,
    }))
    .where((fields, functions) =>
      functions.and(
        functions.eq(
          fields.sourceRepresentationRevision.id,
          sourceRepresentationRevisionId,
        ),
        functions.eq(fields.schemaRevision.id, schemaRevisionId),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  return transaction.execute(query.build()).first()
}

export async function ownedRepresentation(
  transaction: DatabaseTransaction,
  researcherAccountId: string,
  sourceRepresentationRevisionId: string,
) {
  const { sql } = transaction
  const query = sql.public.sourceRepresentationRevision
    .innerJoin(sql.public.sourceDocument, (fields, functions) =>
      functions.eq(
        fields.sourceRepresentationRevision.sourceDocumentId,
        fields.sourceDocument.id,
      ),
    )
    .innerJoin(sql.public.projectContext, (fields, functions) =>
      functions.eq(
        fields.sourceDocument.projectContextId,
        fields.projectContext.id,
      ),
    )
    .select((fields) => ({
      artifactReference:
        fields.sourceRepresentationRevision.artifactReference,
      artifactSha256: fields.sourceRepresentationRevision.artifactSha256,
    }))
    .where((fields, functions) =>
      functions.and(
        functions.eq(
          fields.sourceRepresentationRevision.id,
          sourceRepresentationRevisionId,
        ),
        functions.eq(
          fields.projectContext.researcherAccountId,
          researcherAccountId,
        ),
      ),
    )
  return transaction.execute(query.build()).first()
}
