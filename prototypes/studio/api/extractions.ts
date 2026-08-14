/// <reference types="vite/client" />

import {
  canonicalPackageStore,
  type CanonicalPackageDescriptor,
} from '../../../packages/db/src/artifact-store.js'
import {
  createProjectStore,
  type ProjectStore,
  type StoredExtractionAttempt,
  type TerminalExtractionInput,
} from '../../../packages/db/src/project-store.js'
import {
  extractionRequestSchema,
  extractionAttemptSchema,
  extractionDiagnosticsSchema,
  extractionFailureSchema,
  extractionModelAttributionSchema,
  extractionRetrySelectionSchema,
  extractionReadResponseSchema,
  finalizeExtractionReviewSchema,
  sameExtractionIdentity,
  type ExtractionRequest,
  type ExtractionDiagnostics,
  type ExtractionFailure,
  type ExtractionModelAttribution,
  type ExtractionRetrySelection,
} from '../shared/extraction.contract.js'
import {
  canonicalSource,
  canonicalSourceSlice,
} from '../shared/anchoredDocument.js'
import {
  CatalogBoundaryResolutionError,
  resolveCatalogBoundaries,
  type CatalogBoundary,
} from '../shared/catalogBoundaries.js'
import {
  groundExtraction,
  populatedContentPaths,
} from '../shared/extractionGrounding.js'
import {
  cleanExtractionResultSchema,
  groundedExtractionPayloadSchema,
  resultPathKey,
} from '../shared/groundedExtraction.js'
import { decodeParsedDocument } from '../shared/parsedDocument.js'
import {
  nodesToTemplate,
  partitionSchemaNodes,
  parseSchemaDefinition,
  restoreSchemaNodeOrder,
  type SchemaNode,
} from '../shared/schemaNode.js'
import {
  compileInstructions,
  isRecord,
  stripDescriptions,
} from '../shared/template.js'
import { ApiError, json, noStore, noStoreError, parseJsonRequest } from './_http.js'
import {
  extractWithModel,
  modelGenerationMetadata,
  type ModelGenerationMetadata,
} from './_model.js'
import { readModelConfig } from './_model_config.js'
import {
  resolveCapabilityRoute,
  type ExecutionTarget,
} from './_provider.js'

const COLLECTION_ROUTE = '/api/extractions'
const ITEM_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)$/
const REVIEW_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)\/review$/
export const CATALOG_RECORD_LIMIT = 100

type ExtractionStore = Pick<
  ProjectStore,
  | 'finalizeExtractionReview'
  | 'getExtractionInputs'
  | 'getExtractionAttempt'
  | 'getSourceRepresentation'
  | 'persistExtractionAttempt'
>

type Dependencies = {
  store?: ExtractionStore
  readSource?: (descriptor: CanonicalPackageDescriptor) => Promise<unknown>
  resolveTarget?: () => Promise<ExecutionTarget>
  extract?: typeof extractWithModel
  now?: () => number
}

type ActiveOperation = {
  request: ExtractionRequest
  controller: AbortController
  lookup: Promise<StoredExtractionAttempt | null>
  persisting: boolean
  promise: Promise<OperationResult>
}

type OperationResult = {
  attempt: StoredExtractionAttempt
  created: boolean
}

function attemptDto(attempt: StoredExtractionAttempt) {
  return extractionAttemptSchema.parse({
    extractionId: attempt.extractionId,
    sourceDocumentId: attempt.sourceDocumentId,
    sourceRepresentationRevisionId:
      attempt.sourceRepresentationRevisionId,
    schemaRevisionId: attempt.schemaRevisionId,
    strategy: attempt.strategy,
    outcome: attempt.outcome,
    complete: attempt.complete,
    modelAttribution: attempt.modelAttribution,
    diagnostics: attempt.diagnostics,
    failure: attempt.failure,
    resultPayload: attempt.resultPayload,
    evidenceLinks: attempt.evidenceLinks,
    reviewable: attempt.reviewable,
    retryOfId: attempt.retryOfId,
    batchExtractionId: attempt.batchExtractionId,
    createdAt: attempt.createdAt.toISOString(),
    reviewedAt: attempt.reviewedAt?.toISOString() ?? null,
    reviewDecisions: attempt.reviewDecisions,
  })
}

async function defaultReadSource(descriptor: CanonicalPackageDescriptor) {
  const source = await canonicalPackageStore.read(descriptor, 'source')
  return JSON.parse(new TextDecoder().decode(source.bytes)) as unknown
}

function abortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === 'AbortError'
  )
}

function safeFailure(error: unknown): ExtractionFailure {
  return error instanceof ApiError
    ? { code: error.code, message: error.message.slice(0, 512) }
    : { code: 'extraction_failed', message: 'Extraction failed.' }
}

function extractionRecords(
  value: Record<string, unknown>,
): Record<string, unknown>[] | null {
  let records: unknown[]
  if (Object.hasOwn(value, 'records')) {
    if (Object.keys(value).length !== 1 || !Array.isArray(value.records))
      return null
    records = value.records
  } else records = [value]
  if (!records.every(isRecord)) return null
  return records
}

function recordMatchesSchema(
  value: unknown,
  nodes: readonly SchemaNode[],
): boolean {
  if (!isRecord(value)) return false
  const schema = new Map(nodes.map((node) => [node.name, node]))
  return Object.entries(value).every(([name, item]) => {
    const node = schema.get(name)
    if (!node || item === undefined) return false
    if (item === null) return true
    const children = node.children
    if (children)
      return node.type === 'array'
        ? Array.isArray(item) &&
            item.every((entry) => recordMatchesSchema(entry, children))
        : recordMatchesSchema(item, children)
    if (node.type === 'array')
      return (
        Array.isArray(item) &&
        item.every(
          (entry) =>
            entry === null || (!Array.isArray(entry) && !isRecord(entry)),
        )
      )
    return !Array.isArray(item) && !isRecord(item)
  })
}

