import { z } from 'zod'
import { ExtractionError } from './errors.js'
import { KEI_RUN_ID } from './kei-handoff.js'

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

export type {
  KeiExpAnyArtifact, KeiExpArtifact, KeiExpCall, KeiExpEvidence, KeiExpGroundedArtifact, KeiExpGroundedEvidence,
} from './kei-artifact.js'
export type KeiExpModelListing = z.infer<typeof modelListingSchema>
export type KeiExpIngestionModelListing = z.infer<typeof ingestionListingSchema>
export interface KeiExpClient {
  /** `GET /api/runs/{run}/extractions/{id}`: the artifact kei published, byte for byte (file-only since M3; 404 until
   *  then). A server failure or a timeout is transient (ARTIFACT_READ_RETRY reads again); any other refusal is an
   *  ExtractionError the Extraction fails with. */
  readExtractionArtifact(runId: string, extractionId: string, signal?: AbortSignal): Promise<Uint8Array>
  /** `GET /api/runs/{run}/extractions/{id}/progress` (kei-exp `api.py` `run_extraction_progress`): the progress document
   *  of a running Extraction, or null while kei has published no stage of it (404) or the ids are outside kei's path
   *  component. The read waits at most PROGRESS_TIMEOUT_MS; a slow or unreachable kei and a server failure throw a
   *  transient error, and the caller shows no partial view (design §5). The document is validated by the caller. */
  readExtractionProgress(runId: string, extractionId: string, signal?: AbortSignal): Promise<unknown | null>
  /** The extraction models kei-exp's deployment serves, the roles each may take, and its default per role. */
  listModels(signal?: AbortSignal): Promise<KeiExpModelListing>
  /** The OCR and layout models a new parse may run on, whether kei-exp's OCR server serves each now, and the default
   *  per role. */
  listIngestionModels(signal?: AbortSignal): Promise<KeiExpIngestionModelListing>
}

/** The two seconds a status read may wait for kei's progress: the client polls every two seconds. */
export const PROGRESS_TIMEOUT_MS = 2_000

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
    async readExtractionArtifact(runId, extractionId, signal) {
      if (!KEI_RUN_ID.test(runId) || !KEI_RUN_ID.test(extractionId))
        throw new ExtractionError('invalid_model_output', 'kei-exp named an invalid run or extraction.')
      let response: Response
      try {
        response = await fetchRequest(`${root}/api/runs/${runId}/extractions/${extractionId}`, {
          method: 'GET', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
        })
      } catch (error) {
        signal?.throwIfAborted()
        // Unreachable or slow: kei's API may be restarting, so the read is tried again.
        throw Object.assign(new Error('kei-exp could not be reached to read the extraction artifact.', { cause: error }), { transient: true })
      }
      if (response.status >= 500) throw Object.assign(new Error(await httpFailure(response)), { transient: true })
      // kei answered SUCCESS with this artifact's hash, so a missing file will not appear later.
      if (response.status === 404) {
        await response.body?.cancel()
        throw new ExtractionError('extraction_failed', 'kei-exp has no published artifact for this Extraction.')
      }
      if (!response.ok) throw new ExtractionError('invalid_model_output', await httpFailure(response))
      return new Uint8Array(await response.arrayBuffer())
    },
    async readExtractionProgress(runId, extractionId, signal) {
      if (!KEI_RUN_ID.test(runId) || !KEI_RUN_ID.test(extractionId)) return null
      let response: Response
      try {
        response = await fetchRequest(`${root}/api/runs/${runId}/extractions/${extractionId}/progress`, {
          method: 'GET', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(PROGRESS_TIMEOUT_MS)]),
        })
      } catch (error) {
        signal?.throwIfAborted()
        throw Object.assign(new Error('kei-exp could not be reached to read the extraction progress.', { cause: error }), { transient: true })
      }
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      if (!response.ok) throw Object.assign(new Error(await httpFailure(response)), { transient: true })
      return (await response.json()) as unknown
    },
  }
}
