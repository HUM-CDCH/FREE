import type { Database } from 'db'
import { ExtractionError } from './errors.js'
import type { DurableBatchExtraction } from './postgres-persistence.js'
import type {
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
} from './types.js'

/** Owns the atomic Schema Suggestion → Extraction Schema → Batch handoff. */
export async function persistSuggestedBatch(
  database: Database,
  researcherAccountId: string | null,
  input: ScheduleSuggestedBatchInput,
  helpers: Readonly<{
    loadBatch: (
      orm: Database['orm'],
      projectContextId: string,
      batchExtractionId: string,
    ) => Promise<DurableBatchExtraction | null>
    semanticSuggestionTree: (tree: unknown) => unknown
    snapshot: (batch: DurableBatchExtraction) => ScheduleBatchResult['batch']
    stableJson: (value: unknown) => string
    stableUuid: (namespace: string, value: string) => string
    uniqueConstraint: (error: unknown) => boolean
  }>,
): Promise<ScheduleBatchResult | null> {
  const {
    loadBatch,
    semanticSuggestionTree,
    snapshot,
    stableJson,
    stableUuid,
    uniqueConstraint,
  } = helpers
  let status: 'created' | 'replayed' | 'missing' | 'not-ready' | 'invalid'
  try {
    status = await database.transaction(async ({ orm }) => {
      const project = await orm.public.ProjectContext.select('id').first({
        id: input.projectContextId,
        ...(researcherAccountId ? { researcherAccountId } : {}),
      })
      if (!project) return 'missing' as const
      const suggestion = await orm.public.BatchSchemaSuggestion.select(
        'executionStatus',
        'phase',
        'draft',
        'confirmedSchemaRevisionId',
        'batchExtractionId',
      ).first({
        id: input.batchSchemaSuggestionId,
        projectContextId: input.projectContextId,
      })
      if (!suggestion) return 'missing' as const
      if (suggestion.confirmedSchemaRevisionId && suggestion.batchExtractionId)
        return 'replayed' as const
      if (
        suggestion.executionStatus !== 'COMPLETED' ||
        suggestion.phase !== 'READY' ||
        suggestion.draft === null
      )
        return 'not-ready' as const
      const members = await orm.public.BatchSchemaSuggestionSource.where({
        batchSchemaSuggestionId: input.batchSchemaSuggestionId,
      })
        .select('sourceDocumentId', 'sourceRepresentationRevisionId')
        .orderBy((source) => source.sourceDocumentId.asc())
        .all()
      if (members.length === 0) return 'invalid' as const
      const extractionSchemaId = stableUuid(
        'confirmed-batch-schema-suggestion',
        `${input.batchSchemaSuggestionId}:${stableJson(
          semanticSuggestionTree(suggestion.draft),
        )}`,
      )
      const existing = await orm.public.SchemaRevision.where({
        extractionSchemaId,
      })
        .select('id')
        .orderBy((revision) => revision.revisionNumber.desc())
        .first()
      const schemaRevisionId =
        existing?.id ??
        stableUuid('confirmed-batch-schema-suggestion-revision', extractionSchemaId)
      if (!existing) {
        await orm.public.ExtractionSchema.create({
          id: extractionSchemaId,
          projectContextId: input.projectContextId,
          name: 'Suggested fields',
        })
        await orm.public.SchemaRevision.create({
          id: schemaRevisionId,
          extractionSchemaId,
          revisionNumber: 1,
          origin: 'SUGGESTION',
          schemaTree: suggestion.draft,
        })
      }
      const batchExtractionId = stableUuid(
        'batch-extraction-from-suggestion',
        input.batchSchemaSuggestionId,
      )
      await orm.public.BatchExtraction.create({
        id: batchExtractionId,
        projectContextId: input.projectContextId,
        schemaRevisionId,
        strategy: input.strategy,
      })
      for (const member of members)
        await orm.public.BatchExtractionMember.create({
          batchExtractionId,
          ...member,
        })
      await orm.public.BatchSchemaSuggestion.where({
        id: input.batchSchemaSuggestionId,
      }).update({ confirmedSchemaRevisionId: schemaRevisionId, batchExtractionId })
      return 'created' as const
    })
  } catch (error) {
    if (!uniqueConstraint(error)) throw error
    status = 'replayed'
  }
  if (status === 'missing') return null
  if (status === 'not-ready' || status === 'invalid')
    throw new ExtractionError(
      'batch_not_ready',
      'The suggested fields are not ready to run.',
    )
  const batch = await database.transaction(async ({ orm }) => {
    const project = await orm.public.ProjectContext.select('id').first({
      id: input.projectContextId,
      ...(researcherAccountId ? { researcherAccountId } : {}),
    })
    if (!project) return null
    const suggestion =
      await orm.public.BatchSchemaSuggestion.select(
        'batchExtractionId',
      ).first({
        id: input.batchSchemaSuggestionId,
        projectContextId: input.projectContextId,
      })
    return suggestion?.batchExtractionId
      ? loadBatch(
          orm,
          input.projectContextId,
          suggestion.batchExtractionId,
        )
      : null
  })
  if (!batch)
    throw new Error('Confirmed Batch Schema Suggestion could not be read.')
  return { disposition: status, batch: snapshot(batch) }
}
