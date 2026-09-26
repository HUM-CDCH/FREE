import type { KeiExpClient } from 'extraction'
import { ingestionModelListingSchema } from '../shared/modelConfig.contract.js'
import { ApiError, json, noStore, noStoreError } from './_http.js'
import { keiExpClient } from './_extraction_runtime.js'

const ROUTE = '/api/ingestion-models'

/** `GET /api/ingestion-models`: kei's OCR and layout models, whether its OCR server serves each now, and the default
 *  per role. The researcher's Ingestion Model Choice picks among them for new ingestions and reprocessing. A failed
 *  listing blocks neither ingestion nor any configuration edit. */
export function createGetIngestionModels(client: Pick<KeiExpClient, 'listIngestionModels'>) {
  return async function GET(request: Request): Promise<Response> {
    try {
      if (new URL(request.url).pathname !== ROUTE) throw new ApiError(404, 'not_found', 'API route not found.')
      let listing: unknown
      try {
        listing = await client.listIngestionModels(request.signal)
      } catch (cause) {
        request.signal.throwIfAborted()
        throw new ApiError(503, 'ingestion_models_unavailable', 'The Parsing Service could not list its ingestion models.', { cause })
      }
      const parsed = ingestionModelListingSchema.safeParse(listing)
      if (!parsed.success)
        throw new ApiError(503, 'ingestion_models_unavailable', 'The Parsing Service could not list its ingestion models.')
      return json(parsed.data, { headers: noStore })
    } catch (error) {
      return noStoreError(error)
    }
  }
}

export function createResearcherApiHandlers(): Readonly<Record<string, (request: Request) => Response | Promise<Response>>> {
  return { GET: createGetIngestionModels(keiExpClient) }
}
