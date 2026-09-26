import type {
  BatchSchemaSuggestionRecord,
  ResearcherProjectStore,
} from 'db'
import { ExtractionError } from 'extraction'
import {
  batchSchemaSuggestionCreateRequestSchema,
  batchSchemaSuggestionDraftRequestSchema,
  batchSchemaSuggestionListResponseSchema,
  batchSchemaSuggestionResponseSchema,
  batchSchemaSuggestionRunRequestSchema,
} from '../shared/batchSchemaSuggestion.contract.js'
import { parseSchemaDefinition } from 'extraction/schema'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import { validateEditableSuggestion } from './_batch_schema_suggestions.js'
import { projectOperations } from './_project_operations.js'
import { createResearcherExtractions } from './_extraction_runtime.js'
import type { ExtractionHandlerDependencies } from './extractions.js'
import { configuredExtractionModels } from './_model_config.js'

const ROUTE = '/api/batch-schema-suggestions'
const ITEM_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)$/
const DRAFT_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)\/draft$/
const RUN_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)\/run$/
const RETRY_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)\/retry$/


function failureDto(value: unknown) {
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string'
  )
    return {
      code: (value as { code: string }).code,
      message: (value as { message: string }).message,
    }
  return null
}

function suggestionDto(suggestion: BatchSchemaSuggestionRecord) {
  return batchSchemaSuggestionResponseSchema.parse({
    batchSchemaSuggestion: {
      batchSchemaSuggestionId: suggestion.batchSchemaSuggestionId,
      projectContextId: suggestion.projectContextId,
      selectionKey: suggestion.selectionKey,
      executionStatus: suggestion.executionStatus,
      phase: suggestion.phase,
      proposal:
        suggestion.proposal === null
          ? null
          : parseSchemaDefinition(suggestion.proposal),
      coverage: suggestion.coverage,
      draft:
        suggestion.draft === null ? null : parseSchemaDefinition(suggestion.draft),
      draftVersion: suggestion.draftVersion,
      failure: failureDto(suggestion.failure),
      confirmedSchemaRevisionId: suggestion.confirmedSchemaRevisionId,
      batchExtractionId: suggestion.batchExtractionId,
      startedAt: suggestion.startedAt?.toISOString() ?? null,
      finishedAt: suggestion.finishedAt?.toISOString() ?? null,
      createdAt: suggestion.createdAt.toISOString(),
      sources: suggestion.sources.map((source) => ({
        sourceDocumentId: source.sourceDocumentId,
        sourceRepresentationRevisionId: source.sourceRepresentationRevisionId,
        executionStatus: source.executionStatus,
        definition:
          source.definition === null
            ? null
            : parseSchemaDefinition(source.definition),
        failure: failureDto(source.failure),
        startedAt: source.startedAt?.toISOString() ?? null,
        finishedAt: source.finishedAt?.toISOString() ?? null,
      })),
    },
  })
}

