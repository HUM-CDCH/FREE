import type { ResearcherProjectStore } from 'db'
import {
  ExtractionError,
  type BatchExtractionResults,
  type BatchExtractionSnapshot,
  type ScheduleBatchResult,
} from 'extraction'
import {
  batchExtractionListResponseSchema,
  batchExtractionOpenResponseSchema,
  batchExtractionRequestSchema,
  batchExtractionResponseSchema,
  batchExtractionResultsResponseSchema,
} from '../shared/batchExtraction.contract.js'
import { canonicalUuidSchema } from '../shared/projectContext.contract.js'
import {
  ApiError,
  boundedLimit,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import { createResearcherExtractions } from './_extraction_runtime.js'
import type { ExtractionHandlerDependencies } from './extractions.js'
import { configuredExtractionModels } from './_model_config.js'

const COLLECTION_ROUTE = '/api/batch-extractions'
const ITEM_ROUTE = /^\/api\/batch-extractions\/([0-9a-f-]+)$/
const RESULTS_ROUTE = /^\/api\/batch-extractions\/([0-9a-f-]+)\/results$/

function batchDto(batch: BatchExtractionSnapshot) {
  return {
    batchExtractionId: batch.batchExtractionId,
    projectContextId: batch.projectContextId,
    schemaRevisionId: batch.schemaRevisionId,
    extractionSchemaId: batch.extractionSchemaId,
    extractionSchemaName: batch.extractionSchemaName,
    schemaRevisionNumber: batch.schemaRevisionNumber,
    strategy: batch.strategy,
    executionStatus: batch.executionStatus,
    executionFailureMessage: batch.failureMessage,
    startedAt: batch.startedAt?.toISOString() ?? null,
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    createdAt: batch.createdAt.toISOString(),
    members: batch.members.map((member) => ({
      sourceDocumentId: member.sourceDocumentId,
      sourceRepresentationRevisionId: member.sourceRepresentationRevisionId,
      executionStatus: member.executionStatus,
      executionFailureMessage: member.failureMessage,
      startedAt: member.startedAt?.toISOString() ?? null,
      finishedAt: member.finishedAt?.toISOString() ?? null,
      latestExtraction: member.latestExtraction && {
        extractionId: member.latestExtraction.extractionId,
        outcome: member.latestExtraction.outcome,
        complete: member.latestExtraction.complete,
        reviewable: member.latestExtraction.reviewable,
        createdAt: member.latestExtraction.createdAt.toISOString(),
        reviewedAt: member.latestExtraction.reviewedAt?.toISOString() ?? null,
        failureMessage: member.latestExtraction.failureMessage,
      },
    })),
  }
}

function unavailableUnlessNotFound(error: unknown, message: string): never {
  if (error instanceof ExtractionError && error.code === 'not_found')
    throw new ApiError(404, 'not_found', message, { cause: error })
  throw persistenceUnavailable(error)
}

/** The HTTP boundary schedules durable work; it never waits for model execution. */
export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
  dependencies: ExtractionHandlerDependencies = {},
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  const extractionModels = dependencies.extractionModels ?? (() => configuredExtractionModels())
  const extractionModule = createResearcherExtractions(
    store.researcherAccountId,
  )
  const open = async (request: Request) => {
    const parsed = batchExtractionRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'The Batch Extraction request is invalid.',
      )
    const { force, ...selection } = parsed.data
    const models = await extractionModels()
    let opened: ScheduleBatchResult
    try {
      opened = await extractionModule.scheduleBatch({
        models,
        ...selection,
        repetition: force ? 'create-new' : 'reuse-equal-selection',
      })
    } catch (error) {
      if (
        error instanceof ExtractionError &&
        (error.code === 'invalid_extraction_pins' ||
          error.code === 'batch_conflict')
      )
        throw new ApiError(
          422,
          'invalid_batch_selection',
          'Use the Current Schema Revision and Source Documents in this Project Context with a Source Representation.',
          { cause: error },
        )
      unavailableUnlessNotFound(error, 'Project Context was not found.')
    }
    return json(
      batchExtractionOpenResponseSchema.parse({
        batchExtraction: batchDto(opened.batch),
        disposition: opened.disposition,
      }),
      { status: 202, headers: noStore },
    )
  }

  const list = async (url: URL) => {
    const projectContextId = url.searchParams.get('projectContextId')
    if (
      !projectContextId ||
      !canonicalUuidSchema.safeParse(projectContextId).success
    )
      throw new ApiError(
        422,
        'invalid_request',
        'projectContextId must be a canonical lowercase UUID.',
      )
    let batches: readonly BatchExtractionSnapshot[]
    try {
      batches = await extractionModule.listBatches({
        projectContextId,
        limit: boundedLimit(url),
      })
    } catch (error) {
      unavailableUnlessNotFound(error, 'Project Context was not found.')
    }
    return json(
      batchExtractionListResponseSchema.parse({
        batchExtractions: batches.map(batchDto),
      }),
      { headers: noStore },
    )
  }

  const read = async (url: URL, batchExtractionId: string) => {
    const projectContextId = url.searchParams.get('projectContextId')
    if (
      !projectContextId ||
      !canonicalUuidSchema.safeParse(projectContextId).success ||
      !canonicalUuidSchema.safeParse(batchExtractionId).success
    )
      throw new ApiError(
        422,
        'invalid_request',
        'The Batch Extraction identity is invalid.',
      )
    let batch: BatchExtractionSnapshot
    try {
      batch = await extractionModule.readBatch({
        projectContextId,
        batchExtractionId,
      })
    } catch (error) {
      unavailableUnlessNotFound(error, 'Batch Extraction was not found.')
    }
    return json(
      batchExtractionResponseSchema.parse({ batchExtraction: batchDto(batch) }),
      { headers: noStore },
    )
  }

  /**
   * Every Extraction Result the batch has produced, in member order. The
   * researcher's export reads one Batch Extraction as one spreadsheet.
   */
  const results = async (url: URL, batchExtractionId: string) => {
    const projectContextId = url.searchParams.get('projectContextId')
    if (
      !projectContextId ||
      !canonicalUuidSchema.safeParse(projectContextId).success ||
      !canonicalUuidSchema.safeParse(batchExtractionId).success
    )
      throw new ApiError(
        422,
        'invalid_request',
        'The Batch Extraction identity is invalid.',
      )
    let produced: BatchExtractionResults
    try {
      produced = await extractionModule.readBatchResults({
        projectContextId,
        batchExtractionId,
      })
    } catch (error) {
      unavailableUnlessNotFound(error, 'Batch Extraction was not found.')
    }
    return json(
      batchExtractionResultsResponseSchema.parse(produced),
      { headers: noStore },
    )
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === COLLECTION_ROUTE)
        return await open(request)
      if (request.method === 'GET' && url.pathname === COLLECTION_ROUTE)
        return await list(url)
      const resultsMatch = RESULTS_ROUTE.exec(url.pathname)
      if (request.method === 'GET' && resultsMatch)
        return await results(url, resultsMatch[1])
      const itemMatch = ITEM_ROUTE.exec(url.pathname)
      if (request.method === 'GET' && itemMatch)
        return await read(url, itemMatch[1])
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(error)
    }
  }

  return { GET: handle, POST: handle }
}