function sameRetrySelection(
  attempt: Pick<StoredExtractionAttempt, 'diagnostics' | 'retryOfId'>,
  request: ExtractionRequest,
): boolean {
  if (request.retryOfId === null) return attempt.retryOfId === null
  const diagnostics = extractionDiagnosticsSchema.safeParse(attempt.diagnostics)
  const retry = diagnostics.success ? diagnostics.data.retry : null
  return (
    attempt.retryOfId === request.retryOfId &&
    retry?.retryOfId === request.retryOfId &&
    retry.retryDocument === request.retryDocument &&
    retry.rediscover === request.rediscover &&
    JSON.stringify([...retry.retryRecordStartBlockIds].sort()) ===
      JSON.stringify([...request.retryRecordStartBlockIds].sort())
  )
}

function resultMatchesSchema(
  result: Record<string, unknown>,
  nodes: readonly SchemaNode[],
): boolean {
  return (
    Object.keys(result).every((key) => key === 'records') &&
    Array.isArray(result.records) &&
    result.records.every((record) => recordMatchesSchema(record, nodes))
  )
}

function occurrenceOwnership(document: ReturnType<typeof decodeParsedDocument>) {
  return new Map(
    document.evidence_index.anchors.map((anchor) => [
      anchor.anchor_id,
      new Set(
        anchor.producer_observations.map(
          (observation) => observation.occurrence_id,
        ),
      ),
    ]),
  )
}

