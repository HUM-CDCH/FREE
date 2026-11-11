import {
  suggestWorkflowId,
  type BatchSchemaSuggestionRecord,
  type ResearcherProjectStore,
} from 'db'
import { studioDbos } from '../server/dbos.js'
import type { ModelOperationClient } from './_model_operation.js'
import {
  batchSchemaSuggestionCreateFromSpreadsheetRequestSchema,
  batchSchemaSuggestionCreateRequestSchema,
  batchSchemaSuggestionListResponseSchema,
  batchSchemaSuggestionResponseSchema,
  batchSchemaSuggestionRetryRequestSchema,
} from '../shared/batchSchemaSuggestion.contract.js'
import { batchSourceCoverageSchema, type BatchSourceCoverage } from '../shared/schemaSuggestionSource.contract.js'
import type { SpreadsheetColumn } from './_spreadsheet_schema.js'
import { parseBatchSuggestionDefinition, parseSchemaDefinition, type SchemaDefinition } from 'extraction/schema'
import {
  ApiError,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import { modelSuggestedDefinition } from './_batch_schema_suggestions.js'
import { buildSpreadsheetTemplate, columnFieldIds } from './_spreadsheet_schema.js'

const ROUTE = '/api/batch-schema-suggestions'
const FROM_SPREADSHEET_ROUTE = '/api/batch-schema-suggestions/from-spreadsheet'
const ITEM_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)$/
const APPLY_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)\/apply$/
const RETRY_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)\/retry$/
const STOP_ROUTE = /^\/api\/batch-schema-suggestions\/([0-9a-f-]+)\/stop$/


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

/** The `coverage` column's source declaration. Rows published before it hold schema-path agreement counts (or
 *  nothing), which declare nothing about the source: they read as not recorded. */
function storedSourceCoverage(value: unknown): BatchSourceCoverage | null {
  const declared = batchSourceCoverageSchema.safeParse(value)
  return declared.success ? declared.data : null
}

function suggestionDto(suggestion: BatchSchemaSuggestionRecord) {
  return batchSchemaSuggestionResponseSchema.parse({
    batchSchemaSuggestion: {
      batchSchemaSuggestionId: suggestion.batchSchemaSuggestionId,
      projectContextId: suggestion.projectContextId,
      selectionKey: suggestion.selectionKey,
      attempt: suggestion.attempt,
      executionStatus: suggestion.executionStatus,
      phase: suggestion.phase,
      sourceKind: suggestion.sourceKind,
      columnFieldMapping: suggestion.columnFieldMapping,
      projectSpreadsheetVersionId: suggestion.projectSpreadsheetVersionId,
      proposal:
        suggestion.proposal === null
          ? null
          : parseSchemaDefinition(suggestion.proposal),
      sourceCoverage: storedSourceCoverage(suggestion.coverage),
      failure: failureDto(suggestion.failure),
      savedSchema: suggestion.savedSchema,
      createdAt: suggestion.createdAt.toISOString(),
      sources: suggestion.sources.map((source) => ({
        sourceDocumentId: source.sourceDocumentId,
        sourceRepresentationRevisionId: source.sourceRepresentationRevisionId,
      })),
    },
  })
}

/** The retained result an apply saves; null while there is none, or when a row written before applies cannot run. */
function retainedResult(suggestion: BatchSchemaSuggestionRecord): SchemaDefinition | null {
  if (suggestion.phase !== 'READY' || suggestion.draft === null) return null
  try {
    return parseBatchSuggestionDefinition(suggestion.draft)
  } catch {
    return null
  }
}

/**
 * Durable schema-suggestion HTTP lifecycle. Creation and retry admit an attempt's `suggestSchemaBatch` workflow with
 * its rows and answer 202; the model work runs on DBOS's `suggest` queue. Reads only read: status is derived. Apply
 * saves a settled result as an ordinary Extraction Schema, which is then edited and run like any other.
 */
