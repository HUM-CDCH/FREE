import { randomUUID } from 'node:crypto'
import { stableJson, stableUuid, uniqueConstraint, type Database } from 'db'
import { ExtractionError } from './errors.js'
import type { DurableBatchExtraction } from './postgres-persistence.js'
import { parseBatchSuggestionDefinition, type SchemaNode } from './schema.js'
import { BATCH_EXTRACTION_SELECTION_LIMIT } from './batch.js'
import {
  buildGoldRecordFields,
  goldFilenameColumnValues,
  goldSpreadsheetRowCount,
  type GoldSpreadsheetColumn,
} from './gold-spreadsheet.js'
import type {
  ScheduleBatchResult,
  ScheduleSuggestedBatchInput,
} from './types.js'

function isBlankCell(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === ''
}

/** Populates a project-scoped `EvaluationCorpusVersion` from a confirmed
 *  `SCHEMA_AND_VALIDATE` spreadsheet-derived suggestion's pinned spreadsheet
 *  version, inside the caller's transaction so schema-seeding and
 *  gold-population commit or fail together (extraction-quality-evaluation
 *  design.md D1b/D9). Throws `ExtractionError('invalid_request', ...)` — not
 *  a distinct status — on any row that can't be resolved, since a partially
 *  populated corpus would be worse than a clean failure the researcher can
 *  fix and retry from the same unconfirmed suggestion. */
async function populateGoldRecords(
  orm: Database['orm'],
  projectContextId: string,
  input: {
    schemaNodes: readonly SchemaNode[]
    columnFieldMapping: Readonly<Record<string, string>>
    projectSpreadsheetVersionId: string | null
  },
): Promise<void> {
  if (!input.projectSpreadsheetVersionId)
    throw new ExtractionError(
      'invalid_request',
      'A spreadsheet-derived suggestion has no pinned spreadsheet version to populate gold data from.',
    )
  const spreadsheet = await orm.public.ProjectSpreadsheetVersion.select(
    'columns',
  ).first({ id: input.projectSpreadsheetVersionId, projectContextId })
  if (!spreadsheet)
    throw new ExtractionError(
      'invalid_request',
      'The pinned spreadsheet version is no longer available.',
    )
  const columns = spreadsheet.columns as GoldSpreadsheetColumn[]
  const filenames = goldFilenameColumnValues(columns)
  if (!filenames)
    throw new ExtractionError(
      'invalid_request',
      'The spreadsheet has no "filename" column to resolve gold records against Source Documents.',
    )

  const resolved: {
    sourceDocumentId: string
    sourceRepresentationRevisionId: string
    fields: unknown
  }[] = []
  const rowCount = goldSpreadsheetRowCount(columns)
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    // A spreadsheet row is 1-indexed with a header row, so data row
    // `rowIndex` (0-based) is row `rowIndex + 2` as the researcher sees it.
    const displayRow = rowIndex + 2
    if (columns.every((column) => isBlankCell(column.values[rowIndex])))
      continue // A wholly blank row (e.g. a trailing one) is noise, not data.
    const filename = filenames[rowIndex]
    if (isBlankCell(filename))
      throw new ExtractionError(
        'invalid_request',
        `Row ${displayRow} has no filename value to resolve it against a Source Document.`,
      )
    const document = await orm.public.SourceDocument.select('id').first({
      projectContextId,
      originalName: String(filename),
    })
    if (!document)
      throw new ExtractionError(
        'invalid_request',
        `Row ${displayRow}'s filename "${String(filename)}" does not match any Source Document in this project.`,
      )
    const representation =
      await orm.public.SourceRepresentationRevision.where({
        sourceDocumentId: document.id,
      })
        .select('id')
        .orderBy((revision) => revision.revisionNumber.desc())
        .first()
    if (!representation)
      throw new ExtractionError(
        'invalid_request',
        `Row ${displayRow}'s Source Document has no representation to pin.`,
      )
    resolved.push({
      sourceDocumentId: document.id,
      sourceRepresentationRevisionId: representation.id,
      fields: buildGoldRecordFields(
        input.schemaNodes,
        input.columnFieldMapping,
        columns,
        rowIndex,
      ),
    })
  }
  if (resolved.length === 0) return

  const evaluationCorpusId = stableUuid(
    'project-evaluation-corpus',
    projectContextId,
  )
  const existingCorpus = await orm.public.EvaluationCorpus.select(
    'id',
  ).first({ id: evaluationCorpusId })
  if (!existingCorpus)
    await orm.public.EvaluationCorpus.create({
      id: evaluationCorpusId,
      projectContextId,
      name: 'Gold Standard Corpus',
    })
  const head = await orm.public.EvaluationCorpusVersion.where({
    evaluationCorpusId,
  })
    .select('revisionNumber')
    .orderBy((version) => version.revisionNumber.desc())
    .first()
  const evaluationCorpusVersionId = randomUUID()
  await orm.public.EvaluationCorpusVersion.create({
    id: evaluationCorpusVersionId,
    evaluationCorpusId,
    revisionNumber: (head?.revisionNumber ?? 0) + 1,
  })
  for (const record of resolved)
    await orm.public.GoldRecord.create({
      evaluationCorpusVersionId,
      sourceDocumentId: record.sourceDocumentId,
      sourceRepresentationRevisionId: record.sourceRepresentationRevisionId,
      fields: record.fields,
    })
}

