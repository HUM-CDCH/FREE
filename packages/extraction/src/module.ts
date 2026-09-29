import type { ExtractionPersistence } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { resultPathKey } from './review-paths.js'
import { decodePinnedDocument } from './parsed-document.js'
import {
  occurrenceOwnership,
  parsePinnedSchema,
  reviewableExtraction,
  reviewAuthority,
  reviewDecisionMatchesSchema,
  transferVerdicts,
} from './review-rules.js'
import type { CancellationResult, FinalizeReviewResult, ExtractionModule, ReviewDecisionInput, RunSingleInput } from './types.js'

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
      return { extraction, reviewDecisions: [] }
    const raw = await persistence.readCanonicalParsedDocument(extraction.sourceRepresentationRevisionId)
    if (!raw) throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.')
    const document = decodePinnedDocument(raw)
    const occurrenceIdsByAnchor = occurrenceOwnership(document)
    const decisions = extraction.evidence.flatMap((link) => {
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
    return { extraction, reviewDecisions: decisions }
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
      const pinned = (await persistence.readExtraction(extractionId))?.reviewTransfer
      if (!pinned) return draft
      const { extraction, reviewDecisions } = await prepareReview(extractionId)
      const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
      if (!inputs) return draft
      const verdicts = transferVerdicts(pinned, extraction, parsePinnedSchema(inputs.schemaTree).schemaNodes)
      return {
        version: draft.version,
        // A review never saved starts from the decisions its pinned samples carry (design §7): draft decisions under
        // this Extraction's own paths, saved with the researcher's first edit and authoritative only once finalized.
        decisions: draft.version > 0 ? draft.decisions : reviewDecisions.flatMap((decision) => {
          const { decision: carried, entry } = verdicts.get(resultPathKey(decision.resultPath)) ?? {}
          return carried && entry
            ? [{ ...decision, ...carried, carriedFrom: { extractionId: entry.extractionId, sourcePathKey: entry.sourcePathKey } }]
            : []
        }),
        transfer: Object.fromEntries([...verdicts].map(([key, { status, kept }]) => [key, { status, kept }])),
      }
    },
    saveReviewDraft: async (extractionId, draft) => {
      const { extraction, reviewDecisions } = await prepareReview(extractionId)
      if (extraction.reviewedAt) throw new ExtractionError('review_conflict', 'This review is already finalized. Reload to see the saved review.')
      if (!extraction.reviewable) throw new ExtractionError('invalid_review', 'This Extraction cannot be reviewed.')
      const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
      if (!inputs) throw new ExtractionError('invalid_review', 'The pinned schema is unavailable.')
      const nodes = parsePinnedSchema(inputs.schemaTree).schemaNodes
      const prepared = new Map(reviewDecisions.map((decision) => [resultPathKey(decision.resultPath), decision]))
      const keys = draft.decisions.map((decision) => resultPathKey(decision.resultPath))
      if (!Number.isSafeInteger(draft.version) || draft.version < 0 || new Set(keys).size !== keys.length || draft.decisions.some((decision) => {
        const expected = prepared.get(resultPathKey(decision.resultPath))
        return !expected || expected.evidenceAnchorId !== decision.evidenceAnchorId ||
          expected.reviewedOccurrenceIds.length !== decision.reviewedOccurrenceIds.length ||
          !expected.reviewedOccurrenceIds.every((id) => decision.reviewedOccurrenceIds.includes(id)) ||
          !reviewDecisionMatchesSchema(nodes, decision)
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
