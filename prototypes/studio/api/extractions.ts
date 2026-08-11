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
  finalizeExtractionReviewSchema,
  sameExtractionIdentity,
  type ExtractionRequest,
  type ExtractionDiagnostics,
  type ExtractionFailure,
  type ExtractionModelAttribution,
} from '../shared/extraction.contract.js'
import {
  canonicalAnchorInventory,
  canonicalSource,
} from '../shared/anchoredDocument.js'
import {
  groundExtraction,
  populatedContentPaths,
  type EvidenceLink,
  type GroundingIssue,
  type GroundingModelInvoker,
  type GroundingStageAttribution,
  type ResultPath,
} from '../shared/extractionGrounding.js'
import {
  cleanExtractionResultSchema,
  groundedExtractionPayloadSchema,
  resultPathKey,
} from '../shared/groundedExtraction.js'
import { decodeParsedDocument } from '../shared/parsedDocument.js'
import {
  nodesToTemplate,
  parseSchemaDefinition,
} from '../shared/schemaNode.js'
import {
  compileInstructions,
  isRecord,
  stripDescriptions,
} from '../shared/template.js'
import { ApiError, json, noStore, noStoreError, parseJsonRequest } from './_http.js'
import {
  catalogSliceSource,
  headingCandidateSource,
  headingCandidates,
  parseDiscoveryStarts,
  resolveCatalogBoundaries,
  type CatalogDiagnosticCode,
} from './_catalog.js'
import {
  extractWithModel,
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
  const records = Array.isArray(value.records) ? value.records : [value]
  return records.every(isRecord) ? records : null
}

function overlayFilename(
  result: Record<string, unknown>,
  fields: ReadonlySet<string>,
  filename: string | null,
) {
  if (!Array.isArray(result.records)) return
  for (const record of result.records) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    for (const field of fields)
      (record as Record<string, unknown>)[field] = filename ?? ''
  }
}

