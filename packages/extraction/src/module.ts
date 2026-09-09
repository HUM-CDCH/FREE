import { discoverCatalogChunk } from './catalog-discovery.js'
import type {
  ExtractionJobInput,
  ExtractionJobExecutor,
  ExtractionJobExecutorDependencies,
  ExtractionModel,
  ExtractionModelResponse,
  ExtractionModelRequest,
  ExtractionPersistence,
  TerminalExtraction,
  ExtractionValueCheckpoint,
} from './dependencies.js'
import {
  CatalogBoundaryResolutionError,
  catalogStartText,
  resolveCatalogBoundaries,
  type CatalogBoundary,
} from './catalog-boundaries.js'
import {
  CATALOG_NOT_ATTEMPTED_LIMIT,
  CATALOG_RECORD_LIMIT,
  DEFAULT_CATALOG_POLICY,
  reuseCall,
  seedCatalogDiagnostics,
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
  schemaNodeAtPath,
  stripDescriptions,
} from './schema.js'
import type { ExtractionSchemaDefinition } from './schema.js'
import {
  canonicalSource,
  canonicalSourceSlice,
  catalogDiscoveryChunks,
} from './source-context.js'
import type {
  CatalogStageDiagnostics,
  ExtractionDiagnostics,
  ExtractionModule,
  ExtractionRetrySelection,
  ExtractionStrategy,
  CancellationResult,
  FinalizeReviewResult,
  ExtractionSchemaNode,
  ModelAttribution,
  ModelGenerationMetadata,
  ReviewDecisionInput,
  ResultPath,
  RunSingleInput,
} from './types.js'

const DEFAULT_LIMIT = 50


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
  checkpointDiagnostics: ExtractionDiagnostics | null
}

/** One run's durable identity after retry inputs are resolved against their parent. */
type ResolvedRun = Readonly<{
  input: ExtractionJobInput
  sourceRepresentationRevisionId: string
  schemaRevisionId: string
  strategy: ExtractionStrategy
  retryOfId: string | null
  batchExtractionId: string | null
  retry: CatalogRetryContext | null
}>

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

