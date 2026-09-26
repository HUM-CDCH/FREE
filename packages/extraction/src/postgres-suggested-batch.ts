import {
  stableJson,
  stableUuid,
  suggestionAttemptActive,
  suggestWorkflowId,
  withPoolClientTransaction,
  type Database,
} from 'db'
import type { ExtractionExecution } from './dependencies.js'
import { modelChoice } from './model-choice.js'
import { ExtractionError } from './errors.js'
import type { AdmitBatchMember, DurableBatchExtraction } from './postgres-persistence.js'
import { parseBatchSuggestionDefinition } from './schema.js'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from './batch.js'
import type {
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
} from './types.js'

/**
 * Owns the atomic Schema Suggestion → Extraction Schema → Batch handoff: the confirmed schema, the batch, one pending
 * Extraction per saved pin and each member's `runExtraction` workflow commit together on one pooled client. The members
 * keep the revisions saved with the suggestion, without a document lock: its fields were derived from those pins
 * (PR #140's documented exemption). Run needs a valid draft, at least one surviving member and no active attempt
 * (spec, *suggestSchemaBatch*), checked under the suggestion's row lock.
 */
export async function persistSuggestedBatch(
  database: Database,
  researcherAccountId: string,
  input: ScheduleSuggestedBatchInput,
  helpers: Readonly<{
    execution: ExtractionExecution
    admitBatchMember: AdmitBatchMember
    /** `created`: the handoff committed just now, so its members answer as just admitted, not from DBOS. */
    loadBatch: (
      orm: Database['orm'],
      projectContextId: string,
      batchExtractionId: string,
      created: boolean,
    ) => Promise<DurableBatchExtraction | null>
    /** A unique violation on this handoff's own identities: a concurrent handoff of the suggestion committed first. */
    replayed: (error: unknown) => boolean
    semanticSuggestionTree: (tree: unknown) => unknown
    snapshot: (batch: DurableBatchExtraction) => ScheduleBatchResult['batch']
  }>,
): Promise<ScheduleBatchResult | null> {
  const { execution, admitBatchMember, loadBatch, replayed, semanticSuggestionTree, snapshot } = helpers
  let status: 'created' | 'replayed' | 'missing' | 'not-ready' | 'invalid'
  try {
    status = await withPoolClientTransaction(async ({ orm }, client) => {
      // Source/project deletion locks the project before its suggestions. Keep that order here to avoid a cycle.
      const project = await orm.public.ProjectContext.where({
        id: input.projectContextId,
        researcherAccountId,
      }).updateAll({ id: input.projectContextId })
      if (project.length !== 1) return 'missing' as const
      // A retry or draft edit waits until this handoff commits.
      const locked = await orm.public.BatchSchemaSuggestion.where({
        id: input.batchSchemaSuggestionId,
        projectContextId: input.projectContextId,
      }).updateAll({ id: input.batchSchemaSuggestionId })
      if (locked.length !== 1) return 'missing' as const
      const suggestion = await orm.public.BatchSchemaSuggestion.select(
        'attempt',
        'outcome',
        'phase',
        'draft',
        'confirmedSchemaRevisionId',
        'batchExtractionId',
      ).first({ id: input.batchSchemaSuggestionId })
      if (!suggestion) return 'missing' as const
      if (suggestion.confirmedSchemaRevisionId && suggestion.batchExtractionId)
        return 'replayed' as const
      // A valid draft runs whatever the latest attempt's outcome, but not while an attempt that would replace it runs.
      if (
        suggestion.confirmedSchemaRevisionId !== null ||
        suggestion.phase !== 'READY' ||
        suggestion.draft === null
      )
        return 'not-ready' as const
      if (suggestion.outcome === null) {
        const attemptId = suggestWorkflowId(input.batchSchemaSuggestionId, suggestion.attempt)
        if (suggestionAttemptActive(suggestion.outcome, (await execution.statuses([attemptId])).get(attemptId)))
          return 'not-ready' as const
      }
      let draft
      try {
        draft = parseBatchSuggestionDefinition(suggestion.draft)
      } catch {
        return 'invalid' as const
      }
      const members = await orm.public.BatchSchemaSuggestionSource.where({
        batchSchemaSuggestionId: input.batchSchemaSuggestionId,
      })
        .select('sourceDocumentId', 'sourceRepresentationRevisionId')
        .orderBy((source) => source.sourceDocumentId.asc())
        .all()
      // Source deletion removes pins: an empty selection keeps its draft but has nothing to run.
      if (members.length === 0) return 'not-ready' as const
      if (
        members.length > BATCH_EXTRACTION_SELECTION_LIMIT ||
        new Set(members.map((member) => member.sourceDocumentId)).size !==
          members.length
      )
        return 'invalid' as const
      // Read before any write: returning from the transaction commits it.
      const pinned: Array<(typeof members)[number] & { preprocessId: string }> = []
      for (const member of members) {
        const revision = await orm.public.SourceRepresentationRevision.select('preprocessId').first({
          id: member.sourceRepresentationRevisionId,
          sourceDocumentId: member.sourceDocumentId,
        })
        if (!revision) return 'invalid' as const
        pinned.push({ ...member, preprocessId: revision.preprocessId })
      }
      const extractionSchemaId = stableUuid(
        'confirmed-batch-schema-suggestion',
        `${input.batchSchemaSuggestionId}:${stableJson(
          semanticSuggestionTree(draft),
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
          schemaTree: draft,
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
      const requestedModels = modelChoice(input.models)
      for (const member of pinned)
        await admitBatchMember(orm, client, execution, {
          owner: researcherAccountId,
          projectContextId: input.projectContextId,
          extractionSchemaId,
          schemaRevisionId,
          strategy: input.strategy,
          requestedModels,
          batchExtractionId,
          ...member,
        })
      await orm.public.BatchSchemaSuggestion.where({
        id: input.batchSchemaSuggestionId,
      }).update({ confirmedSchemaRevisionId: schemaRevisionId, batchExtractionId })
      return 'created' as const
    })
  } catch (error) {
    if (!replayed(error)) throw error
    status = 'replayed'
  }
  if (status === 'missing') return null
  if (status === 'not-ready' || status === 'invalid')
    throw new ExtractionError(
      'batch_not_ready',
      'The suggested fields are not ready to run.',
    )
  const batchExtractionId = await database.transaction(async ({ orm }) => {
    const project = await orm.public.ProjectContext.select('id').first({
      id: input.projectContextId,
      researcherAccountId,
    })
    if (!project) return null
    const suggestion =
      await orm.public.BatchSchemaSuggestion.select(
        'batchExtractionId',
      ).first({
        id: input.batchSchemaSuggestionId,
        projectContextId: input.projectContextId,
      })
    return suggestion?.batchExtractionId ?? null
  })
  const batch = batchExtractionId
    ? await loadBatch(database.orm, input.projectContextId, batchExtractionId, status === 'created')
    : null
  if (!batch)
    throw new Error('Confirmed Batch Schema Suggestion could not be read.')
  return { disposition: status, batch: snapshot(batch) }
}