export function createExtractionsApi(dependencies: Dependencies = {}) {
  const store = dependencies.store ?? createProjectStore()
  const readSource = dependencies.readSource ?? defaultReadSource
  const resolveTarget =
    dependencies.resolveTarget ??
    (() =>
      resolveCapabilityRoute('extraction', {}, { readConfig: readModelConfig }))
  const extract = dependencies.extract ?? extractWithModel
  const now = dependencies.now ?? performance.now.bind(performance)
  const active = new Map<string, ActiveOperation>()

  async function persist(
    input: TerminalExtractionInput,
  ): Promise<OperationResult> {
    const payload =
      input.outcome === 'SUCCEEDED'
        ? groundedExtractionPayloadSchema.parse({
            result: input.resultPayload,
            evidenceLinks: input.evidenceLinks,
          })
        : null
    const persisted = await store.persistExtractionAttempt({
      ...input,
      diagnostics: extractionDiagnosticsSchema.parse(input.diagnostics),
      failure: extractionFailureSchema.nullable().parse(input.failure),
      modelAttribution: extractionModelAttributionSchema
        .nullable()
        .parse(input.modelAttribution),
      ...(payload
        ? { resultPayload: payload.result, evidenceLinks: payload.evidenceLinks }
        : {}),
    })
    if (persisted.status === 'invalid')
      throw new ApiError(
        409,
        'invalid_extraction_pins',
        'The pinned Extraction inputs are no longer valid.',
      )
    if (persisted.status === 'conflict')
      throw new ApiError(
        409,
        'extraction_id_conflict',
        'That Extraction ID is already bound to different inputs.',
      )
    return {
      attempt: persisted.attempt,
      created: persisted.status === 'created',
    }
  }

  type CatalogDiagnostics = NonNullable<ExtractionDiagnostics['catalog']>
  type CatalogStage = CatalogDiagnostics['stages'][number]

  const callDiagnostic = (
    outcome: CatalogStage['outcome'],
    startedAt: number,
    metadata: ModelGenerationMetadata | null,
    failureCode: string | null = null,
    calls = outcome === 'not_attempted' ? 0 : 1,
    provenance: CatalogStage['provenance'] = 'executed',
  ): Omit<CatalogStage, 'stage'> => ({
    provenance,
    outcome,
    finishReason: metadata?.finishReason ?? null,
    calls,
    inputTokens: metadata?.inputTokens ?? null,
    outputTokens: metadata?.outputTokens ?? null,
    durationMs:
      calls === 0
        ? 0
        : metadata?.durationMs ?? Math.max(0, Math.round(now() - startedAt)),
    failureCode,
  })

  async function runExtraction(
    request: ExtractionRequest,
    signal: AbortSignal,
    beginPersist: () => void,
  ): Promise<OperationResult> {
    const startedAt = now()
    const retryParent = request.retryOfId
      ? await store.getExtractionAttempt(request.retryOfId)
      : null
    if (request.retryOfId && !retryParent)
      throw new ApiError(404, 'not_found', 'The retry parent was not found.')
    const strategy = retryParent?.strategy ?? request.strategy
    if (!strategy)
      throw new ApiError(422, 'invalid_request', 'The Extraction strategy is required.')
    if (retryParent) {
      if (retryParent.strategy !== 'CATALOG')
        throw new ApiError(
          422,
          'invalid_retry',
          'Targeted retry is available only for Catalog attempts.',
        )
      if (
        (request.sourceRepresentationRevisionId !== undefined &&
          retryParent.sourceRepresentationRevisionId !==
            request.sourceRepresentationRevisionId) ||
        (request.schemaRevisionId !== undefined &&
          retryParent.schemaRevisionId !== request.schemaRevisionId) ||
        (request.strategy !== undefined && retryParent.strategy !== request.strategy)
      )
        throw new ApiError(
          409,
          'invalid_retry_pins',
          'A Catalog retry must use its immediate parent pins and strategy.',
        )
      if (
        retryParent.outcome === 'CANCELLED' ||
        (retryParent.outcome === 'FAILED' && !retryParent.diagnostics)
      )
        throw new ApiError(422, 'invalid_retry', 'The Catalog parent is not retryable.')
    }
    const inputs = await store.getExtractionInputs(
      retryParent?.sourceRepresentationRevisionId ??
        request.sourceRepresentationRevisionId!,
      retryParent?.schemaRevisionId ?? request.schemaRevisionId!,
    )
    if (!inputs)
      throw new ApiError(
        409,
        'invalid_extraction_pins',
        'The Source Representation and Schema Revision do not share one Project Context.',
      )

    let phase: ExtractionDiagnostics['phase'] = 'loading'
    let modelCalls = 0
    let finishReason: string | null = null
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let routeAttribution: ExtractionModelAttribution | null = null
    let executionTarget: ExecutionTarget | undefined
    let valuesDiagnostics: ExtractionDiagnostics['values'] = null
    let groundingDiagnostics: ExtractionDiagnostics['grounding'] = null
    const retrySelection: ExtractionRetrySelection | null = retryParent
      ? extractionRetrySelectionSchema.parse({
          retryOfId: retryParent.extractionId,
          retryDocument: request.retryDocument,
          rediscover: request.rediscover,
          retryRecordStartBlockIds: request.retryRecordStartBlockIds,
        })
      : null
    const catalogDiagnostics: CatalogDiagnostics | null =
      strategy === 'CATALOG'
        ? {
            stages: (['document-values', 'discovery', 'record-values', 'grounding'] as const).map(
              (stage) => ({
                stage,
                ...callDiagnostic('not_attempted', now(), null),
              }),
            ),
            records: [],
          }
        : null
    const parentCatalog = retryParent
      ? extractionDiagnosticsSchema.safeParse(retryParent.diagnostics).data?.catalog ?? null
      : null
    if (retryParent && !parentCatalog)
      throw new ApiError(422, 'invalid_retry', 'The Catalog parent has no valid diagnostics.')
    if (retryParent && parentCatalog) {
      const discovery = parentCatalog.stages.find((stage) => stage.stage === 'discovery')
      const documentValues = parentCatalog.stages.find(
        (stage) => stage.stage === 'document-values',
      )
      const selected = new Set(request.retryRecordStartBlockIds)
      if (!request.rediscover && discovery?.outcome !== 'succeeded')
        throw new ApiError(
          422,
          'invalid_retry_selection',
          'A failed Catalog discovery requires rediscover=true.',
        )
      if (
        request.retryDocument &&
        documentValues?.outcome !== 'failed'
      )
        throw new ApiError(
          422,
          'invalid_retry_selection',
          'retryDocument must target a failed document-values stage.',
        )
      const recordById = new Map(
        parentCatalog.records.map((record) => [record.boundary.startBlockId, record]),
      )
      for (const startBlockId of selected) {
        const record = recordById.get(startBlockId)
        if (!record || !['failed', 'not_attempted'].includes(record.outcome))
          throw new ApiError(
            422,
            'invalid_retry_selection',
            'Retry records must identify failed canonical parent records.',
          )
      }
      if (
        !request.rediscover &&
        !request.retryDocument &&
        selected.size === 0 &&
        (!retryParent.resultPayload || retryParent.outcome !== 'SUCCEEDED')
      )
        throw new ApiError(
          422,
          'invalid_retry_selection',
          'Grounding-only retry requires a succeeded parent result.',
        )
    }
    const callMetadata: (ModelGenerationMetadata | null)[] = []
    const invoke = async (
      input: Parameters<typeof extract>[0],
    ): Promise<Awaited<ReturnType<typeof extract>>> => {
      modelCalls++
      try {
        const generated = await extract(input, executionTarget)
        callMetadata.push(generated.metadata)
        return generated
      } catch (error) {
        callMetadata.push(modelGenerationMetadata(error))
        throw error
      }
    }
    const setCatalogStage = (
      stage: CatalogStage['stage'],
      diagnostics: Omit<CatalogStage, 'stage'>,
    ) => {
      if (!catalogDiagnostics) return
      const index = catalogDiagnostics.stages.findIndex((item) => item.stage === stage)
      catalogDiagnostics.stages[index] = { stage, ...diagnostics }
    }
    const executeCatalog = async (
      document: ReturnType<typeof decodeParsedDocument>,
      nodes: readonly SchemaNode[],
      recordDescription: string,
    ): Promise<Record<string, unknown>> => {
      const { documentNodes, recordNodes } = partitionSchemaNodes(nodes)
      const parentPayload = retryParent
        ? cleanExtractionResultSchema.safeParse(retryParent.resultPayload)
        : null
      const parentRecords = parentPayload?.success
        ? extractionRecords(parentPayload.data)
        : null
      const parentValuesByStartBlockId = new Map<
        string,
        Record<string, unknown>
      >()
      let parentValueIndex = 0
      for (const diagnostic of parentCatalog?.records ?? []) {
        if (diagnostic.outcome !== 'succeeded') continue
        const parentValue = parentRecords?.[parentValueIndex++]
        if (parentValue)
          parentValuesByStartBlockId.set(
            diagnostic.boundary.startBlockId,
            parentValue,
          )
      }
      if (
        retrySelection &&
        !retrySelection.rediscover &&
        !retrySelection.retryDocument &&
        retrySelection.retryRecordStartBlockIds.length === 0 &&
        !parentRecords
      )
        throw new ApiError(
          422,
          'invalid_retry_selection',
          'Grounding-only retry requires a stored parent result.',
        )

      const reuseCall = <
        T extends CatalogStage | CatalogDiagnostics['records'][number],
      >(
        value: T,
      ): T => ({
        ...value,
        provenance: 'reused',
        calls: 0,
        inputTokens: null,
        outputTokens: null,
        durationMs: 0,
        finishReason: value.finishReason,
      })
      const parentStage = (stage: CatalogStage['stage']) =>
        parentCatalog?.stages.find((item) => item.stage === stage)
      const retryDocument = retrySelection?.retryDocument ?? true
      const rediscover = retrySelection?.rediscover ?? true

      let documentValues: Record<string, unknown> = {}
      let documentComplete = true
      const previousDocumentStage = parentStage('document-values')
      if (retrySelection && previousDocumentStage)
        setCatalogStage('document-values', reuseCall(previousDocumentStage))
      if (documentNodes.length > 0) {
        const parentDocument = parentRecords?.[0]
        for (const node of documentNodes)
          if (parentDocument && Object.hasOwn(parentDocument, node.name))
            documentValues[node.name] = parentDocument[node.name]
      }
      if (documentNodes.length > 0 && retryDocument) {
        phase = 'extracting'
        const documentStartedAt = now()
        const describedTemplate = {
          records: [
            {
              _description: recordDescription,
              ...nodesToTemplate(documentNodes),
            },
          ],
        }
        let documentMetadata: ModelGenerationMetadata | null = null
        try {
          const generated = await invoke({
            document: {
              file: null,
              markdown: canonicalSource(document),
              pages: document.page_count,
            },
            template: stripDescriptions(describedTemplate),
            instruction: compileInstructions(describedTemplate) || undefined,
            signal,
          })
          documentMetadata = generated.metadata
          const extracted = extractionRecords(generated.result)
          if (!extracted || extracted.length !== 1)
            throw new ApiError(
              502,
              'invalid_model_output',
              'Document extraction must return one record.',
            )
          documentValues = restoreSchemaNodeOrder(extracted[0], documentNodes)
          setCatalogStage(
            'document-values',
            callDiagnostic('succeeded', documentStartedAt, generated.metadata),
          )
          if (generated.metadata.finishReason === 'length') strategyIncomplete = true
        } catch (error) {
          if (signal.aborted || abortError(error)) throw error
          documentComplete = false
          strategyIncomplete = true
          setCatalogStage(
            'document-values',
            callDiagnostic(
              'failed',
              documentStartedAt,
              modelGenerationMetadata(error) ?? documentMetadata,
              error instanceof ApiError ? error.code : 'extraction_failed',
            ),
          )
        }
      }
      if (
        documentNodes.length > 0 &&
        !retryDocument &&
        previousDocumentStage &&
        (previousDocumentStage.outcome !== 'succeeded' ||
          previousDocumentStage.finishReason === 'length')
      ) {
        documentComplete = false
        strategyIncomplete = true
      }

      let boundaries: CatalogBoundary[]
      const previousDiscoveryStage = parentStage('discovery')
      if (retrySelection && previousDiscoveryStage)
        setCatalogStage('discovery', reuseCall(previousDiscoveryStage))
      if (rediscover) {
        phase = 'extracting'
        const discoveryStartedAt = now()
        let discoveryMetadata: ModelGenerationMetadata | null = null
        try {
          const generated = await invoke({
            document: {
              file: null,
              markdown: canonicalSource(document),
              pages: document.page_count,
            },
            template: { starts: ['string'] },
            instruction:
              'Identify every catalog record start. Return exactly {"starts":[string]} with each item equal to an exact canonical heading label in source order.',
            signal,
          })
          discoveryMetadata = generated.metadata
          const discovery = generated.result
          if (
            !isRecord(discovery) ||
            Object.keys(discovery).length !== 1 ||
            !Array.isArray(discovery.starts) ||
            !discovery.starts.every((label) => typeof label === 'string')
          )
            throw new ApiError(
              502,
              'invalid_model_output',
              'Catalog discovery must return exactly { starts: string[] }.',
            )
          boundaries = resolveCatalogBoundaries(document, discovery.starts)
          setCatalogStage(
            'discovery',
            callDiagnostic('succeeded', discoveryStartedAt, generated.metadata),
          )
          if (generated.metadata.finishReason === 'length') strategyIncomplete = true
        } catch (error) {
          if (signal.aborted || abortError(error)) throw error
          const failureCode =
            error instanceof CatalogBoundaryResolutionError
              ? error.code
              : error instanceof ApiError
                ? error.code
                : 'extraction_failed'
          setCatalogStage(
            'discovery',
            callDiagnostic(
              'failed',
              discoveryStartedAt,
              modelGenerationMetadata(error) ?? discoveryMetadata,
              failureCode,
            ),
          )
          throw new ApiError(
            502,
            failureCode,
            error instanceof Error ? error.message : 'Catalog discovery failed.',
          )
        }
      } else {
        boundaries = parentCatalog!.records.map((record) => record.boundary)
      }
      if (
        !rediscover &&
        previousDiscoveryStage &&
        (previousDiscoveryStage.outcome !== 'succeeded' ||
          previousDiscoveryStage.finishReason === 'length')
      )
        strategyIncomplete = true
      if (boundaries.length === 0)
        throw new ApiError(422, 'catalog_no_records', 'Catalog discovery returned no records.')

      const selected = new Set(retrySelection?.retryRecordStartBlockIds ?? [])
      const successfulRecords: Array<{
        boundary: CatalogBoundary
        record: Record<string, unknown>
      }> = []
      const recordStartedAt = now()
      let executedRecordCount = 0
      for (const [ordinal, boundary] of boundaries.entries()) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const previous = parentCatalog?.records.find(
          (record) => record.boundary.startBlockId === boundary.startBlockId,
        )
        const shouldExecute =
          !retrySelection || rediscover || selected.has(boundary.startBlockId)
        if (!shouldExecute && previous?.outcome === 'succeeded') {
          const reused = parentValuesByStartBlockId.get(boundary.startBlockId)
          if (reused) successfulRecords.push({ boundary, record: reused })
          if (previous)
            catalogDiagnostics!.records.push(reuseCall(previous))
          if (previous?.finishReason === 'length') strategyIncomplete = true
          continue
        }
        if (!shouldExecute) {
          if (previous) {
            catalogDiagnostics!.records.push(reuseCall(previous))
            if (
              previous.outcome !== 'succeeded' ||
              previous.finishReason === 'length'
            )
              strategyIncomplete = true
          }
          continue
        }
        if (executedRecordCount >= CATALOG_RECORD_LIMIT) {
          strategyIncomplete = true
          catalogDiagnostics!.records.push({
            ordinal,
            boundary,
            ...callDiagnostic('not_attempted', now(), null, 'not_attempted_limit'),
          })
          continue
        }
        executedRecordCount += 1
        if (recordNodes.length === 0) {
          successfulRecords.push({ boundary, record: {} })
          catalogDiagnostics!.records.push({
            ordinal,
            boundary,
            ...callDiagnostic('succeeded', now(), null, null, 0),
          })
          continue
        }
        phase = 'extracting'
        const callStartedAt = now()
        let recordMetadata: ModelGenerationMetadata | null = null
        try {
          const describedTemplate = {
            records: [
              {
                _description: recordDescription,
                ...nodesToTemplate(recordNodes),
              },
            ],
          }
          const generated = await invoke({
            document: {
              file: null,
              markdown: canonicalSourceSlice(
                document,
                boundary.startContentIndex,
                boundary.endContentIndex,
              ),
              pages: document.page_count,
            },
            template: stripDescriptions(describedTemplate),
            instruction: compileInstructions(describedTemplate) || undefined,
            signal,
          })
          recordMetadata = generated.metadata
          const extracted = extractionRecords(generated.result)
          if (!extracted || extracted.length !== 1)
            throw new ApiError(
              502,
              'invalid_model_output',
              'Catalog record extraction must return one record.',
            )
          successfulRecords.push({
            boundary,
            record: restoreSchemaNodeOrder(extracted[0], recordNodes),
          })
          catalogDiagnostics!.records.push({
            ordinal,
            boundary,
            ...callDiagnostic('succeeded', callStartedAt, generated.metadata),
          })
          if (generated.metadata.finishReason === 'length') strategyIncomplete = true
        } catch (error) {
          if (signal.aborted || abortError(error)) {
            catalogDiagnostics!.records.push({
              ordinal,
              boundary,
              ...callDiagnostic(
                'failed',
                callStartedAt,
                modelGenerationMetadata(error) ?? recordMetadata,
                'cancelled',
              ),
            })
            throw error
          }
          strategyIncomplete = true
          catalogDiagnostics!.records.push({
            ordinal,
            boundary,
            ...callDiagnostic(
              'failed',
              callStartedAt,
              modelGenerationMetadata(error) ?? recordMetadata,
              error instanceof ApiError ? error.code : 'extraction_failed',
            ),
          })
        }
      }
      const attempted = catalogDiagnostics!.records.filter(
        (record) => record.provenance === 'executed' && record.outcome !== 'not_attempted',
      )
      const previousRecordStage = parentStage('record-values')
      if (attempted.length === 0 && previousRecordStage)
        setCatalogStage('record-values', reuseCall(previousRecordStage))
      else
        setCatalogStage('record-values', {
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
          durationMs: Math.max(0, Math.round(now() - recordStartedAt)),
          failureCode:
            attempted.find((record) => record.failureCode !== null)?.failureCode ?? null,
        })
      if (
        catalogDiagnostics!.records.length !== boundaries.length ||
        catalogDiagnostics!.records.some((record) => record.outcome !== 'succeeded')
      )
        strategyIncomplete = true
      if (successfulRecords.length === 0)
        throw new ApiError(422, 'catalog_no_records', 'Catalog produced no successful records.')
      if (!documentComplete) strategyIncomplete = true
      return {
        records: successfulRecords.map(({ record }) => {
          const restored: Record<string, unknown> = {}
          for (const node of nodes) {
            if (node.valueSource === 'source-filename') {
              if (document.document.source.original_filename !== null)
                restored[node.name] = document.document.source.original_filename
            } else if (node.valueSource === 'document') {
              if (Object.hasOwn(documentValues, node.name))
                restored[node.name] = documentValues[node.name]
            } else if (Object.hasOwn(record, node.name)) {
              restored[node.name] = record[node.name]
            }
          }
          return restored
        }),
      }
    }
    let strategyIncomplete = false
    let terminal: Omit<
      TerminalExtractionInput,
      | 'extractionId'
      | 'sourceDocumentId'
      | 'sourceRepresentationRevisionId'
      | 'schemaRevisionId'
      | 'strategy'
      | 'diagnostics'
      | 'retryOfId'
      | 'batchExtractionId'
    >
    try {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const document = decodeParsedDocument(await readSource(inputs.descriptor))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const { recordDescription, schemaNodes: nodes } =
        parseSchemaDefinition(inputs.schemaTree)
      const { packageNodes } = partitionSchemaNodes(nodes)
      const modelNodes = nodes.filter((node) => node.valueSource !== 'source-filename')
      const packageFields = new Set(packageNodes.map((node) => node.name))
      const target = await resolveTarget()
      if (!target.attribution)
        throw new ApiError(
          503,
          'model_route_unavailable',
          'The Extraction Route has no durable attribution.',
        )
      routeAttribution = target.attribution
      executionTarget = target
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      let result: Record<string, unknown>
      if (strategy === 'ARTICLE') {
        let records: Record<string, unknown>[] = [{}]
        if (nodes.length === 0 || modelNodes.length > 0) {
          phase = 'extracting'
          const describedTemplate = {
            records: [
              {
                _description: recordDescription,
                ...nodesToTemplate(modelNodes),
              },
            ],
          }
          const valuesStartedAt = now()
          let generated: Awaited<ReturnType<typeof extract>>
          try {
            generated = await invoke({
              document: {
                file: null,
                markdown: canonicalSource(document),
                pages: document.page_count,
              },
              template: stripDescriptions(describedTemplate),
              instruction: compileInstructions(describedTemplate) || undefined,
              signal,
            })
            valuesDiagnostics = {
              outcome: 'succeeded',
              ...generated.metadata,
            }
          } catch (error) {
            const metadata = modelGenerationMetadata(error)
            valuesDiagnostics = {
              outcome: 'failed',
              finishReason: metadata?.finishReason ?? null,
              inputTokens: metadata?.inputTokens ?? null,
              outputTokens: metadata?.outputTokens ?? null,
              durationMs:
                metadata?.durationMs ??
                Math.max(0, Math.round(now() - valuesStartedAt)),
            }
            finishReason = valuesDiagnostics.finishReason
            inputTokens = valuesDiagnostics.inputTokens
            outputTokens = valuesDiagnostics.outputTokens
            throw error
          }
          finishReason = generated.metadata.finishReason
          inputTokens = generated.metadata.inputTokens
          outputTokens = generated.metadata.outputTokens
          const extracted = extractionRecords(generated.result)
          if (!extracted)
            throw new ApiError(
              502,
              'invalid_model_output',
              'Article extraction records must be objects.',
            )
          records = extracted
        }
        result = {
          records: records.map((record) => {
            const modelRecord = restoreSchemaNodeOrder(record, modelNodes)
            const restored: Record<string, unknown> = {}
            for (const node of nodes) {
              if (
                node.valueSource === 'source-filename' &&
                document.document.source.original_filename !== null
              )
                restored[node.name] = document.document.source.original_filename
              else if (
                node.valueSource !== 'source-filename' &&
                Object.hasOwn(modelRecord, node.name)
              )
                restored[node.name] = modelRecord[node.name]
            }
            return restored
          }),
        }
      } else {
        result = await executeCatalog(document, nodes, recordDescription)
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

      phase = 'grounding'
      const groundingMetadata: (ModelGenerationMetadata | null)[] = []
      const groundingOutcomes: ('succeeded' | 'failed')[] = []
      const grounded = await groundExtraction({
        document,
        result,
        excludedRootFields: packageFields,
        signal,
        invokeModel: async ({ documentMarkdown, template, instruction, signal }) => {
          const metadataIndex = groundingMetadata.push(null) - 1
          modelCalls++
          let generated: Awaited<ReturnType<typeof extract>>
          try {
            generated = await extract(
              {
                document: {
                  file: null,
                  markdown: documentMarkdown,
                  pages: document.page_count,
                },
                template,
                instruction,
                signal,
              },
              target,
            )
            callMetadata.push(generated.metadata)
            groundingMetadata[metadataIndex] = generated.metadata
            groundingOutcomes[metadataIndex] = 'succeeded'
          } catch (error) {
            groundingMetadata[metadataIndex] = modelGenerationMetadata(error)
            callMetadata.push(groundingMetadata[metadataIndex])
            groundingOutcomes[metadataIndex] = 'failed'
            throw error
          }
          return {
            result: generated.result,
            modelAttribution: generated.modelAttribution,
          }
        },
      })
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      inputTokens =
        inputTokens === null && groundingMetadata.every((item) => item?.inputTokens == null)
          ? null
          : (inputTokens ?? 0) +
            groundingMetadata.reduce((sum, item) => sum + (item?.inputTokens ?? 0), 0)
      outputTokens =
        outputTokens === null && groundingMetadata.every((item) => item?.outputTokens == null)
          ? null
          : (outputTokens ?? 0) +
            groundingMetadata.reduce((sum, item) => sum + (item?.outputTokens ?? 0), 0)
      const groundedPathKeys = new Set(
        grounded.evidenceLinks.map((link) => resultPathKey(link.resultPath)),
      )
      groundingDiagnostics = {
        groundedPaths: populatedContentPaths(result, packageFields).filter((path) =>
          groundedPathKeys.has(resultPathKey(path)),
        ),
        ungroundedPaths: [...grounded.ungroundedPaths],
        issueCodes: grounded.issues.map((issue) => issue.code),
        batches:
          grounded.modelAttribution?.batches.map((batch, index) => ({
            resultPath: batch.resultPath,
            candidateCount: batch.candidateCount,
            fallback: batch.fallback,
            outcome: groundingOutcomes[index] ?? 'failed',
            finishReason: groundingMetadata[index]?.finishReason ?? null,
            inputTokens: groundingMetadata[index]?.inputTokens ?? null,
            outputTokens: groundingMetadata[index]?.outputTokens ?? null,
            durationMs: groundingMetadata[index]?.durationMs ?? 0,
          })) ?? [],
      }
      if (catalogDiagnostics) {
        const groundingFailure = grounded.issues[0]?.code ?? null
        setCatalogStage('grounding', {
          outcome:
            groundingOutcomes.some((outcome) => outcome === 'failed') || groundingFailure
              ? 'failed'
              : 'succeeded',
          finishReason:
            groundingMetadata.find((item) => item?.finishReason !== null)?.finishReason ?? null,
          calls: groundingMetadata.length,
          inputTokens: groundingMetadata.every((item) => item?.inputTokens == null)
            ? null
            : groundingMetadata.reduce((sum, item) => sum + (item?.inputTokens ?? 0), 0),
          outputTokens: groundingMetadata.every((item) => item?.outputTokens == null)
            ? null
            : groundingMetadata.reduce((sum, item) => sum + (item?.outputTokens ?? 0), 0),
          durationMs: groundingMetadata.reduce((sum, item) => sum + (item?.durationMs ?? 0), 0),
          failureCode: groundingFailure,
        })
      }
      if (strategy === 'CATALOG') {
        const all = callMetadata
        finishReason =
          catalogDiagnostics?.stages.find((stage) => stage.finishReason !== null)?.finishReason ?? null
        inputTokens = all.every((item) => item?.inputTokens == null)
          ? null
          : all.reduce((sum, item) => sum + (item?.inputTokens ?? 0), 0)
        outputTokens = all.every((item) => item?.outputTokens == null)
          ? null
          : all.reduce((sum, item) => sum + (item?.outputTokens ?? 0), 0)
      }
      terminal = {
        outcome: 'SUCCEEDED',
        complete:
          finishReason !== 'length' &&
          groundingMetadata.every((item) => item?.finishReason !== 'length') &&
          !strategyIncomplete &&
          grounded.ungroundedPaths.length === 0 &&
          grounded.issues.length === 0,
        modelAttribution: routeAttribution,
        failure: null,
        resultPayload: result,
        evidenceLinks: [...grounded.evidenceLinks],
        // An empty result has no decision-bearing Evidence. It is a successful
        // terminal attempt, but never a reviewable one.
        reviewable:
          grounded.evidenceLinks.length > 0 && grounded.ungroundedPaths.length === 0,
      }
    } catch (error) {
      terminal = abortError(error) || signal.aborted
        ? {
            outcome: 'CANCELLED',
            complete: null,
            modelAttribution: routeAttribution,
            failure: null,
            resultPayload: null,
            evidenceLinks: null,
            reviewable: false,
          }
        : {
            outcome: 'FAILED',
            complete: null,
            modelAttribution: routeAttribution,
            failure: safeFailure(error),
            resultPayload: null,
            evidenceLinks: null,
            reviewable: false,
          }
    }

    // No await may separate this boundary from the terminal write.
    beginPersist()
    return persist({
      extractionId: request.id,
      sourceDocumentId: inputs.sourceDocumentId,
      sourceRepresentationRevisionId: inputs.sourceRepresentationRevisionId,
      schemaRevisionId: inputs.schemaRevisionId,
      strategy,
      retryOfId: retryParent?.extractionId ?? null,
      // A retry stays in the Batch Extraction its parent belongs to.
      batchExtractionId:
        retryParent?.batchExtractionId ??
        ('batchExtractionId' in request ? request.batchExtractionId : null) ??
        null,
      ...terminal,
      diagnostics: {
        phase,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        modelCalls,
        finishReason,
        inputTokens,
        outputTokens,
        values: valuesDiagnostics,
        grounding: groundingDiagnostics,
        catalog: catalogDiagnostics,
        retry: retrySelection,
      },
    })
  }

  async function create(request: Request): Promise<Response> {
    const parsed = extractionRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(422, 'invalid_request', 'The Extraction request is invalid.')
    const identity = parsed.data
    const existing = active.get(identity.id)
    if (existing) {
      if (
        !sameExtractionIdentity(existing.request, identity) ||
        existing.request.retryDocument !== identity.retryDocument ||
        existing.request.rediscover !== identity.rediscover ||
        JSON.stringify([...existing.request.retryRecordStartBlockIds].sort()) !==
          JSON.stringify([...identity.retryRecordStartBlockIds].sort())
      )
        throw new ApiError(
          409,
          'extraction_id_conflict',
          'That Extraction ID is already bound to different inputs.',
        )
      return json(attemptDto((await existing.promise).attempt), {
        headers: noStore,
      })
    }

    const lookup = store.getExtractionAttempt(identity.id)
    const operation: ActiveOperation = {
      request: identity,
      controller: new AbortController(),
      lookup,
      persisting: false,
      promise: Promise.resolve(null as never),
    }
    operation.promise = lookup
      .then(async (stored) => {
        if (stored) {
          if (
            !sameExtractionIdentity(stored, identity) ||
            !sameRetrySelection(stored, identity)
          )
            throw new ApiError(
              409,
              'extraction_id_conflict',
              'That Extraction ID is already bound to different inputs.',
            )
          return { attempt: stored, created: false }
        }
        return runExtraction(identity, operation.controller.signal, () => {
          operation.persisting = true
        })
      })
      .finally(() => {
        if (active.get(identity.id) === operation) active.delete(identity.id)
      })
    active.set(identity.id, operation)
    const completed = await operation.promise
    return json(attemptDto(completed.attempt), {
      status: completed.created ? 201 : 200,
      headers: noStore,
    })
  }

  /**
   * Reads one stored Extraction. Reviewing it needs the occurrences its cited
   * Evidence Anchors own, which only the pinned Source Representation knows, so
   * they are derived here instead of making every reader load the parsed
   * document. `/review` still validates whatever the researcher submits.
   */
  async function read(extractionId: string) {
    const attempt = await store.getExtractionAttempt(extractionId)
    if (!attempt)
      throw new ApiError(404, 'not_found', 'That Extraction was not found.')
    const cited = [
      ...new Set(
        (Array.isArray(attempt.evidenceLinks) ? attempt.evidenceLinks : [])
          .map((link) =>
            isRecord(link) && typeof link.evidenceAnchorId === 'string'
              ? link.evidenceAnchorId
              : null,
          )
          .filter((anchorId): anchorId is string => anchorId !== null),
      ),
    ]
    let pendingReviewDecisions: {
      evidenceAnchorId: string
      reviewedOccurrenceIds: string[]
    }[] = []
    if (attempt.outcome === 'SUCCEEDED' && attempt.reviewable && cited.length) {
      const descriptor = await store.getSourceRepresentation(
        attempt.sourceRepresentationRevisionId,
      )
      if (!descriptor)
        throw new ApiError(
          503,
          'source_artifact_unavailable',
          'The pinned Source Representation is unavailable.',
        )
      const owned = occurrenceOwnership(
        decodeParsedDocument(await readSource(descriptor)),
      )
      pendingReviewDecisions = cited.flatMap((evidenceAnchorId) => {
        const occurrences = owned.get(evidenceAnchorId)
        return occurrences
          ? [{ evidenceAnchorId, reviewedOccurrenceIds: [...occurrences] }]
          : []
      })
    }
    return json(
      extractionReadResponseSchema.parse({
        extraction: attemptDto(attempt),
        pendingReviewDecisions,
      }),
      { headers: noStore },
    )
  }

  async function review(request: Request, extractionId: string) {
    const parsed = finalizeExtractionReviewSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(422, 'invalid_request', 'The Extraction review is invalid.')
    const attempt = await store.getExtractionAttempt(extractionId)
    if (!attempt)
      throw new ApiError(404, 'not_found', 'That Extraction was not found.')
    const descriptor = await store.getSourceRepresentation(
      attempt.sourceRepresentationRevisionId,
    )
    if (!descriptor)
      throw new ApiError(503, 'source_artifact_unavailable', 'The pinned Source Representation is unavailable.')
    const document = decodeParsedDocument(await readSource(descriptor))
    const resultPayload = cleanExtractionResultSchema.safeParse(
      attempt.resultPayload,
    )
    let schemaNodes: SchemaNode[]
    try {
      schemaNodes = parseSchemaDefinition(attempt.schemaTree).schemaNodes
    } catch {
      throw new ApiError(422, 'invalid_review', 'The Extraction has no valid pinned Schema Revision.')
    }
    const { packageNodes } = partitionSchemaNodes(schemaNodes)
    const packageFields = new Set(packageNodes.map((node) => node.name))
    if (
      !resultPayload.success ||
      !resultMatchesSchema(resultPayload.data, schemaNodes) ||
      !Array.isArray(attempt.evidenceLinks)
    )
      throw new ApiError(422, 'invalid_review', 'The Extraction has no reviewable result.')
    const finalized = await store.finalizeExtractionReview(extractionId, {
      reviewDecisions: parsed.data.reviewDecisions,
      occurrenceIdsByAnchor: occurrenceOwnership(document),
      requiredResultPathKeys: new Set(
        populatedContentPaths(resultPayload.data, packageFields).map(resultPathKey),
      ),
    })
    if (finalized.status === 'not-found')
      throw new ApiError(404, 'not_found', 'That Extraction was not found.')
    if (finalized.status === 'conflict')
      throw new ApiError(409, 'review_conflict', 'That Extraction was reviewed differently.')
    if (finalized.status === 'invalid')
      throw new ApiError(422, 'invalid_review', 'The Extraction review does not match its stored Evidence.')
    if (!('attempt' in finalized))
      throw new ApiError(500, 'unexpected_failure', 'The reviewed Extraction could not be read.')
    return json(attemptDto(finalized.attempt), { headers: noStore })
  }

  return async function extractionsApi(request: Request): Promise<Response> {
    try {
      const pathname = new URL(request.url).pathname
      if (request.method === 'POST' && pathname === COLLECTION_ROUTE)
        return await create(request)
      const reviewMatch = REVIEW_ROUTE.exec(pathname)
      if (request.method === 'POST' && reviewMatch)
        return await review(request, reviewMatch[1])
      const itemMatch = ITEM_ROUTE.exec(pathname)
      if (request.method === 'GET' && itemMatch)
        return await read(itemMatch[1])
      if (request.method === 'DELETE' && itemMatch) {
        const operation = active.get(itemMatch[1])
        if (!operation || operation.persisting)
          throw new ApiError(404, 'not_found', 'That Extraction is not active.')
        operation.controller.abort()
        if (await operation.lookup)
          throw new ApiError(404, 'not_found', 'That Extraction is not active.')
        return json({ extractionId: itemMatch[1] }, { status: 202, headers: noStore })
      }
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(error)
    }
  }
}

const handle = createExtractionsApi()
export const GET = handle
export const POST = handle
export const DELETE = handle
