import type {
  BatchMemberExtractionInput,
  ExtractionExecutionModule,
  ExtractionModel,
  ExtractionModelResponse,
  ExtractionModuleDependencies,
  LoadedExtractionInputs,
  TerminalExtraction,
} from './dependencies.js'
import {
  CatalogBoundaryResolutionError,
  resolveCatalogBoundaries,
  type CatalogBoundary,
} from './catalog-boundaries.js'
import {
  CATALOG_NOT_ATTEMPTED_LIMIT,
  CATALOG_RECORD_LIMIT,
  reuseCall,
  seedCatalogDiagnostics,
  sameRetrySelection,
  setCatalogStage,
  validateCatalogRetry,
  type CatalogRetryContext,
  type MutableCatalogDiagnostics,
} from './catalog.js'
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
import {
  canonicalSource,
  canonicalSourceSlice,
  catalogDiscoveryContext,
} from './source-context.js'
import type {
  CatalogStageDiagnostics,
  EvidenceLink,
  ExtractionDiagnostics,
  ExtractionRetrySelection,
  ExtractionStrategy,
  CancellationResult,
  FinalizeReviewResult,
  ExtractionSnapshot,
  ExtractionSchemaNode,
  ModelAttribution,
  ModelGenerationMetadata,
  ReviewDecisionInput,
  ResultPath,
  RunSingleInput,
  RunSingleResult,
} from './types.js'

const DEFAULT_LIMIT = 50
type InternalRunSingleInput =
  | RunSingleInput
  | (BatchMemberExtractionInput & Readonly<{ kind: 'batch-member' }>)


type ActiveOperation = {
  scope: string
  input: InternalRunSingleInput
  controller: AbortController
  persisting: boolean
  promise: Promise<RunSingleResult>
}
export class ExtractionOperationRegistry {
  private readonly active = new Map<string, ActiveOperation>()

  get(extractionId: string): ActiveOperation | undefined {
    return this.active.get(extractionId)
  }

  set(extractionId: string, operation: ActiveOperation): void {
    this.active.set(extractionId, operation)
  }

  delete(extractionId: string, operation: ActiveOperation): void {
    if (this.active.get(extractionId) === operation)
      this.active.delete(extractionId)
  }
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
  catalog: MutableCatalogDiagnostics | null
  retry: ExtractionRetrySelection | null
}

/** One run's durable identity after retry inputs are resolved against their parent. */
type ResolvedRun = Readonly<{
  input: InternalRunSingleInput
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  retryOfId: string | null
  batchExtractionId: string | null
  retry: CatalogRetryContext | null
}>