function occurrenceOwnership(document: ReturnType<typeof decodeParsedDocument>) {
  return new Map(
    document.evidence_index.anchors.map((anchor) => [
      anchor.anchor_id,
      new Set(
        anchor.kind === 'text'
          ? [anchor.occurrence_id]
          : anchor.producer_observations.map(
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

  async function runArticle(
    request: ExtractionRequest,
    signal: AbortSignal,
    beginPersist: () => void,
  ): Promise<OperationResult> {
    const startedAt = now()
    const inputs = await store.getExtractionInputs(
      request.sourceRepresentationRevisionId,
      request.schemaRevisionId,
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
    let groundingDiagnostics: ExtractionDiagnostics['grounding'] = null
    let terminal: Omit<
      TerminalExtractionInput,
      | 'extractionId'
      | 'sourceDocumentId'
      | 'sourceRepresentationRevisionId'
      | 'schemaRevisionId'
      | 'strategy'
      | 'diagnostics'
      | 'retryOfId'
    >
    try {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const document = decodeParsedDocument(await readSource(inputs.descriptor))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const { recordDescription, schemaNodes: nodes } =
        parseSchemaDefinition(inputs.schemaTree)
      const packageFields = new Set(
        nodes
          .filter((node) => node.valueSource === 'source-filename')
          .map((node) => node.name),
      )
      const modelNodes = nodes.filter(
        (node) => node.valueSource !== 'source-filename',
      )
      let result: Record<string, unknown>
      const target = await resolveTarget()
      if (!target.attribution)
        throw new ApiError(
          503,
          'model_route_unavailable',
          'The Extraction Route has no durable attribution.',
        )
      routeAttribution = target.attribution
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (modelNodes.length === 0) {
        result = { records: [{}] }
      } else {
        phase = 'extracting'
        const describedTemplate = {
          records: [
            {
              _description: recordDescription,
              ...nodesToTemplate(modelNodes),
            },
          ],
        }
        modelCalls++
        const generated = await extract(
          {
            document: { file: null, markdown: canonicalSource(document), pages: document.page_count },
            template: stripDescriptions(describedTemplate),
            instruction: compileInstructions(describedTemplate) || undefined,
            signal,
          },
          target,
        )
        finishReason = generated.metadata.finishReason
        inputTokens = generated.metadata.inputTokens
        outputTokens = generated.metadata.outputTokens
        const records = extractionRecords(generated.result)
        if (!records)
          throw new ApiError(
            502,
            'invalid_model_output',
            'Article extraction records must be objects.',
          )
        result = { records }
      }
      overlayFilename(
        result,
        packageFields,
        document.document.source.original_filename ?? inputs.originalFilename,
      )
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

      phase = 'grounding'
      const groundingMetadata: (ModelGenerationMetadata | null)[] = []
      const grounded = await groundExtraction({
        document,
        result,
        excludedRootFields: packageFields,
        signal,
        invokeModel: async ({ documentMarkdown, template, instruction, signal }) => {
          const metadataIndex = groundingMetadata.push(null) - 1
          modelCalls++
          const generated = await extract(
            {
              document: { file: null, markdown: documentMarkdown, pages: document.page_count },
              template,
              instruction,
              signal,
            },
            target,
          )
          groundingMetadata[metadataIndex] = generated.metadata
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
        groundedPaths: populatedContentPaths(result, packageFields).filter(
          (path) => groundedPathKeys.has(resultPathKey(path)),
        ),
        ungroundedPaths: [...grounded.ungroundedPaths],
        issueCodes: grounded.issues.map((issue) => issue.code),
        batches:
          grounded.modelAttribution?.batches.map((batch, index) => ({
            resultPath: batch.resultPath,
            candidateCount: batch.candidateCount,
            fallback: batch.fallback,
            finishReason: groundingMetadata[index]?.finishReason ?? null,
            inputTokens: groundingMetadata[index]?.inputTokens ?? null,
            outputTokens: groundingMetadata[index]?.outputTokens ?? null,
            durationMs: groundingMetadata[index]?.durationMs ?? 0,
          })) ?? [],
      }
      terminal = {
        outcome: 'SUCCEEDED',
        complete:
          finishReason !== 'length' &&
          groundingMetadata.every((item) => item?.finishReason !== 'length') &&
          grounded.ungroundedPaths.length === 0 &&
          grounded.issues.length === 0,
        modelAttribution: routeAttribution,
        failure: null,
        resultPayload: result,
        evidenceLinks: [...grounded.evidenceLinks],
        reviewable: grounded.ungroundedPaths.length === 0,
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
      sourceRepresentationRevisionId:
        request.sourceRepresentationRevisionId,
      schemaRevisionId: request.schemaRevisionId,
      strategy: request.strategy,
      retryOfId: null,
      ...terminal,
      diagnostics: {
        phase,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        modelCalls,
        finishReason,
        inputTokens,
        outputTokens,
        grounding: groundingDiagnostics,
        catalog: null,
      },
    })
  }

  async function runCatalog(
    request: ExtractionRequest,
    signal: AbortSignal,
    beginPersist: () => void,
  ): Promise<OperationResult> {
    const startedAt = now()
    const inputs = await store.getExtractionInputs(
      request.sourceRepresentationRevisionId,
      request.schemaRevisionId,
    )
    if (!inputs)
      throw new ApiError(
        409,
        'invalid_extraction_pins',
        'The Source Representation and Schema Revision do not share one Project Context.',
      )

    let phase: ExtractionDiagnostics['phase'] = 'loading'
    let modelCalls = 0
    let inputTokens: number | null = null
    let outputTokens: number | null = null
    let routeAttribution: ExtractionModelAttribution | null = null
    let groundingDiagnostics: ExtractionDiagnostics['grounding'] = null
    const catalog: NonNullable<ExtractionDiagnostics['catalog']> = {
      codes: [],
      documentMetadata: null,
      discovery: {
        outcome: 'failed',
        finishReason: null,
        inputTokens: null,
        outputTokens: null,
        durationMs: 0,
        candidateCount: 0,
        returnedCount: 0,
        resolvedCount: 0,
      },
      boundaries: [],
      boundaryIssues: [],
      records: [],
    }
    let terminal: Omit<
      TerminalExtractionInput,
      | 'extractionId'
      | 'sourceDocumentId'
      | 'sourceRepresentationRevisionId'
      | 'schemaRevisionId'
      | 'strategy'
      | 'diagnostics'
      | 'retryOfId'
    >

    const addCode = (code: CatalogDiagnosticCode) => {
      if (!catalog.codes.includes(code)) catalog.codes.push(code)
    }
    const addUsage = (metadata: ModelGenerationMetadata) => {
      inputTokens =
        inputTokens === null && metadata.inputTokens === null
          ? null
          : (inputTokens ?? 0) + (metadata.inputTokens ?? 0)
      outputTokens =
        outputTokens === null && metadata.outputTokens === null
          ? null
          : (outputTokens ?? 0) + (metadata.outputTokens ?? 0)
    }
    const callDiagnostics = (
      metadata: ModelGenerationMetadata,
      outcome: 'succeeded' | 'failed' = 'succeeded',
    ) => ({
      outcome,
      finishReason: metadata.finishReason,
      inputTokens: metadata.inputTokens,
      outputTokens: metadata.outputTokens,
      durationMs: metadata.durationMs,
    })

    try {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const document = decodeParsedDocument(await readSource(inputs.descriptor))
      const definition = parseSchemaDefinition(inputs.schemaTree)
      const packageNodes = definition.schemaNodes.filter(
        (node) => node.valueSource === 'source-filename',
      )
      const documentNodes = definition.schemaNodes.filter(
        (node) => node.valueSource === 'document',
      )
      const recordNodes = definition.schemaNodes.filter(
        (node) => node.valueSource === undefined,
      )
      const packageFields = new Set(packageNodes.map((node) => node.name))
      const target = await resolveTarget()
      if (!target.attribution)
        throw new ApiError(
          503,
          'model_route_unavailable',
          'The Extraction Route has no durable attribution.',
        )
      routeAttribution = target.attribution
      const source = canonicalSource(document)
      const inventory = canonicalAnchorInventory(document)
      const documentValues: Record<string, unknown> = {}
      let metadataComplete = true

      if (documentNodes.length > 0) {
        phase = 'document_metadata'
        const before = now()
        try {
          modelCalls++
          const described = nodesToTemplate(documentNodes)
          const generated = await extract(
            {
              document: {
                file: null,
                markdown: source,
                pages: document.page_count,
              },
              template: stripDescriptions(described),
              instruction:
                [
                  'Extract document-scoped values once. These values will be copied to every discovered record.',
                  compileInstructions(described),
                ]
                  .filter(Boolean)
                  .join('\n'),
              signal,
            },
            target,
          )
          addUsage(generated.metadata)
          const documentFieldNames = new Set(
            documentNodes.map((node) => node.name),
          )
          for (const node of documentNodes)
            if (Object.hasOwn(generated.result, node.name))
              documentValues[node.name] = generated.result[node.name]
          if (
            Object.keys(generated.result).some(
              (key) => !documentFieldNames.has(key),
            )
          ) {
            metadataComplete = false
            addCode('document_metadata_inconsistent')
          }
          catalog.documentMetadata = callDiagnostics(generated.metadata)
          if (generated.metadata.finishReason === 'length') {
            metadataComplete = false
            addCode('document_metadata_incomplete')
          }
        } catch (error) {
          if (abortError(error) || signal.aborted) throw error
          metadataComplete = false
          addCode('document_metadata_incomplete')
          catalog.documentMetadata = {
            outcome: 'failed',
            finishReason: null,
            inputTokens: null,
            outputTokens: null,
            durationMs: Math.max(0, Math.round(now() - before)),
          }
        }
      }

      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      phase = 'discovering'
      const candidates = headingCandidates(document)
      catalog.discovery.candidateCount = candidates.length
      if (candidates.length === 0)
        throw new ApiError(
          422,
          'catalog_ineligible',
          'Catalog requires canonical heading candidates.',
        )
      const discoveryBefore = now()
      let starts: string[] | null = null
      try {
        modelCalls++
        const generated = await extract(
          {
            document: {
              file: null,
              markdown: headingCandidateSource(candidates),
              pages: document.page_count,
            },
            template: { starts: ['string'] },
            instruction: [
              `One record is: ${definition.recordDescription}`,
              'Select every heading that starts one such record.',
              'Return only the compact starts array in canonical source order.',
              'Copy only the supplied opaque H-* labels. Do not return headings, ends, records, explanations, or unknown labels.',
            ].join('\n'),
            signal,
          },
          target,
        )
        addUsage(generated.metadata)
        starts = parseDiscoveryStarts(generated.result)
        catalog.discovery = {
          ...callDiagnostics(
            generated.metadata,
            starts === null ? 'failed' : 'succeeded',
          ),
          candidateCount: candidates.length,
          returnedCount: starts?.length ?? 0,
          resolvedCount: 0,
        }
        if (starts === null || generated.metadata.finishReason === 'length')
          addCode('discovery_invalid_output')
      } catch (error) {
        if (abortError(error) || signal.aborted) throw error
        addCode('discovery_invalid_output')
        catalog.discovery = {
          outcome: 'failed',
          finishReason: null,
          inputTokens: null,
          outputTokens: null,
          durationMs: Math.max(0, Math.round(now() - discoveryBefore)),
          candidateCount: candidates.length,
          returnedCount: 0,
          resolvedCount: 0,
        }
      }

      const resolution = resolveCatalogBoundaries(
        document,
        starts ?? [],
        candidates,
      )
      catalog.discovery.resolvedCount =
        resolution.boundaries.length + resolution.notAttempted.length
      catalog.boundaryIssues = resolution.issues
      catalog.boundaries = resolution.boundaries.map((boundary) => ({
        ordinal: boundary.ordinal,
        startLabel: boundary.startLabel,
        startAnchorId: boundary.startAnchorId,
        headingText: boundary.headingText,
        headingLevel: boundary.headingLevel,
        endAnchorId: boundary.endAnchorId,
      }))
      for (const issue of resolution.issues) addCode(issue.code)
      if (resolution.notAttempted.length > 0) addCode('not_attempted_limit')

      phase = 'extracting'
      const records: Record<string, unknown>[] = []
      const recordBoundaries: (typeof resolution.boundaries)[number][] = []
      let recordsComplete = true
      for (const boundary of resolution.boundaries) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
        const before = now()
        try {
          let extractedRecords: Record<string, unknown>[] = [{}]
          let metadata: ModelGenerationMetadata = {
            finishReason: null,
            inputTokens: null,
            outputTokens: null,
            durationMs: 0,
          }
          if (recordNodes.length > 0) {
            modelCalls++
            const described = {
              _description: definition.recordDescription,
              ...nodesToTemplate(recordNodes),
            }
            const generated = await extract(
              {
                document: {
                  file: null,
                  markdown: catalogSliceSource(document, boundary),
                  pages: document.page_count,
                },
                template: stripDescriptions(described),
                instruction: [
                  `Extract the record described here: ${definition.recordDescription}`,
                  compileInstructions(described),
                ]
                  .filter(Boolean)
                  .join('\n'),
                signal,
              },
              target,
            )
            metadata = generated.metadata
            addUsage(metadata)
            const recordFieldNames = new Set(
              recordNodes.map((node) => node.name),
            )
            const returnedRecords = extractionRecords(generated.result)
            extractedRecords =
              returnedRecords?.map((returnedRecord) =>
                Object.fromEntries(
                  Object.entries(returnedRecord).filter(([key]) =>
                    recordFieldNames.has(key),
                  ),
                ),
              ) ?? []
            if (
              extractedRecords.length === 0 ||
              extractedRecords.some((record) => Object.keys(record).length === 0)
            )
              throw new ApiError(
                502,
                'invalid_model_output',
                'Catalog record extraction returned no schema fields.',
              )
          }
          for (const record of extractedRecords) {
            Object.assign(record, documentValues)
            const wrapped = { records: [record] }
            overlayFilename(
              wrapped,
              packageFields,
              document.document.source.original_filename ??
                inputs.originalFilename,
            )
            records.push((wrapped.records as Record<string, unknown>[])[0])
            recordBoundaries.push(boundary)
          }
          catalog.records.push({
            ...callDiagnostics(metadata),
            ordinal: boundary.ordinal,
            startAnchorId: boundary.startAnchorId,
            headingText: boundary.headingText,
            outcome: 'succeeded',
            code: null,
          })
          if (metadata.finishReason === 'length') recordsComplete = false
        } catch (error) {
          if (abortError(error) || signal.aborted) throw error
          recordsComplete = false
          addCode('record_extraction_failed')
          catalog.records.push({
            outcome: 'failed',
            finishReason: null,
            inputTokens: null,
            outputTokens: null,
            durationMs: Math.max(0, Math.round(now() - before)),
            ordinal: boundary.ordinal,
            startAnchorId: boundary.startAnchorId,
            headingText: boundary.headingText,
            code: 'record_extraction_failed',
          })
        }
      }
      for (const boundary of resolution.notAttempted) {
        recordsComplete = false
        catalog.records.push({
          outcome: 'not_attempted',
          finishReason: null,
          inputTokens: null,
          outputTokens: null,
          durationMs: 0,
          ordinal: boundary.ordinal,
          startAnchorId: boundary.startAnchorId,
          headingText: boundary.headingText,
          code: 'not_attempted_limit',
        })
      }

      const result = { records }
      phase = 'grounding'
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const groundingMetadata: (ModelGenerationMetadata | null)[] = []
      const evidenceLinks: EvidenceLink[] = []
      const ungroundedPaths: ResultPath[] = []
      const groundingIssueCodes: GroundingIssue['code'][] = []
      const groundingBatches: GroundingStageAttribution['batches'][number][] = []
      const invokeGrounding: GroundingModelInvoker = async ({
        documentMarkdown,
        template,
        instruction,
        signal,
      }) => {
        const metadataIndex = groundingMetadata.push(null) - 1
        modelCalls++
        const generated = await extract(
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
        groundingMetadata[metadataIndex] = generated.metadata
        addUsage(generated.metadata)
        return {
          result: generated.result,
          modelAttribution: generated.modelAttribution,
        }
      }
      if (records.length > 0 && Object.keys(documentValues).length > 0) {
        const grounded = await groundExtraction({
          document,
          result: documentValues,
          excludedRootFields: packageFields,
          signal,
          invokeModel: invokeGrounding,
        })
        for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
          evidenceLinks.push(
            ...grounded.evidenceLinks.map((link) => ({
              ...link,
              resultPath: ['records', recordIndex, ...link.resultPath],
            })),
          )
          ungroundedPaths.push(
            ...grounded.ungroundedPaths.map((path) => [
              'records',
              recordIndex,
              ...path,
            ]),
          )
        }
        groundingIssueCodes.push(...grounded.issues.map((issue) => issue.code))
        groundingBatches.push(...(grounded.modelAttribution?.batches ?? []))
      }
      const recordExcludedFields = new Set([
        ...packageFields,
        ...documentNodes.map((node) => node.name),
      ])
      for (const [recordIndex, record] of records.entries()) {
        const boundary = recordBoundaries[recordIndex]
        const grounded = await groundExtraction({
          document,
          result: record,
          excludedRootFields: recordExcludedFields,
          allowedAnchorIds: new Set(
            inventory
              .slice(boundary.startIndex, boundary.endIndex)
              .map((entry) => entry.anchorId),
          ),
          signal,
          invokeModel: invokeGrounding,
        })
        evidenceLinks.push(
          ...grounded.evidenceLinks.map((link) => ({
            ...link,
            resultPath: ['records', recordIndex, ...link.resultPath],
          })),
        )
        ungroundedPaths.push(
          ...grounded.ungroundedPaths.map((path) => [
            'records',
            recordIndex,
            ...path,
          ]),
        )
        groundingIssueCodes.push(...grounded.issues.map((issue) => issue.code))
        groundingBatches.push(
          ...(grounded.modelAttribution?.batches.map((batch) => ({
            ...batch,
            resultPath: ['records', recordIndex],
          })) ?? []),
        )
      }
      const groundedPathKeys = new Set(
        evidenceLinks.map((link) => resultPathKey(link.resultPath)),
      )
      groundingDiagnostics = {
        groundedPaths: populatedContentPaths(result, packageFields).filter(
          (path) => groundedPathKeys.has(resultPathKey(path)),
        ),
        ungroundedPaths,
        issueCodes: groundingIssueCodes,
        batches: groundingBatches.map((batch, index) => ({
          resultPath: batch.resultPath,
          candidateCount: batch.candidateCount,
          fallback: batch.fallback,
          finishReason: groundingMetadata[index]?.finishReason ?? null,
          inputTokens: groundingMetadata[index]?.inputTokens ?? null,
          outputTokens: groundingMetadata[index]?.outputTokens ?? null,
          durationMs: groundingMetadata[index]?.durationMs ?? 0,
        })),
      }
      const groundingComplete =
        ungroundedPaths.length === 0 &&
        groundingIssueCodes.length === 0 &&
        groundingMetadata.every((item) => item?.finishReason !== 'length')
      if (!groundingComplete) addCode('grounding_incomplete')
      terminal = {
        outcome: 'SUCCEEDED',
        complete:
          starts !== null &&
          catalog.discovery.finishReason !== 'length' &&
          resolution.issues.length === 0 &&
          resolution.notAttempted.length === 0 &&
          metadataComplete &&
          recordsComplete &&
          groundingComplete,
        modelAttribution: routeAttribution,
        failure: null,
        resultPayload: result,
        evidenceLinks,
        reviewable: ungroundedPaths.length === 0,
      }
    } catch (error) {
      terminal =
        abortError(error) || signal.aborted
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

    beginPersist()
    return persist({
      extractionId: request.id,
      sourceDocumentId: inputs.sourceDocumentId,
      sourceRepresentationRevisionId:
        request.sourceRepresentationRevisionId,
      schemaRevisionId: request.schemaRevisionId,
      strategy: request.strategy,
      retryOfId: null,
      ...terminal,
      diagnostics: {
        phase,
        durationMs: Math.max(0, Math.round(now() - startedAt)),
        modelCalls,
        finishReason: null,
        inputTokens,
        outputTokens,
        grounding: groundingDiagnostics,
        catalog,
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
      if (!sameExtractionIdentity(existing.request, identity))
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
          if (!sameExtractionIdentity(stored, identity))
            throw new ApiError(
              409,
              'extraction_id_conflict',
              'That Extraction ID is already bound to different inputs.',
            )
          return { attempt: stored, created: false }
        }
        const run = identity.strategy === 'CATALOG' ? runCatalog : runArticle
        return run(identity, operation.controller.signal, () => {
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
    if (!resultPayload.success || !Array.isArray(attempt.evidenceLinks))
      throw new ApiError(422, 'invalid_review', 'The Extraction has no reviewable result.')
    const packageFields = new Set(
      parseSchemaDefinition(attempt.schemaTree).schemaNodes
        .filter((node) => node.valueSource === 'source-filename')
        .map((node) => node.name),
    )
    const finalized = await store.finalizeExtractionReview(extractionId, {
      reviewDecisions: parsed.data.reviewDecisions,
      occurrenceIdsByAnchor: occurrenceOwnership(document),
      requiredResultPathKeys: new Set(
        populatedContentPaths(resultPayload.data, packageFields).map(
          resultPathKey,
        ),
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
export const POST = handle
export const DELETE = handle
