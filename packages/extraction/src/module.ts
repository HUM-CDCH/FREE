import type { ExtractionJobExecutor, ExtractionJobExecutorDependencies, ExtractionPersistence } from './dependencies.js'
import { ExtractionError } from './errors.js'
import { populatedContentPaths, resultPathKey } from './review-paths.js'
import { decodeParsedDocument, type ParsedDocument } from './parsed-document.js'
import { isRecord, parseExtractionSchema, partitionSchemaNodes, restoreSchemaNodeOrder, schemaNodeAtPath } from './schema.js'
import type { CancellationResult, FinalizeReviewResult, ExtractionModule, ExtractionSchemaNode, ReviewDecisionInput, RunSingleInput } from './types.js'

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
    const document = decodeCanonical(raw)
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
    const extraction = await persistence.readExtraction(extractionId)
    if (!extraction) throw new ExtractionError('not_found', 'That Extraction was not found.')
    if (extraction.outcome !== 'SUCCEEDED' || !extraction.reviewable || !extraction.result || !extraction.evidence)
      throw new ExtractionError('invalid_review', 'The Extraction has no reviewable Extraction Result.')
    const raw = await persistence.readCanonicalParsedDocument(extraction.sourceRepresentationRevisionId)
    if (!raw) throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.')
    const document = decodeCanonical(raw)
    const inputs = await persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
    if (!inputs) throw new ExtractionError('invalid_review', 'The Extraction has no valid pinned Schema Revision.')
    const definition = parsePinnedSchema(inputs.schemaTree)
    const reviewRecords = extractionRecords(extraction.result)
    if (!reviewRecords) throw new ExtractionError('invalid_review', 'The Extraction Result does not match its pinned Schema Revision.')
    try {
      for (const record of reviewRecords) restoreSchemaNodeOrder(record, definition.schemaNodes)
    } catch (error) {
      throw new ExtractionError('invalid_review', 'The Extraction Result does not match its pinned Schema Revision.', { cause: error })
    }
    // Neither a source-filename field (filled from the package, never by the model) nor a
    // document-level one (read once for the whole source; kei-exp reports its name under
    // `unverified` and grounds it in no record) carries evidence, so neither is grounded nor
    // ungrounded in the review's sense: both stay outside the coverage invariant.
    const partition = partitionSchemaNodes(definition.schemaNodes)
    const unreviewedFields = new Set([...partition.packageNodes, ...partition.documentNodes].map((node) => node.name))
    const populatedResultPathKeys = new Set(
      populatedContentPaths(extraction.result)
        .filter((path) => {
          const field = path[0] === 'records' && typeof path[1] === 'number' ? path[2] : path[0]
          return typeof field !== 'string' || !unreviewedFields.has(field)
        })
        .map(resultPathKey),
    )
    const evidencePathKeys = extraction.evidence.map((link) => resultPathKey(link.resultPath))
    const ungroundedPathKeys = extraction.diagnostics.ungroundedPaths.map(resultPathKey)
    const evidenceResultPathKeys = new Set(evidencePathKeys)
    const ungroundedResultPathKeys = new Set(ungroundedPathKeys)
    const accountedResultPathKeys = new Set([...evidenceResultPathKeys, ...ungroundedResultPathKeys])
    if (
      evidenceResultPathKeys.size !== evidencePathKeys.length ||
      ungroundedResultPathKeys.size !== ungroundedPathKeys.length ||
      [...evidenceResultPathKeys].some((key) => ungroundedResultPathKeys.has(key)) ||
      accountedResultPathKeys.size !== populatedResultPathKeys.size ||
      [...accountedResultPathKeys].some((key) => !populatedResultPathKeys.has(key))
    )
      throw new ExtractionError('invalid_review', 'The Extraction grounding coverage does not match its stored Extraction Result.')
    const evidenceByPath = new Map(
      extraction.evidence.map((link) => [resultPathKey(link.resultPath), link]),
    )
    if (
      decisions.length !== evidenceByPath.size ||
      decisions.some((decision) => {
        const link = evidenceByPath.get(resultPathKey(decision.resultPath))
        return (
          !link ||
          link.evidenceAnchorId !== decision.evidenceAnchorId ||
          !reviewDecisionMatchesSchema(definition.schemaNodes, decision)
        )
      })
    )
      throw new ExtractionError(
        'invalid_review',
        'The Review Decisions do not match the pinned Extraction Result.',
      )
    const finalized = await persistence.finalizeReview(extractionId, {
      expectedDraftVersion,
      reviewDecisions: decisions.map((decision) => ({
        resultPath: [...decision.resultPath],
        evidenceAnchorId: decision.evidenceAnchorId,
        reviewedOccurrenceIds: [...decision.reviewedOccurrenceIds],
        action: decision.action,
        reviewedValue: decision.reviewedValue,
      })),
      occurrenceIdsByAnchor: occurrenceOwnership(document),
      evidenceResultPathKeys,
    })
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
      return draft
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