/** Durable schema-suggestion HTTP lifecycle: all model work runs after 202. */
export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
  dependencies: ExtractionHandlerDependencies = {},
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  const extractionModels = dependencies.extractionModels ?? (() => configuredExtractionModels(store.researcherAccountId))
  const operations = projectOperations
  const extractionModule = createResearcherExtractions(
    store.researcherAccountId,
  )
  const projectId = (url: URL) => {
    const value = url.searchParams.get('projectContextId')
    if (!value)
      throw new ApiError(
        422,
        'invalid_request',
        'projectContextId is required.',
      )
    return value
  }

  const create = async (request: Request) => {
    const parsed = batchSchemaSuggestionCreateRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'The Batch Schema Suggestion request is invalid.',
      )
    const opened = await store
      .createBatchSchemaSuggestion(
        parsed.data.projectContextId,
        parsed.data.sourceDocumentIds,
      )
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!opened)
      throw new ApiError(404, 'not_found', 'Project Context was not found.')
    if (opened.status === 'invalid')
      throw new ApiError(
        422,
        'invalid_selection',
        'Use Source Documents in this Project Context with a Source Representation.',
      )
    operations.kick()
    return json(suggestionDto(opened.suggestion), { status: 202, headers: noStore })
  }

  const list = async (url: URL) => {
    const projectContextId = projectId(url)
    const suggestions = await store
      .listBatchSchemaSuggestions(projectContextId, 50)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!suggestions)
      throw new ApiError(404, 'not_found', 'Project Context was not found.')
    operations.kick()
    return json(
      batchSchemaSuggestionListResponseSchema.parse({
        batchSchemaSuggestions: suggestions.map(
          (suggestion) => suggestionDto(suggestion).batchSchemaSuggestion,
        ),
      }),
      { headers: noStore },
    )
  }

  const read = async (url: URL, batchSchemaSuggestionId: string) => {
    const suggestion = await store
      .getBatchSchemaSuggestion(projectId(url), batchSchemaSuggestionId)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!suggestion)
      throw new ApiError(404, 'not_found', 'Batch Schema Suggestion was not found.')
    operations.kick()
    return json(suggestionDto(suggestion), { headers: noStore })
  }

  const updateDraft = async (request: Request, url: URL, id: string) => {
    const parsed = batchSchemaSuggestionDraftRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(422, 'invalid_request', 'The Schema Suggestion draft is invalid.')
    const updated = await store
      .updateBatchSchemaSuggestionDraft(
        projectId(url),
        id,
        parsed.data.expectedDraftVersion,
        validateEditableSuggestion({
          recordDescription: parsed.data.recordDescription,
          schemaNodes: parsed.data.schemaNodes,
        }),
      )
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!updated)
      throw new ApiError(404, 'not_found', 'Batch Schema Suggestion was not found.')
    if (updated.status === 'invalid')
      throw new ApiError(
        409,
        'operation_not_ready',
        'Only an unconfirmed ready suggestion can be edited.',
      )
    if (updated.status === 'conflict')
      throw new ApiError(
        409,
        'draft_conflict',
        'The saved suggestion draft changed in another tab.',
      )
    return json(suggestionDto(updated.suggestion), { headers: noStore })
  }

  const run = async (request: Request, url: URL, id: string) => {
    const parsed = batchSchemaSuggestionRunRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'The Batch Extraction strategy is invalid.',
      )
    const projectContextId = projectId(url)
    const models = await extractionModels()
    try {
      await extractionModule.scheduleSuggestedBatch({
        models,
        projectContextId,
        batchSchemaSuggestionId: id,
        strategy: parsed.data.strategy,
      })
    } catch (error) {
      if (error instanceof ExtractionError && error.code === 'not_found')
        throw new ApiError(
          404,
          'not_found',
          'Batch Schema Suggestion was not found.',
          { cause: error },
        )
      if (error instanceof ExtractionError && error.code === 'batch_not_ready')
        throw new ApiError(
          409,
          'operation_not_ready',
          'The suggested fields are not ready to run.',
          { cause: error },
        )
      throw persistenceUnavailable(error)
    }
    const suggestion = await store
      .getBatchSchemaSuggestion(projectContextId, id)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!suggestion)
      throw new ApiError(
        404,
        'not_found',
        'Batch Schema Suggestion was not found.',
      )
    return json(suggestionDto(suggestion), { status: 202, headers: noStore })
  }

  const retry = async (url: URL, id: string) => {
    const result = await store
      .retryBatchSchemaSuggestion(projectId(url), id)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!result)
      throw new ApiError(404, 'not_found', 'Batch Schema Suggestion was not found.')
    operations.kick()
    return json(suggestionDto(result.suggestion), { status: 202, headers: noStore })
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === ROUTE)
        return await create(request)
      if (request.method === 'GET' && url.pathname === ROUTE)
        return await list(url)
      const draft = DRAFT_ROUTE.exec(url.pathname)
      if (request.method === 'PATCH' && draft)
        return await updateDraft(request, url, draft[1])
      const runMatch = RUN_ROUTE.exec(url.pathname)
      if (request.method === 'POST' && runMatch)
        return await run(request, url, runMatch[1])
      const retryMatch = RETRY_ROUTE.exec(url.pathname)
      if (request.method === 'POST' && retryMatch)
        return await retry(url, retryMatch[1])
      const item = ITEM_ROUTE.exec(url.pathname)
      if (request.method === 'GET' && item) return await read(url, item[1])
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(error)
    }
  }

  return { GET: handle, POST: handle, PATCH: handle }
}
