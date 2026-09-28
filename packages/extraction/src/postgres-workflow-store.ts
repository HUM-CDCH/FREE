/**
 * Owns the store `runExtraction` works through, with no Researcher Account: it loads an admitted Extraction's pins,
 * reads its pinned document, and settles its outcome in the one terminal write every settlement races through.
 */

import {
  canonicalPackageStore,
  db,
  type CanonicalPackageStore,
  type Database,
  type DatabaseOrm,
} from 'db'
import { ExtractionError } from './errors.js'
import { modelChoice } from './extraction-method.js'
import type {
  AdmittedExtraction,
  ExtractionStore,
  SettledExtraction,
} from './workflows.js'
import type { ExtractionStrategy } from './types.js'

/**
 * The one terminal write of an Extraction. The no-outcome predicate lives in the UPDATE (updateAll keeps its guards;
 * update selects an id first), so completion, failure and cancellation race to one winner, a replayed step finds the
 * outcome written, and a deleted row updates nothing.
 */
export async function settleExtraction(
  orm: DatabaseOrm,
  extractionId: string,
  settled: SettledExtraction,
): Promise<'settled' | 'already-settled' | 'missing'> {
  const fields = settled.outcome === 'SUCCEEDED'
    ? {
        outcome: 'SUCCEEDED' as const,
        complete: settled.extraction.complete,
        modelAttribution: settled.extraction.modelAttribution,
        diagnostics: settled.extraction.diagnostics,
        failure: null,
        resultPayload: settled.extraction.result,
        evidenceLinks: settled.extraction.evidence,
        reviewable: settled.extraction.reviewable,
      }
    // A failed or cancelled Extraction carries its failure and nothing else.
    : {
        outcome: settled.outcome,
        failure: settled.failure,
        complete: null,
        modelAttribution: null,
        diagnostics: null,
        resultPayload: null,
        evidenceLinks: null,
        reviewable: false,
      }
  const updated = await orm.public.Extraction.where({ id: extractionId, outcome: null }).updateAll(fields)
  if (updated.length === 1) return 'settled'
  return (await orm.public.Extraction.select('id').first({ id: extractionId })) ? 'already-settled' : 'missing'
}

/**
 * The store `runExtraction` works through. It reads without a Researcher Account: ownership was checked when the
 * Extraction was admitted, and deletion cascades the row with its source.
 */
export function createExtractionStore(
  infrastructure: Readonly<{ database?: Database; packages?: CanonicalPackageStore }> = {},
): ExtractionStore {
  const database = infrastructure.database ?? db
  const packages = infrastructure.packages ?? canonicalPackageStore
  const { orm } = database
  return {
    async loadAdmitted(extractionId): Promise<AdmittedExtraction | null> {
      const row = await orm.public.Extraction.select(
        'id', 'sourceDocumentId', 'sourceRepresentationRevisionId', 'schemaRevisionId', 'strategy', 'catalogRecipe',
        'requestedModels', 'requestedSettings', 'batchExtractionId',
      ).first({ id: extractionId, outcome: null })
      if (!row) return null
      const document = await orm.public.SourceDocument.select('projectContextId').first({ id: row.sourceDocumentId })
      const project = document
        ? await orm.public.ProjectContext.select('researcherAccountId').first({ id: document.projectContextId })
        : null
      const revision = await orm.public.SourceRepresentationRevision.select('preprocessId').first({
        id: row.sourceRepresentationRevisionId, sourceDocumentId: row.sourceDocumentId,
      })
      const schema = await orm.public.SchemaRevision.select('extractionSchemaId', 'schemaTree').first({ id: row.schemaRevisionId })
      if (!document || !project || !revision || !schema) return null
      return {
        extractionId: row.id,
        owner: project.researcherAccountId,
        projectContextId: document.projectContextId,
        sourceDocumentId: row.sourceDocumentId,
        sourceRepresentationRevisionId: row.sourceRepresentationRevisionId,
        schemaRevisionId: row.schemaRevisionId,
        extractionSchemaId: schema.extractionSchemaId,
        strategy: row.strategy as ExtractionStrategy,
        catalogRecipe: row.catalogRecipe,
        requestedModels: modelChoice(row.requestedModels),
        // Raw: the request built from it validates it, so a row that no longer reads fails its Extraction, not this step.
        requestedSettings: row.requestedSettings,
        batchExtractionId: row.batchExtractionId,
        preprocessId: revision.preprocessId,
        schemaTree: schema.schemaTree,
      }
    },
    async readPinnedDocument(sourceRepresentationRevisionId) {
      const revision = await orm.public.SourceRepresentationRevision.select('artifactReference', 'artifactSha256')
        .first({ id: sourceRepresentationRevisionId })
      if (!revision) return null
      try {
        const artifact = await packages.read(revision, 'source')
        return JSON.parse(new TextDecoder().decode(artifact.bytes)) as unknown
      } catch (error) {
        throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.', { cause: error })
      }
    },
    settle: (extractionId, settled) => settleExtraction(orm, extractionId, settled),
  }
}
