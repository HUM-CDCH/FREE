import type { ExtractionPersistence } from './dependencies.js'
import { reviewAttention } from './review-attention.js'
import { ExtractionError } from './errors.js'
import { resultPathKey } from './review-paths.js'
import { decodePinnedDocument } from './parsed-document.js'
import {
  correctionEvidenceIsPublished,
  occurrenceOwnership,
  optionalDecisionIsPublished,
  parsePinnedSchema,
  reviewableExtraction,
  reviewAuthority,
  reviewDecisionMatchesSchema,
  runningDraftMatchesDocument,
} from './review-rules.js'
import type {
  CancellationResult, FinalizeReviewResult, ExtractionAttemptSnapshot, ExtractionModule, ReviewDecisionInput, ReviewDraft, RunSingleInput,
} from './types.js'

const DEFAULT_LIMIT = 50

export function createExtractionModule(persistence: ExtractionPersistence): ExtractionModule {
  const runSingle = async (input: RunSingleInput) => {
    const result = await persistence.scheduleExtraction(input)
    if (!result) throw new ExtractionError('not_found', 'That Extraction was not found.')
    return result
  }

  const cancelSingle = (extractionId: string): Promise<CancellationResult> =>
    persistence.cancelExtraction(extractionId)

  const prepareReview = async (extractionId: string) => {
    const extraction = await persistence.readExtraction(extractionId)
    if (!extraction) throw new ExtractionError('not_found', 'That Extraction was not found.')
    if (extraction.outcome !== 'SUCCEEDED' || !extraction.reviewable || !extraction.evidence)
      return { extraction, reviewDecisions: [], occurrenceIdsByAnchor: new Map<string, ReadonlySet<string>>() }
    const raw = await persistence.readCanonicalParsedDocument(extraction.sourceRepresentationRevisionId)
    if (!raw) throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.')
    const document = decodePinnedDocument(raw)
    const occurrenceIdsByAnchor = occurrenceOwnership(document)
    const decisions: ReviewDecisionInput[] = extraction.evidence.flatMap((link) => {
      const occurrences = occurrenceIdsByAnchor.get(link.evidenceAnchorId)
      return occurrences
        ? [{
            resultPath: [...link.resultPath],
            evidenceAnchorId: link.evidenceAnchorId,
            reviewedOccurrenceIds: [...occurrences],
            action: 'APPROVED' as const,
            reviewedValue: null,
          }]
        : []
    })
    const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
    if (inputs && extraction.result) {
      const attention = reviewAttention(extraction.result, parsePinnedSchema(inputs.schemaTree).schemaNodes, extraction.evidence, [])
      for (const cell of attention.cells.filter((cell) => cell.presence !== 'grounded'))
        decisions.push({ resultPath: [...cell.resultPath], evidenceAnchorId: null, reviewedOccurrenceIds: [], action: 'APPROVED', reviewedValue: null })
    }
    return { extraction, reviewDecisions: decisions, occurrenceIdsByAnchor }
  }

  /** A draft on an Extraction that has not settled (ADR 0016): checked against the pinned document and Schema Revision
   * only. kei's progress is a best-effort view and is never consulted; settlement reconciles what kei never produced. */
  const saveRunningDraft = async (extraction: ExtractionAttemptSnapshot, draft: ReviewDraft) => {
    const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
    if (!inputs) throw new ExtractionError('invalid_review', 'The pinned schema is unavailable.')
    const owned = occurrenceOwnership(decodePinnedDocument(inputs.parsedDocument))
    const nodes = parsePinnedSchema(inputs.schemaTree).schemaNodes
    const keys = draft.decisions.map((decision) => resultPathKey(decision.resultPath))
    if (!Number.isSafeInteger(draft.version) || draft.version < 0 || new Set(keys).size !== keys.length ||
      !draft.decisions.every((decision) => runningDraftMatchesDocument(owned, nodes, decision)))
      throw new ExtractionError('invalid_review', 'Draft decisions do not match the pinned document and schema.')
    return persistence.saveReviewDraft(extraction.extractionId, draft)
  }

  const finalizeReview = async (extractionId: string, decisions: readonly ReviewDecisionInput[], expectedDraftVersion = 0): Promise<FinalizeReviewResult> => {
    const read = await persistence.readExtraction(extractionId)
    if (!read) throw new ExtractionError('not_found', 'That Extraction was not found.')
    const extraction = reviewableExtraction(read)
    const raw = await persistence.readCanonicalParsedDocument(extraction.sourceRepresentationRevisionId)
    if (!raw) throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.')
    const document = decodePinnedDocument(raw)
    const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
    if (!inputs) throw new ExtractionError('invalid_review', 'The Extraction has no valid pinned Schema Revision.')
    const finalized = await persistence.finalizeReview(
      extractionId,
      reviewAuthority({ extraction, document, schemaTree: inputs.schemaTree, decisions, expectedDraftVersion }),
    )
    if (finalized.status === 'not-found') throw new ExtractionError('not_found', 'That Extraction was not found.')
    if (finalized.status === 'conflict') throw new ExtractionError('review_conflict', 'That Extraction was reviewed differently.')
    if (finalized.status === 'invalid') throw new ExtractionError('invalid_review', 'The Extraction review does not match its stored Evidence.')
    if (!('extraction' in finalized))
      throw new ExtractionError('invalid_review', 'The reviewed Extraction could not be read.')
    return { disposition: finalized.status, extraction: finalized.extraction }
  }

  return {
    runSingle,
    cancelSingle,
    readExtractionAttempt: (extractionId) => persistence.readExtractionAttempt(extractionId),
    prepareReview,
    finalizeReview,
    resetReview: async (extractionId, expectedDraftVersion) => {
      if (!Number.isSafeInteger(expectedDraftVersion) || expectedDraftVersion < 0)
        throw new ExtractionError('invalid_review', 'The review version is invalid.')
      const extraction = await persistence.readExtraction(extractionId)
      if (!extraction) throw new ExtractionError('not_found', 'That Extraction was not found.')
      if (!extraction.reviewable) throw new ExtractionError('invalid_review', 'This Extraction cannot be reviewed.')
      return persistence.resetReview(extractionId, expectedDraftVersion)
    },
    readReviewDraft: async (extractionId) => {
      const draft = await persistence.readReviewDraft(extractionId)
      if (!draft) throw new ExtractionError('not_found', 'That Extraction was not found.')
      const extraction = await persistence.readExtraction(extractionId)
      if (!extraction?.result || !extraction.evidence) return draft
      const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
      if (!inputs) return draft
      const nodes = parsePinnedSchema(inputs.schemaTree).schemaNodes
      // A draft drafted while the Extraction ran is reconciled here, never rewritten (ADR 0016): a decision is kept when
      // the settled Evidence links the same path to the same anchor (or it is an optional decision); the rest are
      // reported dropped until the next draft save replaces them.
      const linked = new Set(extraction.evidence.map((link) => `${resultPathKey(link.resultPath)} ${link.evidenceAnchorId}`))
      const kept = (decision: ReviewDecisionInput) =>
        decision.evidenceAnchorId === null || linked.has(`${resultPathKey(decision.resultPath)} ${decision.evidenceAnchorId}`)
      const decisions = draft.decisions.filter(kept)
      const dropped = draft.decisions.filter((decision) => !kept(decision))
        .map(({ resultPath, evidenceAnchorId }) => ({ resultPath, evidenceAnchorId }))
      return {
        ...draft, decisions, ...(dropped.length > 0 ? { dropped } : {}),
        attention: reviewAttention(extraction.result, nodes, extraction.evidence, extraction.reviewedAt ? extraction.reviewDecisions : decisions),
      }
    },
    saveReviewDraft: async (extractionId, draft) => {
      const attempt = await persistence.readExtractionAttempt(extractionId)
      if (!attempt) throw new ExtractionError('not_found', 'That Extraction was not found.')
      if (attempt.durable) throw new ExtractionError('invalid_review', 'Review this Extraction’s retained values using their saved producing inputs.')
      if (attempt.executionStatus === 'QUEUED' || attempt.executionStatus === 'RUNNING') return saveRunningDraft(attempt, draft)
      if (attempt.executionStatus !== 'COMPLETED') throw new ExtractionError('invalid_review', 'This Extraction cannot be reviewed.')
      const { extraction, reviewDecisions, occurrenceIdsByAnchor } = await prepareReview(extractionId)
      if (extraction.reviewedAt) throw new ExtractionError('review_conflict', 'This review is already finalized. Reload to see the saved review.')
      if (!extraction.reviewable) throw new ExtractionError('invalid_review', 'This Extraction cannot be reviewed.')
      const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
      if (!inputs) throw new ExtractionError('invalid_review', 'The pinned schema is unavailable.')
      const nodes = parsePinnedSchema(inputs.schemaTree).schemaNodes
      const prepared = new Map(reviewDecisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
      const keys = draft.decisions.map((decision) => resultPathKey(decision.resultPath))
      if (!Number.isSafeInteger(draft.version) || draft.version < 0 || new Set(keys).size !== keys.length || draft.decisions.some((decision) => {
        const expected = prepared.get(resultPathKey(decision.resultPath))
        return !expected || (decision.evidenceAnchorId === null && !optionalDecisionIsPublished(occurrenceIdsByAnchor, decision)) || expected.evidenceAnchorId !== decision.evidenceAnchorId ||
          expected.reviewedOccurrenceIds.length !== decision.reviewedOccurrenceIds.length ||
          !expected.reviewedOccurrenceIds.every((id) => decision.reviewedOccurrenceIds.includes(id)) ||
          !reviewDecisionMatchesSchema(nodes, decision) || !correctionEvidenceIsPublished(occurrenceIdsByAnchor, decision)
      })) throw new ExtractionError('invalid_review', 'Draft decisions do not match the pinned Extraction Result and Evidence.')
      return persistence.saveReviewDraft(extractionId, draft)
    },
    readDocumentExtractions: (input) =>
      persistence.readDocumentExtractions(input),
    async scheduleBatch(input) {
      const result = await persistence.scheduleBatch(input)
      if (!result) throw new ExtractionError('not_found', 'That Project Context was not found.')
      return result
    },
    async scheduleSuggestedBatch(input) {
      const result = await persistence.scheduleSuggestedBatch(input)
      if (!result) throw new ExtractionError('not_found', 'That Schema Suggestion was not found.')
      return result
    },
    async listBatches({ projectContextId, limit = DEFAULT_LIMIT }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ExtractionError('invalid_request', 'The Batch Extraction limit must be between 1 and 100.')
      const batches = await persistence.listBatches(projectContextId, limit)
      if (!batches) throw new ExtractionError('not_found', 'That Project Context was not found.')
      return batches
    },
    async readBatch(input) {
      const batch = await persistence.readBatch(input)
      if (!batch) throw new ExtractionError('not_found', 'That Batch Extraction was not found.')
      return batch
    },
    async readBatchResults(input) {
      const results = await persistence.readBatchResults(input)
      if (!results) throw new ExtractionError('not_found', 'That Batch Extraction was not found.')
      return results
    },
  }
}
