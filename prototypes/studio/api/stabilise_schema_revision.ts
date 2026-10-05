import { ExtractionError, type ExtractionModule } from 'extraction'
import type { ResearcherProjectStore } from 'db'
import {
  stabiliseSchemaRevisionRequestSchema,
  stabiliseSchemaRevisionResponseSchema,
} from '../shared/stabiliseSchemaRevision.contract.js'
import { createResearcherExtractions } from './_extractions.js'
import { ApiError, json, noStore, noStoreError, parseJsonRequest } from './_http.js'

function unavailableUnlessKnown(error: unknown): never {
  if (error instanceof ExtractionError && error.code === 'not_found')
    throw new ApiError(404, 'not_found', 'Schema Revision was not found.', {
      cause: error,
    })
  if (error instanceof ExtractionError && error.code === 'schema_not_ready_to_stabilise')
    throw new ApiError(
      409,
      'schema_not_ready_to_stabilise',
      'Review at least one pilot Extraction against this Schema Revision before stabilising it.',
      { cause: error },
    )
  throw error
}

export function createResearcherApiHandlers(
  store: ResearcherProjectStore,
): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
  const extractionModule: ExtractionModule = createResearcherExtractions(
    store.researcherAccountId,
  )
  const POST = async (request: Request): Promise<Response> => {
    try {
      if (new URL(request.url).pathname !== '/api/stabilise_schema_revision')
        throw new ApiError(404, 'not_found', 'Route was not found.')
      const parsed = stabiliseSchemaRevisionRequestSchema.safeParse(
        await parseJsonRequest(request),
      )
      if (!parsed.success)
        throw new ApiError(
          422,
          'invalid_request',
          'The stabilise request is invalid.',
        )
      let result
      try {
        result = await extractionModule.stabiliseSchemaRevision(parsed.data)
      } catch (error) {
        unavailableUnlessKnown(error)
      }
      return json(
        stabiliseSchemaRevisionResponseSchema.parse(result),
        { headers: noStore },
      )
    } catch (error) {
      return noStoreError(error)
    }
  }
  return { POST }
}
