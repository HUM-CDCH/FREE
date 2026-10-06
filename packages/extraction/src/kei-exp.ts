import { z } from 'zod'
import { ExtractionError } from './errors.js'

/** `GET /api/extraction-models` (kei-exp `api.py` `list_extraction_models`). */
const modelListingSchema = z.object({
  defaults: z.object({ fields: z.string().min(1), reasoning: z.string().min(1) }),
  models: z.array(z.object({
    key: z.string().min(1),
    repo: z.string().min(1),
    roles: z.array(z.enum(['fields', 'reasoning'])),
    reachable: z.boolean(),
    serving: z.boolean(),
  })),
})
/** `GET /api/ingestion-models` (kei-exp `api.py` `list_ingestion_models`): its OCR and layout models, per role. */
const ingestionOptionSchema = z.object({ key: z.string().min(1), label: z.string().min(1), serving: z.boolean() }).strict()
const ingestionListingSchema = z.object({
  defaults: z.object({ ocr: z.string().min(1), layout: z.string().min(1) }).strict(),
  models: z.object({ ocr: z.array(ingestionOptionSchema), layout: z.array(ingestionOptionSchema) }).strict(),
}).strict()
/** What FastAPI put in the body, so that a refusal names its cause rather than only its status:
 *  `detail` is a sentence on kei-exp's own 404/409/422/503 and a list of errors on a validation
 *  failure. An unreadable or bodyless response leaves the status to speak alone. */
async function httpFailure(response: Response): Promise<string> {
  let text = ''
  try { text = (await response.text()).trim().slice(0, 512) } catch { /* the body was lost */ }
  if (text === '') return `kei-exp returned HTTP ${response.status}.`
  let detail: unknown = text
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && 'detail' in parsed) detail = (parsed as { detail: unknown }).detail
  } catch { /* not JSON: the text is the detail */ }
  return `kei-exp returned HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
}

export type KeiExpModelListing = z.infer<typeof modelListingSchema>
export type KeiExpIngestionModelListing = z.infer<typeof ingestionListingSchema>
export interface KeiExpClient {
  /** The extraction models kei-exp's deployment serves, the roles each may take, and its default per role. */
  listModels(signal?: AbortSignal): Promise<KeiExpModelListing>
  /** The OCR and layout models a new parse may run on, whether kei-exp's OCR server serves each now, and the default
   *  per role. */
  listIngestionModels(signal?: AbortSignal): Promise<KeiExpIngestionModelListing>
}

export function createKeiExpClient({
  url,
  fetch: fetchRequest = globalThis.fetch,
}: {
  url: string
  fetch?: typeof globalThis.fetch
}): KeiExpClient {
  const root = url.replace(/\/$/, '')
  /** One of kei-exp's model listings; `what` names it in the failure messages. */
  async function readListing<T>(route: string, schema: z.ZodType<T>, what: string, signal?: AbortSignal): Promise<T> {
    let response: Response
    try {
      response = await fetchRequest(`${root}${route}`, {
        method: 'GET', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
      })
    } catch (error) {
      signal?.throwIfAborted()
      throw new ExtractionError('model_unavailable', `kei-exp could not be reached to list its ${what}s: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    if (!response.ok) throw new ExtractionError('model_unavailable', await httpFailure(response))
    let body: unknown
    try { body = await response.json() }
    catch (error) { throw new ExtractionError('invalid_model_output', 'kei-exp returned invalid JSON.', { cause: error }) }
    const listing = schema.safeParse(body)
    if (!listing.success)
      throw new ExtractionError('invalid_model_output', `kei-exp returned an invalid ${what} listing.`)
    return listing.data
  }
  return {
    listModels: (signal) => readListing('/api/extraction-models', modelListingSchema, 'extraction model', signal),
    listIngestionModels: (signal) => readListing('/api/ingestion-models', ingestionListingSchema, 'ingestion model', signal),
  }
}
