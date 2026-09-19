import type { Database } from 'db'
import { ExtractionError } from './errors.js'
import {
  precisionRecallF1,
  scoreDocument,
  type RecordFields,
} from './record-alignment-scoring.js'
import { parseExtractionSchema } from './schema.js'
import type {
  EvaluationRunSnapshot,
  ListEvaluationRunsInput,
  ValidateExtractionInput,
} from './types.js'

function extractedRecordsFromResult(
  result: Readonly<Record<string, unknown>>,
): RecordFields[] {
  return Array.isArray(result.records) &&
    result.records.every(
      (record) =>
        record !== null && typeof record === 'object' && !Array.isArray(record),
    )
    ? (result.records as RecordFields[])
    : []
}

function metricsOf(counts: {
  correctFields: number
  totalGoldFields: number
  totalExtractedFields: number
}): EvaluationRunSnapshot['metrics'] {
  return { ...counts, ...precisionRecallF1(counts) }
}

/**
 * Scores one existing Extraction attempt against its document's current
 * `GoldRecord`s (extraction-quality-evaluation design.md D4b) — no batch or
 * corpus re-run. Per the design's default assumption, a document with no
 * gold data in the corpus's current version has nothing to validate against
 * (returns `null`, same as any other "not found" precondition) rather than
 * supporting ad hoc un-corpused validation.
 */
export async function validateExtraction(
  database: Database,
  researcherAccountId: string,
  input: ValidateExtractionInput,
): Promise<EvaluationRunSnapshot | null> {
  return database.transaction(async ({ orm }) => {
    const project = await orm.public.ProjectContext.select('id').first({
      id: input.projectContextId,
      researcherAccountId,
    })
    if (!project) return null

    const extraction = await orm.public.Extraction.select(
      'id',
      'sourceDocumentId',
      'schemaRevisionId',
      'outcome',
      'resultPayload',
    ).first({ id: input.extractionId })
    if (!extraction) return null
    const document = await orm.public.SourceDocument.select('id').first({
      id: extraction.sourceDocumentId,
      projectContextId: input.projectContextId,
    })
    if (!document) return null
    if (extraction.outcome !== 'SUCCEEDED' || extraction.resultPayload === null)
      throw new ExtractionError(
        'invalid_request',
        'This Extraction has no successful result to validate.',
      )

    const corpus = await orm.public.EvaluationCorpus.select('id').first({
      id: input.evaluationCorpusId,
      projectContextId: input.projectContextId,
    })
    if (!corpus) return null
    const version = await orm.public.EvaluationCorpusVersion.where({
      evaluationCorpusId: corpus.id,
    })
      .select('id')
      .orderBy((row) => row.revisionNumber.desc())
      .first()
    if (!version) return null
    const goldRecords = await orm.public.GoldRecord.where({
      evaluationCorpusVersionId: version.id,
      sourceDocumentId: extraction.sourceDocumentId,
    })
      .select('fields')
      .all()
    // Default assumption (design.md D4b open question): a document must
    // already belong to the corpus (have gold data) to be validated — no
    // parallel ad hoc, un-corpused validation path.
    if (goldRecords.length === 0) return null

    const schemaRevision = await orm.public.SchemaRevision.select(
      'schemaTree',
    ).first({ id: extraction.schemaRevisionId })
    if (!schemaRevision) return null
    const schemaNodes = parseExtractionSchema(schemaRevision.schemaTree).schemaNodes

    const counts = scoreDocument(
      schemaNodes,
      extractedRecordsFromResult(
        extraction.resultPayload as Record<string, unknown>,
      ),
      goldRecords.map((record) => record.fields as RecordFields),
    )
    const metrics = metricsOf(counts)

    const created = await orm.public.EvaluationRun.create({
      evaluationCorpusVersionId: version.id,
      schemaRevisionId: extraction.schemaRevisionId,
      extractionId: extraction.id,
      metrics,
    })
    return {
      evaluationRunId: created.id,
      evaluationCorpusVersionId: version.id,
      schemaRevisionId: extraction.schemaRevisionId,
      batchExtractionId: null,
      extractionId: extraction.id,
      computedAt: created.computedAt,
      metrics,
    }
  })
}

/** Runs against a corpus, newest schema-revision cycle first — batch and
 *  single-document runs alike, since both expose the same `metrics` shape. */
export async function listEvaluationRuns(
  database: Database,
  researcherAccountId: string,
  input: ListEvaluationRunsInput,
): Promise<readonly EvaluationRunSnapshot[] | null> {
  return database.transaction(async ({ orm }) => {
    const project = await orm.public.ProjectContext.select('id').first({
      id: input.projectContextId,
      researcherAccountId,
    })
    if (!project) return null
    const corpus = await orm.public.EvaluationCorpus.select('id').first({
      id: input.evaluationCorpusId,
      projectContextId: input.projectContextId,
    })
    if (!corpus) return null

    const versions = await orm.public.EvaluationCorpusVersion.where({
      evaluationCorpusId: corpus.id,
    })
      .select('id')
      .all()
    // ponytail: bounded to a small evaluation-corpus version count and a
    // small run count per version; revisit with a join if this gets hot.
    const rows: {
      id: string
      evaluationCorpusVersionId: string
      schemaRevisionId: string
      batchExtractionId: string | null
      extractionId: string | null
      computedAt: Date
      metrics: unknown
    }[] = []
    for (const version of versions)
      rows.push(
        ...(await orm.public.EvaluationRun.where({
          evaluationCorpusVersionId: version.id,
        })
          .select(
            'id',
            'evaluationCorpusVersionId',
            'schemaRevisionId',
            'batchExtractionId',
            'extractionId',
            'computedAt',
            'metrics',
          )
          .all()),
      )

    const revisionNumberById = new Map<string, number>()
    for (const schemaRevisionId of new Set(rows.map((row) => row.schemaRevisionId))) {
      const revision = await orm.public.SchemaRevision.select(
        'revisionNumber',
      ).first({ id: schemaRevisionId })
      revisionNumberById.set(schemaRevisionId, revision?.revisionNumber ?? 0)
    }

    const limit = input.limit ?? 50
    return rows
      .sort((left, right) => {
        const byRevision =
          (revisionNumberById.get(right.schemaRevisionId) ?? 0) -
          (revisionNumberById.get(left.schemaRevisionId) ?? 0)
        return byRevision !== 0
          ? byRevision
          : right.computedAt.getTime() - left.computedAt.getTime()
      })
      .slice(0, limit)
      .map((row) => ({
        evaluationRunId: row.id,
        evaluationCorpusVersionId: row.evaluationCorpusVersionId,
        schemaRevisionId: row.schemaRevisionId,
        batchExtractionId: row.batchExtractionId,
        extractionId: row.extractionId,
        computedAt: row.computedAt,
        metrics: row.metrics as EvaluationRunSnapshot['metrics'],
      }))
  })
}