/** Owns the atomic Schema Suggestion → Extraction Schema → Batch handoff. */
export async function persistSuggestedBatch(
  database: Database,
  researcherAccountId: string,
  input: ScheduleSuggestedBatchInput,
  helpers: Readonly<{
    loadBatch: (
      orm: Database['orm'],
      projectContextId: string,
      batchExtractionId: string,
    ) => Promise<DurableBatchExtraction | null>
    semanticSuggestionTree: (tree: unknown) => unknown
    snapshot: (batch: DurableBatchExtraction) => ScheduleBatchResult['batch']
  }>,
): Promise<ScheduleBatchResult | null> {
  const { loadBatch, semanticSuggestionTree, snapshot } = helpers
  let status: 'created' | 'replayed' | 'missing' | 'not-ready' | 'invalid'
  try {
    status = await database.transaction(async ({ orm }) => {
      const project = await orm.public.ProjectContext.select('id').first({
        id: input.projectContextId,
        researcherAccountId,
      })
      if (!project) return 'missing' as const
      const suggestion = await orm.public.BatchSchemaSuggestion.select(
        'executionStatus',
        'phase',
        'draft',
        'sourceKind',
        'purpose',
        'columnFieldMapping',
        'projectSpreadsheetVersionId',
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
      // A spreadsheet-derived suggestion has no document sources at all —
      // confirming it is meant to produce only the Extraction Schema, with
      // an empty Batch Extraction shell, not to reject on having zero
      // members the way a document-grounded suggestion must (spreadsheet-
      // schema-suggestion design.md D1b/D4).
      if (
        (members.length === 0 && suggestion.sourceKind !== 'SPREADSHEET') ||
        members.length > BATCH_EXTRACTION_SELECTION_LIMIT ||
        new Set(members.map((member) => member.sourceDocumentId)).size !==
          members.length
      )
        return 'invalid' as const
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
      if (
        suggestion.sourceKind === 'SPREADSHEET' &&
        suggestion.purpose === 'SCHEMA_AND_VALIDATE'
      )
        await populateGoldRecords(orm, input.projectContextId, {
          schemaNodes: draft.schemaNodes,
          columnFieldMapping: (suggestion.columnFieldMapping ?? {}) as Record<
            string,
            string
          >,
          projectSpreadsheetVersionId: suggestion.projectSpreadsheetVersionId,
        })
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
      for (const member of members) {
        const initialExtractionJobId = stableUuid(
          'batch-member-extraction-job',
          stableJson([batchExtractionId, member.sourceRepresentationRevisionId]),
        )
        await orm.public.ExtractionJob.create({
          id: initialExtractionJobId,
          kind: 'BATCH_MEMBER',
          projectContextId: input.projectContextId,
          ...member,
          schemaRevisionId,
          strategy: input.strategy,
          batchExtractionId,
        })
        await orm.public.BatchExtractionMember.create({
          batchExtractionId,
          ...member,
          initialExtractionJobId,
        })
      }
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
