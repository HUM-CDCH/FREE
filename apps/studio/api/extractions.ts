/// <reference types="vite/client" />

import type { ResearcherProjectStore } from 'db'
import { ExtractionError } from 'extraction'
import {
  extractionReadResponseSchema,
  extractionRequestSchema,
} from '../shared/extraction.contract.js'
import {
  ApiError,
  boundedValidationDetails,
  json,
  noStore,
  noStoreError,
  parseJsonRequest,
  persistenceUnavailable,
} from './_http.js'
import {
  createResearcherExtractions,
  extractionAttemptDto,
} from './_extractions.js'
import { methodRefusal } from './_method_refusals.js'

const COLLECTION_ROUTE = '/api/extractions'
const ITEM_ROUTE = /^\/api\/extractions\/([0-9a-f-]+)$/


/** Admission and status reads reach PostgreSQL and DBOS: an outage there is 503 with retry semantics, never a
 *  fabricated result (spec, *Status and ownership*). An ApiError or ExtractionError keeps its own answer. */
function unavailableUnlessDomain(error: unknown): never {
  if (error instanceof ApiError || error instanceof ExtractionError) throw error
  throw persistenceUnavailable(error)
}

function asTransportError(error: unknown): unknown {
  if (!(error instanceof ExtractionError)) return error
  const refused = methodRefusal(error)
  if (refused) return refused
  switch (error.code) {
    case 'not_found':
      return new ApiError(404, 'not_found', error.message, { cause: error })
    case 'invalid_source_representation':
      return new ApiError(
        503,
        'source_artifact_unavailable',
        'The pinned Source Representation is unavailable.',
        { cause: error },
      )
    case 'extraction_id_conflict':
    case 'invalid_extraction_pins':
    case 'source_representation_superseded':
      return new ApiError(409, error.code, error.message, { cause: error })
    case 'invalid_request':
      return new ApiError(422, error.code, error.message, { cause: error })
    default:
      return error
  }
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  const module = createResearcherExtractions(store.researcherAccountId)
  async function create(request: Request): Promise<Response> {
    const parsed = extractionRequestSchema.safeParse(
      await parseJsonRequest(request),
    )
    if (!parsed.success)
      throw new ApiError(422, 'invalid_request', 'The Extraction request is invalid.', {
        details: boundedValidationDetails('request', parsed.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        }))),
      })
    // Admission compares the submitted method with the account's saved one; this handler never reads the account.
    const input = {
      kind: 'fresh' as const,
      extractionId: parsed.data.id,
      sourceRepresentationRevisionId: parsed.data.sourceRepresentationRevisionId,
      schemaRevisionId: parsed.data.schemaRevisionId,
      strategy: parsed.data.strategy,
      ...(parsed.data.catalogRecipe ? { catalogRecipe: parsed.data.catalogRecipe } : {}),
      method: parsed.data.method,
      startPage: parsed.data.startPage ?? null,
    }
    const completed = await module.runSingle(input).catch(unavailableUnlessDomain)
    return json(extractionAttemptDto(completed.extraction), {
      status: completed.disposition === 'created' ? 201 : 200,
      headers: noStore,
    })
  }

  async function read(extractionId: string): Promise<Response> {
    const extraction = await module.readExtractionAttempt(extractionId).catch(unavailableUnlessDomain)
    if (!extraction)
      throw new ApiError(404, 'not_found', 'That Extraction was not found.')
    return json(extractionReadResponseSchema.parse({ extraction: extractionAttemptDto(extraction) }), { headers: noStore })
  }

  const handle = async (request: Request): Promise<Response> => {
    try {
      const pathname = new URL(request.url).pathname
      if (request.method === 'POST' && pathname === COLLECTION_ROUTE)
        return await create(request)
      const itemMatch = ITEM_ROUTE.exec(pathname)
      if (request.method === 'GET' && itemMatch)
        return await read(itemMatch[1])
      throw new ApiError(404, 'not_found', 'API route not found.')
    } catch (error) {
      return noStoreError(asTransportError(error))
    }
  }

  return { GET: handle, POST: handle }
}