/** Relay one claimed job to kei-exp; persistence and leases remain owned by FREE. */
export function createExtractionJobExecutor({ inputs: reader, keiExp }: ExtractionJobExecutorDependencies): ExtractionJobExecutor {
  return async (input, signal) => {
    if (input.kind === 'retry')
      throw new ExtractionError('invalid_retry', 'kei-exp does not support targeted Catalog retries. Start a new Extraction.')
    signal.throwIfAborted()
    const inputs = await reader.loadExtractionInputs(input.sourceRepresentationRevisionId, input.schemaRevisionId)
    if (!inputs) throw new ExtractionError('invalid_extraction_pins', 'The Source Representation Revision and Schema Revision do not share one Project Context.')
    const document = decodeCanonical(inputs.parsedDocument)
    const schema = parsePinnedSchema(inputs.schemaTree)
    const artifact = await keiExp.extract({
      runId: document.document.document_id,
      schema,
      strategy: input.strategy === 'CATALOG' ? 'catalog' : 'article',
      catalogRecipe: input.kind === 'fresh' && input.strategy === 'CATALOG' ? input.catalogRecipe ?? null : null,
      // Fresh runs and batch members carry their choice; unchosen roles use deployment defaults.
      models: input.models ?? null,
      expectedGeneration: pinnedGeneration(document),
      signal,
    })
    signal.throwIfAborted()
    const grounded = artifact.extraction_version === 2 ? artifact : null
    return {
      extractionId: input.extractionId,
      sourceDocumentId: inputs.sourceDocumentId,
      sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
      schemaRevisionId: input.schemaRevisionId,
      strategy: input.strategy,
      outcome: 'SUCCEEDED',
      complete: artifact.complete,
      result: { records: artifact.records },
      evidence: grounded
        ? grounded.evidence.map(link => ({
            resultPath: link.path,
            evidenceAnchorId: `a_${link.segment}`,
            verbatim: link.verbatim,
            lexicalHits: link.hits,
            grounding: {
              linkedBy: link.linked_by, provenance: link.provenance, textSpans: link.spans, keySpans: link.key_spans,
              alternatives: link.alternatives, heading: link.heading, precision: link.precision, raw: link.raw,
              normalized: link.normalized && {
                value: link.normalized.value, rule: link.normalized.rule,
                keySpan: link.normalized.key_span, expansionSpan: link.normalized.expansion_span,
              },
            },
          }))
        : artifact.evidence.map(link => ({
            resultPath: link.path,
            evidenceAnchorId: `a_${link.segment}`,
            verbatim: link.verbatim,
            lexicalHits: link.hits,
            ...(link.linked_by === 'lexical' ? { linkedBy: 'lexical' as const } : {}),
          })),
      modelAttribution: { provider: 'kei-exp', modelId: artifact.model },
      diagnostics: {
        phase: 'persisting', durationMs: Math.round(artifact.seconds * 1000),
        modelCalls: artifact.calls.length, inputTokens: artifact.tokens.input, outputTokens: artifact.tokens.output,
        finishReason: null, ungroundedPaths: artifact.ungrounded, groundingIssues: artifact.issues,
        // Document-level fields: extracted into every record, grounded in none of them.
        groundingBatches: [], unverifiedFields: artifact.unverified, catalog: null, retry: null,
        models: { fields: artifact.models.fields, reasoning: artifact.models.reasoning },
        ...(grounded
          ? {
              grounded: {
                recipe: `${grounded.segmentation.recipe.id}@${grounded.segmentation.recipe.version}`,
                segmentationFingerprint: grounded.segmentation.fingerprint,
                budget: { inputTokens: grounded.budget.input_tokens, outputTokens: grounded.budget.output_tokens, tokenizer: grounded.budget.tokenizer },
                segmentationDiagnostics: grounded.segmentation.diagnostics,
                normalization: grounded.normalization,
                recordBlocks: grounded.record_blocks,
                proposed: grounded.proposed,
                rejected: grounded.rejected,
                competitors: grounded.competitors,
                coverage: grounded.coverage,
                completeness: grounded.completeness,
              },
            }
          : {}),
      },
      failure: null, reviewable: true, retryOfId: null,
      batchExtractionId: input.kind === 'batch-member' ? input.batchExtractionId : null,
    }
  }
}

