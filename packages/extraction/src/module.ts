import type {
  BatchMemberExtractionInput,
  ExtractionExecutionModule,
  ExtractionModel,
  ExtractionModelResponse,
  ExtractionModuleDependencies,
  LoadedExtractionInputs,
  TerminalExtraction,
} from './dependencies.js'
import { ExtractionError, extractionError } from './errors.js'
import { groundExtraction, populatedContentPaths, resultPathKey } from './grounding.js'
import { decodeParsedDocument, type ParsedDocument } from './parsed-document.js'
import {
  compileInstructions,
  isRecord,
  nodesToTemplate,
  parseExtractionSchema,
  partitionSchemaNodes,
  restoreSchemaNodeOrder,
  stripDescriptions,
} from './schema.js'
import type { ExtractionSchemaDefinition } from './schema.js'
import { canonicalSource } from './source-context.js'
import type {
  EvidenceLink,
  ExtractionDiagnostics,
  CancellationResult,
  FinalizeReviewResult,
  ExtractionSnapshot,
  ModelAttribution,
  ModelGenerationMetadata,
  ReviewDecision,
  RunSingleInput,
  RunSingleResult,
} from './types.js'

const DEFAULT_LIMIT = 50
type InternalRunSingleInput =
  | RunSingleInput
  | (BatchMemberExtractionInput & Readonly<{ kind: 'batch-member' }>)


type ActiveOperation = {
  input: InternalRunSingleInput
  controller: AbortController
  persisting: boolean
  promise: Promise<RunSingleResult>
}

type ExecutionState = {
  phase: ExtractionDiagnostics['phase']
  startedAt: number
  modelCalls: number
  metadata: ModelGenerationMetadata[]
  valuesAttribution: ModelAttribution | null
  ungroundedPaths: ExtractionDiagnostics['ungroundedPaths']
  groundingIssues: ExtractionDiagnostics['groundingIssues']
  groundingBatches: ExtractionDiagnostics['groundingBatches']
}