export function createExtractionModule(
  dependencies: ExtractionModuleDependencies,
  options: Readonly<{
    operations?: ExtractionOperationRegistry
    operationScope?: string
  }> = {},
): ExtractionExecutionModule {
  const now = dependencies.now ?? performance.now.bind(performance)
  const operations = options.operations ?? new ExtractionOperationRegistry()
  const operationScope = options.operationScope ?? ''

  const runInternal = async (input: InternalRunSingleInput, signal?: AbortSignal): Promise<RunSingleResult> => {
    const concurrent = operations.get(input.extractionId)
    if (concurrent) {
      if (concurrent.scope !== operationScope)
        throw new ExtractionError('not_found', 'That Extraction was not found.')
      if (!sameInput(concurrent.input, input))
        throw new ExtractionError(
          'extraction_id_conflict',
          'That Extraction ID is already bound to different inputs.',
        )
      return concurrent.promise
    }

    const controller = new AbortController()
    const abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    const operation: ActiveOperation = {
      scope: operationScope,
      input,
      controller,
      persisting: false,
      promise: Promise.resolve(null as never),
    }
    operations.set(input.extractionId, operation)
    operation.promise = (async () => {
      const stored = await dependencies.persistence.readExtraction(
        input.extractionId,
      )
      if (stored) {
        if (!sameExtractionIdentity(stored, input))
          throw new ExtractionError(
            'extraction_id_conflict',
            'That Extraction ID is already bound to different inputs.',
          )
        return { disposition: 'replayed' as const, extraction: stored }
      }
      if (
        !(await dependencies.persistence.isExtractionIdAvailable(
          input.extractionId,
        ))
      )
        throw new ExtractionError(
          'not_found',
          'That Extraction was not found.',
        )
      return execute(input, controller.signal, () => {
        operation.persisting = true
      })
    })().finally(() => {
      signal?.removeEventListener('abort', abort)
      operations.delete(input.extractionId, operation)
    })
    return operation.promise
  }
  const runSingle = (input: RunSingleInput, signal?: AbortSignal) => runInternal(input, signal)
  const runBatchMember = (input: BatchMemberExtractionInput, signal: AbortSignal) =>
    runInternal({ kind: 'batch-member', ...input }, signal)


  const cancelSingle = async (extractionId: string): Promise<CancellationResult> => {
    const active = operations.get(extractionId)
    const operation = active?.scope === operationScope ? active : undefined
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

  const finalizeReview = async (extractionId: string, decisions: readonly ReviewDecisionInput[]): Promise<FinalizeReviewResult> => {
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
    const finalized = await dependencies.persistence.finalizeReview(extractionId, {
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

  async function resolveRun(input: InternalRunSingleInput): Promise<ResolvedRun> {
    if (input.kind === 'retry') {
      const parent = await dependencies.persistence.readExtraction(input.retryOfId)
      const retry = validateCatalogRetry(parent, input)
      return {
        input,
        sourceRepresentationRevisionId: retry.parent.sourceRepresentationRevisionId,
        schemaRevisionId: retry.parent.schemaRevisionId,
        strategy: 'CATALOG',
        retryOfId: retry.parent.extractionId,
        // A retry stays in the Batch Extraction its parent belongs to.
        batchExtractionId: retry.parent.batchExtractionId,
        retry,
      }
    }
    return {
      input,
      sourceRepresentationRevisionId: input.sourceRepresentationRevisionId,
      schemaRevisionId: input.schemaRevisionId,
      strategy: input.strategy,
      retryOfId: null,
      batchExtractionId: input.kind === 'batch-member' ? input.batchExtractionId : null,
      retry: null,
    }
  }

  async function execute(input: InternalRunSingleInput, signal: AbortSignal, beginPersist: () => void): Promise<RunSingleResult> {
    const startedAt = now()
    const resolved = await resolveRun(input)
    const inputs = await dependencies.persistence.loadExtractionInputs(
      resolved.sourceRepresentationRevisionId,
      resolved.schemaRevisionId,
    )
    if (!inputs) throw new ExtractionError('invalid_extraction_pins', 'The Source Representation Revision and Schema Revision do not share one Project Context.')
    const state: ExecutionState = {
      phase: 'loading', startedAt, modelCalls: 0, metadata: [], valuesAttribution: null,
      ungroundedPaths: [], groundingIssues: [], groundingBatches: [],
      catalog: resolved.strategy === 'CATALOG' ? seedCatalogDiagnostics() : null,
      retry: resolved.retry?.selection ?? null,
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
      const generated = resolved.strategy === 'CATALOG'
        ? await executeCatalog(
            document,
            definition,
            models.model,
            signal,
            state,
            resolved.retry,
          )
        : await executeArticle(
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
      if (state.catalog) setGroundingStage(state.catalog, grounding.batches, grounding.issues)
      if (grounding.ungroundedPaths.length > 0 || grounding.issues.length > 0)
        complete = false
      beginPersist()
      state.phase = 'persisting'
      return await persistTerminal(resolved, inputs, state, { outcome: 'SUCCEEDED', complete, result, evidence, failure: null })
    } catch (error) {
      const mapped = extractionError(error)
      const failurePhase = state.phase
      beginPersist()
      state.phase = 'persisting'
      return await persistTerminal(resolved, inputs, state, {
        outcome: mapped.code === 'cancelled' || signal.aborted ? 'CANCELLED' : 'FAILED',
        complete: null,
        result: null,
        evidence: null,
        failure: { code: mapped.code, message: mapped.message, phase: failurePhase },
      })
    }
  }

  function callDiagnostic(
    outcome: CatalogStageDiagnostics['outcome'],
    startedAt: number,
    metadata: ModelGenerationMetadata | null,
    failureCode: string | null = null,
    calls = outcome === 'not_attempted' ? 0 : 1,
  ): Omit<CatalogStageDiagnostics, 'stage'> {
    return {
      provenance: 'executed',
      outcome,
      finishReason: metadata?.finishReason ?? null,
      calls,
      inputTokens: metadata?.inputTokens ?? null,
      outputTokens: metadata?.outputTokens ?? null,
      durationMs:
        calls === 0 ? 0 : metadata?.durationMs ?? Math.max(0, Math.round(now() - startedAt)),
      failureCode,
    }
  }

  function setGroundingStage(
    catalog: MutableCatalogDiagnostics,
    batches: ExtractionDiagnostics['groundingBatches'],
    issues: ExtractionDiagnostics['groundingIssues'],
  ): void {
    const issueCode = issues.map((issue) => issue.code).find((code) => typeof code === 'string')
    setCatalogStage(catalog, 'grounding', {
      provenance: 'executed',
      outcome:
        batches.some((batch) => batch.outcome === 'failed') || issues.length > 0
          ? 'failed'
          : 'succeeded',
      finishReason: batches.find((batch) => batch.finishReason !== null)?.finishReason ?? null,
      calls: batches.length,
      inputTokens: batches.every((batch) => batch.inputTokens === null)
        ? null
        : batches.reduce((sum, batch) => sum + (batch.inputTokens ?? 0), 0),
      outputTokens: batches.every((batch) => batch.outputTokens === null)
        ? null
        : batches.reduce((sum, batch) => sum + (batch.outputTokens ?? 0), 0),
      durationMs: batches.reduce((sum, batch) => sum + batch.durationMs, 0),
      failureCode: typeof issueCode === 'string' ? issueCode : null,
    })
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

  async function executeCatalog(
    document: ParsedDocument,
    definition: ExtractionSchemaDefinition,
    model: ExtractionModel,
    signal: AbortSignal,
    state: ExecutionState,
    retry: CatalogRetryContext | null,
  ): Promise<{ result: Record<string, unknown>; complete: boolean }> {
    const catalog = state.catalog
    if (!catalog) throw new ExtractionError('extraction_failed', 'Catalog diagnostics were not initialized.')
    const { documentNodes, recordNodes } = partitionSchemaNodes(definition.schemaNodes)
    const parentRecords = retry?.parent.result ? extractionRecords(retry.parent.result) : null
    // Parent result records carry no identity; they align positionally with the
    // parent's succeeded record diagnostics, which do carry the start block ID.
    const parentValuesByStartBlockId = new Map<string, Record<string, unknown>>()
    let parentValueIndex = 0
    for (const diagnostic of retry?.parentCatalog.records ?? []) {
      if (diagnostic.outcome !== 'succeeded') continue
      const parentValue = parentRecords?.[parentValueIndex++]
      if (parentValue)
        parentValuesByStartBlockId.set(diagnostic.boundary.startBlockId, parentValue)
    }
    const parentStage = (stage: CatalogStageDiagnostics['stage']) =>
      retry?.parentCatalog.stages.find((item) => item.stage === stage)
    const retryDocument = retry?.selection.retryDocument ?? true
    const rediscover = retry?.selection.rediscover ?? true
    let complete = true

    let documentValues: Record<string, unknown> = {}
    const previousDocumentStage = parentStage('document-values')
    if (retry && previousDocumentStage)
      setCatalogStage(catalog, 'document-values', reuseCall(previousDocumentStage))
    if (
      documentNodes.length > 0 &&
      retry &&
      !retryDocument &&
      retry.parentCatalog.documentValues
    ) {
      documentValues = { ...retry.parentCatalog.documentValues }
      catalog.documentValues = documentValues
    }
    if (documentNodes.length > 0 && retryDocument) {
      const documentStartedAt = now()
      const described = { records: [{ _description: definition.recordDescription, ...nodesToTemplate(documentNodes) }] }
      let documentMetadata: ModelGenerationMetadata | null = null
      try {
        const generated = await invoke(model, canonicalSource(document), document.page_count, stripDescriptions(described) as Record<string, unknown>, compileInstructions(described), signal, state)
        documentMetadata = generated.metadata
        const extracted = extractionRecords(generated.result)
        if (!extracted || extracted.length !== 1)
          throw new ExtractionError('invalid_model_output', 'Catalog document extraction must return one record.')
        documentValues = restoreSchemaNodeOrder(extracted[0], documentNodes)
        catalog.documentValues = documentValues
        setCatalogStage(catalog, 'document-values', callDiagnostic('succeeded', documentStartedAt, generated.metadata))
        if (generated.metadata.finishReason === 'length') complete = false
      } catch (error) {
        const code = extractionError(error).code
        const failureCode = signal.aborted || code === 'cancelled' ? 'cancelled' : code
        setCatalogStage(
          catalog,
          'document-values',
          callDiagnostic('failed', documentStartedAt, documentMetadata, failureCode),
        )
        if (failureCode === 'cancelled') throw error
        complete = false
      }
    }
    if (
      documentNodes.length > 0 &&
      !retryDocument &&
      previousDocumentStage &&
      (previousDocumentStage.outcome !== 'succeeded' ||
        previousDocumentStage.finishReason === 'length')
    )
      complete = false

    let boundaries: readonly CatalogBoundary[]
    const previousDiscoveryStage = parentStage('discovery')
    if (retry && previousDiscoveryStage)
      setCatalogStage(catalog, 'discovery', reuseCall(previousDiscoveryStage))
    if (rediscover) {
      const discoveryStartedAt = now()
      let discoveryMetadata: ModelGenerationMetadata | null = null
      try {
        const discoveryContext = catalogDiscoveryContext(document)
        const generated = await invoke(
          model,
          discoveryContext.text,
          document.page_count,
          { starts: ['string'] },
          'Identify every catalog record start. Canonical headings are marked as [[heading:H<number>]]. Return exactly {"starts":[string]} with each item equal to the short heading ID copied from a marked heading, in source order.',
          signal,
          state,
        )
        discoveryMetadata = generated.metadata
        const discovery = generated.result
        if (
          !isRecord(discovery) ||
          Object.keys(discovery).length !== 1 ||
          !Array.isArray(discovery.starts) ||
          !discovery.starts.every((headingId) => typeof headingId === 'string')
        )
          throw new ExtractionError('invalid_model_output', 'Catalog discovery must return exactly { starts: string[] }.')
        const startBlockIds = (discovery.starts as string[]).map(
          (headingId) => {
            const startBlockId =
              discoveryContext.startBlockIdByHeadingId.get(headingId)
            if (!startBlockId)
              throw new CatalogBoundaryResolutionError(
                'unknown_start',
                `Catalog discovery heading ID ${JSON.stringify(headingId)} is unknown.`,
              )
            return startBlockId
          },
        )
        boundaries = resolveCatalogBoundaries(document, startBlockIds)
        if (boundaries.length === 0)
          throw new ExtractionError(
            'catalog_no_records',
            'Catalog discovery returned no records.',
          )
        setCatalogStage(catalog, 'discovery', callDiagnostic('succeeded', discoveryStartedAt, generated.metadata))
        if (generated.metadata.finishReason === 'length') complete = false
      } catch (error) {
        const failureCode =
          error instanceof CatalogBoundaryResolutionError
            ? error.code
            : extractionError(error).code
        const diagnosticCode =
          signal.aborted || failureCode === 'cancelled' ? 'cancelled' : failureCode
        setCatalogStage(
          catalog,
          'discovery',
          callDiagnostic(
            'failed',
            discoveryStartedAt,
            discoveryMetadata,
            diagnosticCode,
          ),
        )
        if (diagnosticCode === 'cancelled' || failureCode === 'catalog_no_records')
          throw error
        throw new ExtractionError(
          'catalog_discovery_failed',
          error instanceof Error ? error.message : 'Catalog discovery failed.',
          { cause: error },
        )
      }
    } else {
      boundaries = retry!.parentCatalog.records.map((record) => record.boundary)
      if (previousDiscoveryStage?.finishReason === 'length') complete = false
    }

    const selected = new Set(retry?.selection.retryRecordStartBlockIds ?? [])
    const successfulRecords: Record<string, unknown>[] = []
    const recordsStartedAt = now()
    let executedRecordCount = 0
    for (const [ordinal, boundary] of boundaries.entries()) {
      signal.throwIfAborted()
      const previous = retry?.parentCatalog.records.find(
        (record) => record.boundary.startBlockId === boundary.startBlockId,
      )
      const shouldExecute = !retry || rediscover || selected.has(boundary.startBlockId)
      if (!shouldExecute && previous?.outcome === 'succeeded') {
        const reused = parentValuesByStartBlockId.get(boundary.startBlockId)
        if (reused) successfulRecords.push(reused)
        catalog.records.push(reuseCall(previous))
        if (previous.finishReason === 'length') complete = false
        continue
      }
      if (!shouldExecute) {
        if (previous) {
          catalog.records.push(reuseCall(previous))
          if (previous.outcome !== 'succeeded' || previous.finishReason === 'length')
            complete = false
        }
        continue
      }
      if (executedRecordCount >= CATALOG_RECORD_LIMIT) {
        complete = false
        catalog.records.push({
          ordinal,
          boundary,
          ...callDiagnostic('not_attempted', now(), null, CATALOG_NOT_ATTEMPTED_LIMIT),
        })
        continue
      }
      executedRecordCount += 1
      if (recordNodes.length === 0) {
        successfulRecords.push({})
        catalog.records.push({ ordinal, boundary, ...callDiagnostic('succeeded', now(), null, null, 0) })
        continue
      }
      const callStartedAt = now()
      let recordMetadata: ModelGenerationMetadata | null = null
      try {
        const described = { records: [{ _description: definition.recordDescription, ...nodesToTemplate(recordNodes) }] }
        const generated = await invoke(
          model,
          canonicalSourceSlice(document, boundary.startContentIndex, boundary.endContentIndex),
          document.page_count,
          stripDescriptions(described) as Record<string, unknown>,
          compileInstructions(described),
          signal,
          state,
        )
        recordMetadata = generated.metadata
        const extracted = extractionRecords(generated.result)
        if (!extracted || extracted.length !== 1)
          throw new ExtractionError('invalid_model_output', 'Catalog record extraction must return one record.')
        successfulRecords.push(restoreSchemaNodeOrder(extracted[0], recordNodes))
        catalog.records.push({ ordinal, boundary, ...callDiagnostic('succeeded', callStartedAt, generated.metadata) })
        if (generated.metadata.finishReason === 'length') complete = false
      } catch (error) {
        const code = extractionError(error).code
        const failureCode = signal.aborted || code === 'cancelled' ? 'cancelled' : code
        catalog.records.push({
          ordinal,
          boundary,
          ...callDiagnostic(
            'failed',
            callStartedAt,
            recordMetadata,
            failureCode,
          ),
        })
        if (failureCode === 'cancelled') throw error
        complete = false
      }
    }

    const attempted = catalog.records.filter(
      (record) => record.provenance === 'executed' && record.outcome !== 'not_attempted',
    )
    const previousRecordStage = parentStage('record-values')
    if (attempted.length === 0 && previousRecordStage)
      setCatalogStage(catalog, 'record-values', reuseCall(previousRecordStage))
    else
      setCatalogStage(catalog, 'record-values', {
        provenance: 'executed',
        outcome:
          attempted.length === 0
            ? 'not_attempted'
            : attempted.every((record) => record.outcome === 'succeeded')
              ? 'succeeded'
              : 'failed',
        finishReason:
          attempted.find((record) => record.finishReason !== null)?.finishReason ?? null,
        calls: attempted.reduce((sum, record) => sum + record.calls, 0),
        inputTokens: attempted.every((record) => record.inputTokens === null)
          ? null
          : attempted.reduce((sum, record) => sum + (record.inputTokens ?? 0), 0),
        outputTokens: attempted.every((record) => record.outputTokens === null)
          ? null
          : attempted.reduce((sum, record) => sum + (record.outputTokens ?? 0), 0),
        durationMs: Math.max(0, Math.round(now() - recordsStartedAt)),
        failureCode:
          attempted.find((record) => record.failureCode !== null)?.failureCode ?? null,
      })
    if (
      catalog.records.length !== boundaries.length ||
      catalog.records.some((record) => record.outcome !== 'succeeded')
    )
      complete = false
    if (successfulRecords.length === 0)
      throw new ExtractionError('catalog_no_records', 'Catalog produced no successful records.')

    const originalFilename = document.document.source.original_filename
    return {
      result: {
        records: successfulRecords.map((record) => {
          const restored: Record<string, unknown> = {}
          for (const node of definition.schemaNodes) {
            if (node.valueSource === 'source-filename') {
              if (originalFilename !== null) restored[node.name] = originalFilename
            } else if (node.valueSource === 'document') {
              if (Object.hasOwn(documentValues, node.name))
                restored[node.name] = documentValues[node.name]
            } else if (Object.hasOwn(record, node.name)) {
              restored[node.name] = record[node.name]
            }
          }
          return restored
        }),
      },
      complete,
    }
  }

  async function persistTerminal(resolved: ResolvedRun, inputs: LoadedExtractionInputs, state: ExecutionState, terminal: Pick<TerminalExtraction, 'outcome' | 'complete' | 'result' | 'evidence' | 'failure'>): Promise<RunSingleResult> {
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
      catalog: state.catalog,
      retry: state.retry,
    }
    const persisted = await dependencies.persistence.persistExtraction({
      extractionId: resolved.input.extractionId,
      sourceDocumentId: inputs.sourceDocumentId,
      sourceRepresentationRevisionId: inputs.sourceRepresentationRevisionId,
      schemaRevisionId: inputs.schemaRevisionId,
      strategy: resolved.strategy,
      ...terminal,
      modelAttribution: state.valuesAttribution,
      diagnostics,
      reviewable:
        terminal.outcome === 'SUCCEEDED' &&
        terminal.result !== null &&
        terminal.evidence !== null,
      retryOfId: resolved.retryOfId,
      batchExtractionId: resolved.batchExtractionId,
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

function reviewSchemaNode(
  nodes: readonly ExtractionSchemaNode[],
  resultPath: ResultPath,
): ExtractionSchemaNode | null {
  const path =
    resultPath[0] === 'records' && typeof resultPath[1] === 'number'
      ? resultPath.slice(2)
      : resultPath
  let candidates = nodes
  let current: ExtractionSchemaNode | null = null
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (current?.type !== 'array') return null
      continue
    }
    current = candidates.find((node) => node.name === segment) ?? null
    if (!current) return null
    candidates = current.children ?? []
  }
  return current
}

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


function sameExtractionIdentity(stored: ExtractionSnapshot, input: InternalRunSingleInput): boolean {
  if (input.kind === 'retry')
    return stored.extractionId === input.extractionId &&
      stored.retryOfId === input.retryOfId &&
      sameRetrySelection(stored.diagnostics.retry, input)
  return stored.extractionId === input.extractionId &&
    stored.retryOfId === null &&
    stored.sourceRepresentationRevisionId === input.sourceRepresentationRevisionId &&
    stored.schemaRevisionId === input.schemaRevisionId &&
    stored.strategy === input.strategy &&
    stored.batchExtractionId === (input.kind === 'batch-member' ? input.batchExtractionId : null)
}

function sameInput(left: InternalRunSingleInput, right: InternalRunSingleInput): boolean {
  if (left.kind !== right.kind || left.extractionId !== right.extractionId) return false
  if (left.kind === 'retry' && right.kind === 'retry')
    return left.retryOfId === right.retryOfId && sameRetrySelection(left, right)
  if (left.kind === 'batch-member' && right.kind === 'batch-member') return left.sourceRepresentationRevisionId === right.sourceRepresentationRevisionId && left.schemaRevisionId === right.schemaRevisionId && left.strategy === right.strategy && left.batchExtractionId === right.batchExtractionId
  return left.kind === 'fresh' && right.kind === 'fresh' && left.sourceRepresentationRevisionId === right.sourceRepresentationRevisionId && left.schemaRevisionId === right.schemaRevisionId && left.strategy === right.strategy
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null
}