export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
  operations: () => Pick<ModelOperationClient, 'cancelWorkflow'> = () => studioDbos().admission,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
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
    return json(suggestionDto(opened.suggestion), { status: 202, headers: noStore })
  }

  /** A spreadsheet-derived suggestion has no document sources to run a
   *  model against — it reads the project's already-uploaded spreadsheet
   *  (`GET/POST /api/project-spreadsheets`, shared across every action
   *  that wants it, not a one-off upload per suggestion) and is built
   *  synchronously, immediately READY (design.md D1b/D4 in
   *  the spreadsheet-schema-suggestion design). */
  const createFromSpreadsheet = async (request: Request) => {
    const parsed = batchSchemaSuggestionCreateFromSpreadsheetRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(422, 'invalid_request', 'The request is invalid.')
    const { projectContextId, separator } = parsed.data

    const current = await store
      .getCurrentProjectSpreadsheet(projectContextId)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!current)
      throw new ApiError(
        404,
        'not_found',
        'This Project Context has no uploaded spreadsheet yet. Upload one first via /api/project-spreadsheets.',
      )

    const built = buildSpreadsheetTemplate(
      current.columns as SpreadsheetColumn[],
      separator ?? null,
    )
    if (!built.ok)
      throw new ApiError(
        422,
        'invalid_request',
        `Some columns can't be both a field and a group: ${built.conflicts
          .map(([leaf, group]) => `"${leaf}" vs "${group}"`)
          .join('; ')}.`,
      )

    let definition
    try {
      definition = modelSuggestedDefinition({
        _description: 'Uploaded from a spreadsheet.',
        ...built.template,
      })
    } catch (cause) {
      throw new ApiError(
        422,
        'invalid_request',
        cause instanceof Error ? cause.message : 'The spreadsheet columns are invalid.',
        { cause },
      )
    }

    const mapping = columnFieldIds(definition.schemaNodes, built.columnPaths)
    const opened = await store
      .createSpreadsheetSchemaSuggestion(
        projectContextId,
        definition,
        mapping,
        current.projectSpreadsheetVersionId,
      )
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!opened)
      throw new ApiError(404, 'not_found', 'Project Context was not found.')
    return json(suggestionDto(opened.suggestion), { status: 201, headers: noStore })
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
    return json(suggestionDto(suggestion), { headers: noStore })
  }

  /** Saves the settled result as an Extraction Schema, once; a repeat answers the schema it saved. */
  const apply = async (url: URL, id: string) => {
    const projectContextId = projectId(url)
    const suggestion = await store.getBatchSchemaSuggestion(projectContextId, id).catch((cause) => {
      throw persistenceUnavailable(cause)
    })
    if (!suggestion)
      throw new ApiError(404, 'not_found', 'Batch Schema Suggestion was not found.')
    const notReady = () => new ApiError(409, 'operation_not_ready', 'The suggested fields are not ready to save.')
    const definition = retainedResult(suggestion)
    if (!definition) throw notReady()
    // The attempt pins the parsed result: the store refuses it once another attempt has started.
    const applied = await store
      .applyBatchSchemaSuggestion(projectContextId, id, suggestion.attempt, definition)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (applied === null)
      throw new ApiError(404, 'not_found', 'Batch Schema Suggestion was not found.')
    if (applied.status === 'not-ready') throw notReady()
    return json(suggestionDto(applied.suggestion), { headers: noStore })
  }

  const retry = async (request: Request, url: URL, id: string) => {
    const parsed = batchSchemaSuggestionRetryRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(
        422,
        'invalid_request',
        'A retry names the attempt it follows as a positive integer expectedAttempt.',
      )
    const result = await store
      .retryBatchSchemaSuggestion(projectId(url), id, parsed.data.expectedAttempt)
      .catch((cause) => {
        throw persistenceUnavailable(cause)
      })
    if (!result)
      throw new ApiError(404, 'not_found', 'Batch Schema Suggestion was not found.')
    if (result.status === 'attempt-conflict')
      throw new ApiError(
        409,
        'attempt_conflict',
        'The suggestion was regenerated since this page read it. Reload before trying again.',
      )
    if (result.status === 'not-ready')
      throw new ApiError(
        409,
        'operation_not_ready',
        'The suggestion can be regenerated only after its current attempt finished, and while it has a Source Document.',
      )
    // A replay answers the successor this attempt already has, whether or not it finished.
    return json(suggestionDto(result.suggestion), { status: 202, headers: noStore })
  }

  /** Stops the suggestion's running attempt: its workflow is cancelled, so it reads as interrupted and can be tried
   *  again. One already finished is answered as it is. */
  const stop = async (url: URL, id: string) => {
    const read = () => store.getBatchSchemaSuggestion(projectId(url), id).catch((cause) => {
      throw persistenceUnavailable(cause)
    })
    const suggestion = await read()
    if (!suggestion)
      throw new ApiError(404, 'not_found', 'Batch Schema Suggestion was not found.')
    if (suggestion.executionStatus !== 'QUEUED' && suggestion.executionStatus !== 'RUNNING')
      return json(suggestionDto(suggestion), { headers: noStore })
    await operations().cancelWorkflow(suggestWorkflowId(id, suggestion.attempt)).catch((cause) => {
      throw persistenceUnavailable(cause, 'Model operations are unavailable.')
    })
    return json(suggestionDto((await read()) ?? suggestion), { headers: noStore })
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url)
      if (request.method === 'POST' && url.pathname === FROM_SPREADSHEET_ROUTE)
        return await createFromSpreadsheet(request)
      if (request.method === 'POST' && url.pathname === ROUTE)
        return await create(request)
      if (request.method === 'GET' && url.pathname === ROUTE)
        return await list(url)
      const applyMatch = APPLY_ROUTE.exec(url.pathname)
      if (request.method === 'POST' && applyMatch)
        return await apply(url, applyMatch[1])
      const retryMatch = RETRY_ROUTE.exec(url.pathname)
      if (request.method === 'POST' && retryMatch)
        return await retry(request, url, retryMatch[1])
      const stopMatch = STOP_ROUTE.exec(url.pathname)
      if (request.method === 'POST' && stopMatch)
        return await stop(url, stopMatch[1])
      const item = ITEM_ROUTE.exec(url.pathname)
      if (request.method === 'GET' && item) return await read(url, item[1])
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(error)
    }
  }

  return { GET: handle, POST: handle }
}