/** The worker's side of an Extraction: run one claimed job to its terminal state. */
export function createExtractionJobExecutor({
  inputs: reader,
  models,
  now = performance.now.bind(performance),
  policy = DEFAULT_CATALOG_POLICY,
}: ExtractionJobExecutorDependencies): ExtractionJobExecutor {
  return executeJob

  async function resolveRun(input: ExtractionJobInput): Promise<ResolvedRun> {
    if (input.kind === 'retry') {
      const parent = await reader.readExtractionAttempt(input.retryOfId)
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

  async function executeJob(
    input: ExtractionJobInput,
    checkpoint: ExtractionValueCheckpoint | null,
    saveCheckpoint: (checkpoint: ExtractionValueCheckpoint) => Promise<void>,
    signal: AbortSignal,
  ): Promise<TerminalExtraction> {
    const resolved = await resolveRun(input)
    const inputs = await reader.loadExtractionInputs(
      resolved.sourceRepresentationRevisionId,
      resolved.schemaRevisionId,
    )
    if (!inputs) throw new ExtractionError('invalid_extraction_pins', 'The Source Representation Revision and Schema Revision do not share one Project Context.')
    const state: ExecutionState = {
      phase: checkpoint ? 'grounding' : 'loading', startedAt: now(), modelCalls: 0, metadata: [],
      valuesAttribution: checkpoint?.modelAttribution ?? null,
      ungroundedPaths: [], groundingIssues: [], groundingBatches: [],
      catalog: checkpoint?.diagnostics.catalog
        ? structuredClone(checkpoint.diagnostics.catalog) as MutableCatalogDiagnostics
        : resolved.strategy === 'CATALOG' ? seedCatalogDiagnostics() : null,
      retry: checkpoint?.diagnostics.retry ?? resolved.retry?.selection ?? null,
      checkpointDiagnostics: checkpoint?.diagnostics ?? null,
    }
    const session = await models.open()
    const document = decodeCanonical(inputs.parsedDocument)
    const definition = parsePinnedSchema(inputs.schemaTree)
    let result: Readonly<Record<string, unknown>>
    let complete: boolean
    if (checkpoint) {
      result = checkpoint.result
      complete = checkpoint.complete
    } else {
      state.valuesAttribution = session.attribution
      const generated = resolved.strategy === 'CATALOG'
        ? await executeCatalog(
            document,
            definition,
            session.model,
            signal,
            state,
            resolved.retry,
          )
        : await executeArticle(
            document,
            definition,
            session.model,
            signal,
            state,
          )
      result = generated.result
      complete = generated.complete
      state.phase = 'grounding'
      const valueCheckpoint: ExtractionValueCheckpoint = {
        complete,
        modelAttribution: session.attribution,
        diagnostics: diagnostics(state, 'grounding'),
        result,
      }
      await saveCheckpoint(valueCheckpoint)
      state.checkpointDiagnostics = valueCheckpoint.diagnostics
      state.startedAt = now()
      state.modelCalls = 0
      state.metadata = []
    }
    signal.throwIfAborted()
    const { packageNodes, documentNodes } = partitionSchemaNodes(definition.schemaNodes)
    const packageFields = new Set(packageNodes.map((node) => node.name))
    const grounding = await groundExtraction(document, result, session.groundingModel, signal, {
      excludedRootFields: packageFields,
      // Document-scoped values still need access to the whole source.
      recordBoundaries: documentNodes.length === 0
        ? state.catalog?.records.filter(record => record.outcome === 'succeeded').map(record => record.boundary)
        : undefined,
      now,
      // The policy governs Catalog runs only; Article keeps one call per record.
      ...(resolved.strategy === 'CATALOG' && { policy, schemaNodes: definition.schemaNodes }),
    })
    state.ungroundedPaths = grounding.ungroundedPaths
    state.groundingIssues = grounding.issues
    state.groundingBatches = grounding.batches
    state.metadata.push(...grounding.metadata)
    if (state.catalog) setGroundingStage(state.catalog, grounding.batches, grounding.issues)
    if (grounding.ungroundedPaths.length > 0 || grounding.issues.length > 0)
      complete = false
    return {
      extractionId: resolved.input.extractionId,
      sourceDocumentId: inputs.sourceDocumentId,
      sourceRepresentationRevisionId: inputs.sourceRepresentationRevisionId,
      schemaRevisionId: inputs.schemaRevisionId,
      strategy: resolved.strategy,
      outcome: 'SUCCEEDED',
      complete,
      modelAttribution: state.valuesAttribution,
      diagnostics: diagnostics(state, 'grounding'),
      result,
      evidence: grounding.evidence,
      failure: null,
      reviewable: true,
      retryOfId: resolved.retryOfId,
      batchExtractionId: resolved.batchExtractionId,
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

  async function invoke(model: ExtractionModel, document: string, pages: number, template: Record<string, unknown>, instruction: string, signal: AbortSignal, state: ExecutionState, outputSchema?: ExtractionModelRequest['outputSchema']): Promise<ExtractionModelResponse> {
    signal.throwIfAborted()
    state.phase = 'extracting'
    state.modelCalls += 1
    const generated = await model.extract({ document: { markdown: document, pages }, template, ...(outputSchema && { outputSchema }), ...(instruction && { instruction }), signal })
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
          restoreSchemaNodeOrder(
            { ...record, ...packageValues },
            definition.schemaNodes,
            { ignoreUnknownKeys: true },
          ),
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
      const described = { record: { _description: definition.recordDescription, ...nodesToTemplate(documentNodes) } }
      let documentMetadata: ModelGenerationMetadata | null = null
      try {
        const generated = await invoke(model, canonicalSource(document), document.page_count, stripDescriptions(described) as Record<string, unknown>, compileInstructions(described), signal, state)
        documentMetadata = generated.metadata
        const extracted = extractionRecord(generated.result)
        if (!extracted)
          throw new ExtractionError('invalid_model_output', 'Catalog document extraction must return one record.')
        documentValues = restoreSchemaNodeOrder(extracted, documentNodes, {
          ignoreUnknownKeys: true,
        })
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
      let discoveryMetadata: ModelGenerationMetadata = {
        finishReason: null, inputTokens: null, outputTokens: null, durationMs: null,
      }
      let discoveryCalls = 0
      try {
        let startBlockIds: readonly string[] = []
        let terminalEndBlockId: string | undefined
        for (const [chunkIndex, discoveryContext] of catalogDiscoveryChunks(document).entries()) {
          if (discoveryContext.startBlockIdByLabel.size === 0) continue
          const previousEnd = document.content_stream.find(block => block.block_id === terminalEndBlockId)
          const previousStart = document.content_stream.find(block => block.block_id === startBlockIds.at(-1))
          const previousRecord = previousStart ? catalogStartText(previousStart)?.slice(0, 800) : null
          const selection = await discoverCatalogChunk(
            document, discoveryContext, { startBlockIds, terminalEndBlockId }, chunkIndex + 1,
            async (outputSchema, correction) => {
              discoveryCalls += 1
              const generated = await invoke(
                model,
                (previousEnd ? `Previous catalog section ended before this block (context only, not selectable):\n## Page ${previousEnd.page_number}\n${catalogStartText(previousEnd)?.slice(0, 800)}\n\n` : '')
                  + (previousRecord ? `Previous catalog record start (context only, never select again):\n${previousRecord}\n\n` : '') + discoveryContext.text,
                document.page_count,
                { starts: ['string'], end: 'string' },
                `Identify every catalog record start matching this record definition: ${definition.recordDescription}\nThis is one consecutive excerpt of the source. Canonical text blocks are marked as [[block:B<number>]]. Entries can start in headings, paragraphs or numbered lists. Select only NEW parent records with the identifier required by the record definition. A continued sentence, description, sub-item or reference must never become a new parent record. The previous record continues until a new parent record begins. Check every selectable block; include short entries and separate entries describing the same entity or locality. Return {"starts":[string],"end":string|null}. Copy the short IDs of matching starts in source order, only from selectable blocks. Return an empty starts array when none match. Also identify the first block AFTER the last matching record as end (for example the start of a later index or bibliography), or null if that record continues beyond this excerpt. A continued record may end here even when this excerpt has no new start. Previous context is only for understanding continuations; its blocks cannot be selected. Select the opening block even when the record continues into the following excerpt. Following context is not selectable. Respect all page and section restrictions in the record definition: return no starts for an excerpt outside that scope. If a previous catalogue section ended, only select a new section when it also matches the definition.` + '\nReturn bare block IDs (for example "B60"), not entry titles or [[block:B60]] wrappers.\nSelectable block IDs: ' + [...discoveryContext.startBlockIdByLabel.keys()].join(', ') + correction,
                signal,
                state,
                outputSchema,
              )
              discoveryMetadata = {
                finishReason: discoveryMetadata?.finishReason === 'length' ? 'length' : generated.metadata.finishReason,
                inputTokens: sumNullable([discoveryMetadata?.inputTokens ?? null, generated.metadata.inputTokens]),
                outputTokens: sumNullable([discoveryMetadata?.outputTokens ?? null, generated.metadata.outputTokens]),
                durationMs: sumNullable([discoveryMetadata?.durationMs ?? null, generated.metadata.durationMs]),
              }
              signal.throwIfAborted()
              return generated.result
            },
          )
          startBlockIds = selection.startBlockIds
          terminalEndBlockId = selection.terminalEndBlockId
        }
        boundaries = resolveCatalogBoundaries(document, startBlockIds, terminalEndBlockId)
        if (boundaries.length === 0)
          throw new ExtractionError(
            'catalog_no_records',
            'Catalog discovery returned no records.',
          )
        setCatalogStage(catalog, 'discovery', callDiagnostic('succeeded', discoveryStartedAt, discoveryMetadata, null, discoveryCalls))
        if (discoveryMetadata?.finishReason === 'length') complete = false
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
            discoveryCalls,
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
    const executeRecord = async (ordinal: number, boundary: CatalogBoundary) => {
      const callStartedAt = now()
      let recordMetadata: ModelGenerationMetadata | null = null
      try {
        const described = { record: { _description: definition.recordDescription, ...nodesToTemplate(recordNodes) } }
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
        const extracted = extractionRecord(generated.result)
        if (!extracted)
          throw new ExtractionError('invalid_model_output', 'Catalog record extraction must return one record.')
        successfulRecords.push(
          restoreSchemaNodeOrder(extracted, recordNodes, {
            ignoreUnknownKeys: true,
          }),
        )
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
    /** One values call for several records, each slice under a routing
     *  heading the model copies back. False when the response does not
     *  return every identity once, in order: the caller re-runs the
     *  records one per call. */
    const executeRecordBatch = async (batch: readonly { ordinal: number; boundary: CatalogBoundary }[]): Promise<boolean> => {
      const callStartedAt = now()
      const identities = batch.map((_, index) => `R${index + 1}`)
      const described = { records: [{ _description: definition.recordDescription, record_id: 'string', ...nodesToTemplate(recordNodes) }] }
      const markdown = batch
        .map(({ boundary }, index) => `### Record ${identities[index]}\n${canonicalSourceSlice(document, boundary.startContentIndex, boundary.endContentIndex)}`)
        .join('\n\n')
      const instruction = [
        compileInstructions(described),
        `Return exactly one record per "### Record" heading, in the same order, and copy that heading's identifier (${identities.join(', ')}) into record_id.`,
      ].filter(Boolean).join('\n')
      try {
        const generated = await invoke(model, markdown, document.page_count, stripDescriptions(described) as Record<string, unknown>, instruction, signal, state)
        const records = extractionRecords(generated.result)
        if (
          !records ||
          records.length !== batch.length ||
          records.some((record, index) => record.record_id !== identities[index]) ||
          generated.metadata.finishReason === 'length'
        )
          throw new ExtractionError('invalid_model_output', 'Catalog batch extraction must return one identified record per source record.')
        records.forEach((record, index) => {
          successfulRecords.push(restoreSchemaNodeOrder(record, recordNodes, { ignoreUnknownKeys: true }))
          // The batch's one call is charged to its first record.
          catalog.records.push({
            ...batch[index],
            ...callDiagnostic('succeeded', callStartedAt, index === 0 ? generated.metadata : null, null, index === 0 ? 1 : 0),
          })
        })
        return true
      } catch (error) {
        if (signal.aborted || extractionError(error).code === 'cancelled') throw error
        // ponytail: the failed batch call is counted in modelCalls only; its
        // records are re-run one per call and carry their own diagnostics.
        return false
      }
    }
    const pending: { ordinal: number; boundary: CatalogBoundary }[] = []
    const flush = async () => {
      const batch = pending.splice(0)
      if (batch.length > 1 && await executeRecordBatch(batch)) return
      for (const { ordinal, boundary } of batch) await executeRecord(ordinal, boundary)
    }
    for (const [ordinal, boundary] of boundaries.entries()) {
      signal.throwIfAborted()
      const previous = retry?.parentCatalog.records.find(
        (record) => record.boundary.startBlockId === boundary.startBlockId,
      )
      const shouldExecute = !retry || rediscover || selected.has(boundary.startBlockId)
      // Record order is result order: nothing is pushed while a batch waits.
      if (!(shouldExecute && executedRecordCount < CATALOG_RECORD_LIMIT && recordNodes.length > 0)) await flush()
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
      pending.push({ ordinal, boundary })
      if (pending.length >= policy.recordBatchSize) await flush()
    }
    await flush()

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

  function diagnostics(
    state: ExecutionState,
    phase: ExtractionDiagnostics['phase'],
  ): ExtractionDiagnostics {
    const metadata = state.metadata
    const checkpoint = state.checkpointDiagnostics
    const finishReason = metadata.some((entry) => entry.finishReason === 'length')
      ? 'length'
      : metadata.at(-1)?.finishReason ?? checkpoint?.finishReason ?? null
    return {
      phase,
      durationMs:
        (checkpoint?.durationMs ?? 0) +
        Math.max(0, Math.round(now() - state.startedAt)),
      modelCalls: (checkpoint?.modelCalls ?? 0) + state.modelCalls,
      finishReason,
      inputTokens: sumNullable([
        checkpoint?.inputTokens ?? null,
        sumNullable(metadata.map((entry) => entry.inputTokens)),
      ]),
      outputTokens: sumNullable([
        checkpoint?.outputTokens ?? null,
        sumNullable(metadata.map((entry) => entry.outputTokens)),
      ]),
      ungroundedPaths: state.ungroundedPaths,
      groundingIssues: state.groundingIssues,
      groundingBatches: state.groundingBatches,
      catalog: state.catalog,
      retry: state.retry,
    }
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

function extractionRecord(result: Readonly<Record<string, unknown>>): Record<string, unknown> | null {
  return Object.keys(result).length === 1 && isRecord(result.record) ? result.record : null
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


function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length ? present.reduce((sum, value) => sum + value, 0) : null
}
