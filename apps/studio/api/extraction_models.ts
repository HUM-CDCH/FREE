import type { KeiExpClient } from 'extraction'
import { extractionModelListingSchema } from '../shared/extraction.contract.js'
import { ApiError, json, noStore, noStoreError } from './_http.js'
import { keiExpClient } from './_extractions.js'

const ROUTE = '/api/extraction-models'

/**
 * `GET /api/extraction-models`: the models the kei-exp deployment serves for Extraction, the roles (`fields`,
 * `reasoning`) each may take, whether its server serves it now, and kei-exp's default per role. These are what a
 * run's Extraction Model Choice picks from; they are not FREE Model Connections or Capability Routes.
 */
export function createGetExtractionModels(client: Pick<KeiExpClient, 'listModels'>) {
  return async function GET(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== ROUTE)
        throw new ApiError(404, 'not_found', 'API route not found.')
      let listing: unknown
      try {
        listing = await client.listModels(request.signal)
      } catch (cause) {
        request.signal.throwIfAborted()
        throw new ApiError(503, 'extraction_models_unavailable', 'The Parsing Service could not list its extraction models.', { cause })
      }
      const parsed = extractionModelListingSchema.safeParse(listing)
      if (!parsed.success)
        throw new ApiError(503, 'extraction_models_unavailable', 'The Parsing Service could not list its extraction models.')
      return json(parsed.data, { headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }
}

/** Researcher-scoped: served to any signed-in researcher. The listing belongs to the deployment, not to a Project
 *  Context, so the researcher's store is not consulted. */
export function createResearcherApiHandlers(): Readonly<
  Record<string, (request: Request) => Response | Promise<Response>>
> {
  return { GET: createGetExtractionModels(keiExpClient) }
}