export function createExtractionModule(dependencies: ExtractionModuleDependencies): ExtractionExecutionModule {
  const now = dependencies.now ?? performance.now.bind(performance)
  const active = new Map<string, ActiveOperation>()

  const runInternal = async (input: InternalRunSingleInput, signal?: AbortSignal): Promise<RunSingleResult> => {
    const stored = await dependencies.persistence.readExtraction(input.extractionId)
    if (stored) {
      if (!sameExtractionIdentity(stored, input)) throw new ExtractionError('extraction_id_conflict', 'That Extraction ID is already bound to different inputs.')
      return { disposition: 'replayed', extraction: stored }
    }
    const concurrent = active.get(input.extractionId)
    if (concurrent) {
      if (!sameInput(concurrent.input, input)) throw new ExtractionError('extraction_id_conflict', 'That Extraction ID is already bound to different inputs.')
      return concurrent.promise
    }
    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const operation: ActiveOperation = {
      input,
      controller,
      persisting: false,
      promise: Promise.resolve(null as never),
    }
    operation.promise = execute(input, controller.signal, () => { operation.persisting = true })
      .finally(() => {
        signal?.removeEventListener('abort', abort)
        if (active.get(input.extractionId) === operation) active.delete(input.extractionId)
      })
    active.set(input.extractionId, operation)
    return operation.promise
  }
  const runSingle = (input: RunSingleInput, signal?: AbortSignal) => runInternal(input, signal)
  const runBatchMember = (input: BatchMemberExtractionInput, signal: AbortSignal) =>
    runInternal({ kind: 'batch-member', ...input }, signal)


  const cancelSingle = async (extractionId: string): Promise<CancellationResult> => {
    const operation = active.get(extractionId)
    if (operation && !operation.persisting) {
      operation.controller.abort()
      return 'cancellation-requested'
    }
    if (operation?.persisting) return 'already-terminal'
    return await dependencies.persistence.readExtraction(extractionId)
      ? 'already-terminal'
      : 'not-found'
  }

  const prepareReview = async (extractionId: string) => {
    const extraction = await dependencies.persistence.readExtraction(extractionId)
    if (!extraction) throw new ExtractionError('not_found', 'That Extraction was not found.')
    if (extraction.outcome !== 'SUCCEEDED' || !extraction.reviewable || !extraction.evidence)
      return { extraction, reviewDecisions: [] }
    const raw = await dependencies.persistence.readCanonicalParsedDocument(extraction.sourceRepresentationRevisionId)
    if (!raw) throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.')
    const document = decodeCanonical(raw)
    const occurrenceIdsByAnchor = occurrenceOwnership(document)
    const decisions = [...new Set(extraction.evidence.map((link) => link.evidenceAnchorId))].flatMap((evidenceAnchorId) => {
      const occurrences = occurrenceIdsByAnchor.get(evidenceAnchorId)
      return occurrences ? [{ evidenceAnchorId, reviewedOccurrenceIds: [...occurrences] }] : []
    })
    return { extraction, reviewDecisions: decisions }
  }

  const finalizeReview = async (extractionId: string, decisions: readonly ReviewDecision[]): Promise<FinalizeReviewResult> => {
    const extraction = await dependencies.persistence.readExtraction(extractionId)
    if (!extraction) throw new ExtractionError('not_found', 'That Extraction was not found.')
    if (extraction.outcome !== 'SUCCEEDED' || !extraction.reviewable || !extraction.result || !extraction.evidence)
      throw new ExtractionError('invalid_review', 'The Extraction has no reviewable Extraction Result.')
    const raw = await dependencies.persistence.readCanonicalParsedDocument(extraction.sourceRepresentationRevisionId)
    if (!raw) throw new ExtractionError('invalid_source_representation', 'The pinned Source Representation is unavailable.')
    const document = decodeCanonical(raw)
    const inputs = await dependencies.persistence.loadExtractionInputs(extraction.sourceRepresentationRevisionId, extraction.schemaRevisionId)
    if (!inputs) throw new ExtractionError('invalid_review', 'The Extraction has no valid pinned Schema Revision.')
    const definition = parsePinnedSchema(inputs.schemaTree)
    const reviewRecords = extractionRecords(extraction.result)
    if (!reviewRecords) throw new ExtractionError('invalid_review', 'The Extraction Result does not match its pinned Schema Revision.')
    try {
      for (const record of reviewRecords) restoreSchemaNodeOrder(record, definition.schemaNodes)
    } catch (error) {
      throw new ExtractionError('invalid_review', 'The Extraction Result does not match its pinned Schema Revision.', { cause: error })
    }
    const packageFields = new Set(partitionSchemaNodes(definition.schemaNodes).packageNodes.map((node) => node.name))
    const populatedResultPathKeys = new Set(
      populatedContentPaths(extraction.result)
        .filter((path) => {
          const field = path[0] === 'records' && typeof path[1] === 'number' ? path[2] : path[0]
          return typeof field !== 'string' || !packageFields.has(field)
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
    const finalized = await dependencies.persistence.finalizeReview(extractionId, {
      reviewDecisions: decisions.map((decision) => ({ evidenceAnchorId: decision.evidenceAnchorId, reviewedOccurrenceIds: [...decision.reviewedOccurrenceIds] })),
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
    runBatchMember,
    cancelSingle,
    prepareReview,
    finalizeReview,
    readDocumentExtractions: (input) =>
      dependencies.persistence.readDocumentExtractions(input),
    async scheduleBatch(input) {
      const result = await dependencies.persistence.scheduleBatch(input)
      if (!result) throw new ExtractionError('not_found', 'That Project Context was not found.')
      return result
    },
    async scheduleSuggestedBatch(input) {
      const result = await dependencies.persistence.scheduleSuggestedBatch(input)
      if (!result) throw new ExtractionError('not_found', 'That Schema Suggestion was not found.')
      return result
    },
    async listBatches({ projectContextId, limit = DEFAULT_LIMIT }) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ExtractionError('invalid_request', 'The Batch Extraction limit must be between 1 and 100.')
      const batches = await dependencies.persistence.listBatches(projectContextId, limit)
      if (!batches) throw new ExtractionError('not_found', 'That Project Context was not found.')
      return batches
    },
    async readBatch(input) {
      const batch = await dependencies.persistence.readBatch(input)
      if (!batch) throw new ExtractionError('not_found', 'That Batch Extraction was not found.')
      return batch
    },
    async readBatchResults(input) {
      const results = await dependencies.persistence.readBatchResults(input)
      if (!results) throw new ExtractionError('not_found', 'That Batch Extraction was not found.')
      return results
    },
  }

  async function execute(input: InternalRunSingleInput, signal: AbortSignal, beginPersist: () => void): Promise<RunSingleResult> {
    const startedAt = now()
    const inputs = await dependencies.persistence.loadExtractionInputs(
      input.sourceRepresentationRevisionId,
      input.schemaRevisionId,
    )
    if (!inputs) throw new ExtractionError('invalid_extraction_pins', 'The Source Representation Revision and Schema Revision do not share one Project Context.')
    const state: ExecutionState = {
      phase: 'loading', startedAt, modelCalls: 0, metadata: [], valuesAttribution: null,
      ungroundedPaths: [], groundingIssues: [], groundingBatches: [],
    }
    let document: ParsedDocument
    let result: Record<string, unknown> | null = null
    let evidence: readonly EvidenceLink[] | null = null
    let complete: boolean | null = null
    try {
      const models = await dependencies.models.open()
      state.valuesAttribution = models.attribution
      document = decodeCanonical(inputs.parsedDocument)
      const definition = parsePinnedSchema(inputs.schemaTree)
      const generated = await executeArticle(
        document,
        definition,
        models.model,
        signal,
        state,
      )
      result = generated.result
      complete = generated.complete
      state.phase = 'grounding'
      const packageFields = new Set(partitionSchemaNodes(definition.schemaNodes).packageNodes.map((node) => node.name))
      const grounding = await groundExtraction(document, result, models.groundingModel, signal, {
        excludedRootFields: packageFields,
        now,
      })
      evidence = grounding.evidence
      state.ungroundedPaths = grounding.ungroundedPaths
      state.groundingIssues = grounding.issues
      state.groundingBatches = grounding.batches
      state.metadata.push(...grounding.metadata)
      if (grounding.ungroundedPaths.length > 0 || grounding.issues.length > 0)
        complete = false
      beginPersist()
      state.phase = 'persisting'
      return await persistTerminal(input, inputs, state, { outcome: 'SUCCEEDED', complete, result, evidence, failure: null })
    } catch (error) {
      const mapped = extractionError(error)
      const failurePhase = state.phase
      beginPersist()
      state.phase = 'persisting'
      return await persistTerminal(input, inputs, state, {
        outcome: mapped.code === 'cancelled' || signal.aborted ? 'CANCELLED' : 'FAILED',
        complete: null,
        result: null,
        evidence: null,
        failure: { code: mapped.code, message: mapped.message, phase: failurePhase },
      })
    }
  }

  async function invoke(model: ExtractionModel, document: string, pages: number, template: Record<string, unknown>, instruction: string, signal: AbortSignal, state: ExecutionState): Promise<ExtractionModelResponse> {
    state.phase = 'extracting'
    state.modelCalls += 1
    const generated = await model.extract({ document: { markdown: document, pages }, template, ...(instruction && { instruction }), signal })
    state.metadata.push(generated.metadata)
    return generated
  }

  async function executeArticle(document: ParsedDocument, definition: ExtractionSchemaDefinition, model: ExtractionModel, signal: AbortSignal, state: ExecutionState) {
    const { packageNodes } = partitionSchemaNodes(definition.schemaNodes)
    const modelNodes = definition.schemaNodes.filter((node) => node.valueSource !== 'source-filename')
    const described = { records: [{ _description: definition.recordDescription, ...nodesToTemplate(modelNodes) }] }
    const generated = await invoke(model, canonicalSource(document), document.page_count, stripDescriptions(described) as Record<string, unknown>, compileInstructions(described), signal, state)
    const records = extractionRecords(generated.result)
    if (!records) throw new ExtractionError('invalid_model_output', 'Article Extraction Strategy records must be objects.')
    const packageValues = Object.fromEntries(packageNodes.map((node) => [node.name, document.document.source.original_filename]))
    return {
      result: {
        records: records.map((record) =>
          restoreSchemaNodeOrder({ ...record, ...packageValues }, definition.schemaNodes),
        ),
      },
      complete: generated.metadata.finishReason !== 'length',
    }
  }

  async function persistTerminal(input: InternalRunSingleInput, inputs: LoadedExtractionInputs, state: ExecutionState, terminal: Pick<TerminalExtraction, 'outcome' | 'complete' | 'result' | 'evidence' | 'failure'>): Promise<RunSingleResult> {
    const metadata = state.metadata
    const diagnostics: ExtractionDiagnostics = {
      phase: state.phase,
      durationMs: Math.max(0, Math.round(now() - state.startedAt)),
      modelCalls: state.modelCalls,
      finishReason: metadata.some((entry) => entry.finishReason === 'length') ? 'length' : metadata.at(-1)?.finishReason ?? null,
      inputTokens: sumNullable(metadata.map((entry) => entry.inputTokens)),
      outputTokens: sumNullable(metadata.map((entry) => entry.outputTokens)),
      ungroundedPaths: state.ungroundedPaths,
      groundingIssues: state.groundingIssues,
      groundingBatches: state.groundingBatches,
    }
    const persisted = await dependencies.persistence.persistExtraction({
      extractionId: input.extractionId,
      sourceDocumentId: inputs.sourceDocumentId,
      sourceRepresentationRevisionId: inputs.sourceRepresentationRevisionId,
      schemaRevisionId: inputs.schemaRevisionId,
      strategy: 'ARTICLE',
      ...terminal,
      modelAttribution: state.valuesAttribution,
      diagnostics,
      reviewable:
        terminal.outcome === 'SUCCEEDED' &&
        terminal.result !== null &&
        terminal.evidence !== null,
      retryOfId: null,
      batchExtractionId: input.kind === 'batch-member' ? input.batchExtractionId : null,
    })
    if (persisted.status === 'invalid') throw new ExtractionError('invalid_extraction_pins', 'The pinned Extraction inputs are no longer valid.')
    if (persisted.status === 'conflict') throw new ExtractionError('extraction_id_conflict', 'That Extraction ID is already bound to different inputs.')
    return { disposition: persisted.status === 'created' ? 'created' : 'replayed', extraction: persisted.extraction }
  }
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

function sameExtractionIdentity(stored: ExtractionSnapshot, input: InternalRunSingleInput): boolean {
  return stored.extractionId === input.extractionId &&
    stored.retryOfId === null &&
    stored.sourceRepresentationRevisionId === input.sourceRepresentationRevisionId &&
    stored.schemaRevisionId === input.schemaRevisionId &&
    stored.strategy === 'ARTICLE' &&
    stored.batchExtractionId === (input.kind === 'batch-member' ? input.batchExtractionId : null)
}

function sameInput(left: InternalRunSingleInput, right: InternalRunSingleInput): boolean {
  if (left.kind !== right.kind || left.extractionId !== right.extractionId) return false
  if (left.kind === 'batch-member' && right.kind === 'batch-member') return left.sourceRepresentationRevisionId === right.sourceRepresentationRevisionId && left.schemaRevisionId === right.schemaRevisionId && left.strategy === right.strategy && left.batchExtractionId === right.batchExtractionId
  return left.kind === 'fresh' && right.kind === 'fresh' && left.sourceRepresentationRevisionId === right.sourceRepresentationRevisionId && left.schemaRevisionId === right.schemaRevisionId && left.strategy === right.strategy
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null
}