/** The parse generation a kei-exp Source Representation is pinned to, read back out of its
 *  `preprocess_id` (`kei-exp:{run}:{generation}`). Null for a representation from another parser,
 *  whose revisions kei-exp's generations say nothing about. */
function pinnedGeneration(document: ParsedDocument): string | null {
  if (document.preprocessing.profile !== 'kei-exp') return null
  const prefix = `kei-exp:${document.document.document_id}:`
  const preprocessId = document.preprocessing.preprocess_id
  if (!preprocessId.startsWith(prefix) || preprocessId.length === prefix.length)
    throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation does not name a kei-exp parse generation.')
  return preprocessId.slice(prefix.length)
}

function decodeCanonical(raw: unknown): ParsedDocument {
  try { return decodeParsedDocument(raw) }
  catch (error) { throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is not a valid ParsedDocument v2.', { cause: error }) }
}

function parsePinnedSchema(raw: unknown) {
  try { return parseExtractionSchema(raw) }
  catch (error) { throw new ExtractionError('invalid_schema_revision', 'The pinned Schema Revision is invalid.', { cause: error }) }
}

function extractionRecords(result: Readonly<Record<string, unknown>>): Record<string, unknown>[] | null {
  return Object.keys(result).every((key) => key === 'records') && Array.isArray(result.records) && result.records.every(isRecord) ? result.records : null
}

function occurrenceOwnership(document: ParsedDocument): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(document.evidence_index.anchors.map((anchor) => [anchor.anchor_id, new Set(anchor.producer_observations.map((observation) => observation.occurrence_id))]))
}

const reviewSchemaNode = schemaNodeAtPath

function reviewDecisionMatchesSchema(
  nodes: readonly ExtractionSchemaNode[],
  decision: ReviewDecisionInput,
): boolean {
  if (
    !['APPROVED', 'EDITED', 'REJECTED'].includes(decision.action) ||
    (decision.action === 'EDITED') !== (decision.reviewedValue !== null)
  )
    return false
  if (decision.action !== 'EDITED') return true
  const node = reviewSchemaNode(nodes, decision.resultPath)
  if (!node) return false
  const type =
    node.type === 'array' && node.itemType ? node.itemType : node.type
  const value = decision.reviewedValue
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value)
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'string' && node.allowedValues)
    return typeof value === 'string' && node.allowedValues.includes(value)
  return (
    type === 'string' || type === 'verbatim-string' || type === 'date'
  ) && typeof value === 'string'
}
