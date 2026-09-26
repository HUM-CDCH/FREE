import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { ExtractionError } from './errors.js'
import { anyArtifactSchema, type KeiExpAnyArtifact } from './kei-artifact.js'
import type { ExtractionSchemaDefinition } from './schema.js'
import { modelChoice } from './model-choice.js'
import type { ExtractionModelChoice } from './types.js'

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
const acceptedSchema = z.object({ id: z.string().min(1), run_id: z.string(), status: z.literal('queued'), generation: z.string().min(1) })
/** What `GET /api/runs/{run_id}/extractions/{id}` answers: the job's status, and the
 *  artifact under `result` only once the status is `done`. */
const envelopeSchema = z.object({
  id: z.string().min(1),
  run_id: z.string(),
  status: z.string().min(1),
  error: z.string().nullable().default(null),
  created: z.string().optional(),
  finished: z.string().nullable().optional(),
  result: z.unknown(),
})

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

/** `Retry-After` as kei-exp and any proxy in front of it send it: delta-seconds or an HTTP date.
 *  Capped, so that one absurd header cannot park a job for the rest of its deadline, and falling
 *  back to the poll interval when the header is absent or unusable. */
export function retryAfterMs(header: string | null, fallback: number): number {
  if (header === null) return fallback
  const value = header.trim()
  if (value === '') return fallback
  const seconds = Number(value)
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return fallback
  return Math.min(milliseconds, 60_000)
}

export type {
  KeiExpAnyArtifact, KeiExpArtifact, KeiExpCall, KeiExpEvidence, KeiExpGroundedArtifact, KeiExpGroundedEvidence,
} from './kei-artifact.js'
export type KeiExpModelListing = z.infer<typeof modelListingSchema>
export type KeiExpIngestionModelListing = z.infer<typeof ingestionListingSchema>
export type KeiExpStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type KeiExpEnvelope = Readonly<{
  id: string
  run_id: string
  status: KeiExpStatus
  created: string
  finished: string | null
  error: string | null
  result: unknown
}>
export type KeiExpRequest = Readonly<{
  runId: string
  schema: ExtractionSchemaDefinition
  strategy: 'catalog' | 'article'
  /** A numbered-catalogue recipe (`id@version`) for a Catalog Extraction, chosen per Extraction; null keeps
   *  kei-exp's generic Catalog discovery. With a recipe kei-exp answers with a version 2 artifact. */
  catalogRecipe?: string | null
  /** The Extraction Model Choice: per role, a model key of kei-exp's deployment. A role left out, or no choice at all,
   *  keeps kei-exp's deployment default for it. */
  models?: ExtractionModelChoice | null
  /** The parse generation the caller pinned, checked against the acknowledgement before any
   *  polling; null when the Source Representation does not come from kei-exp. */
  expectedGeneration: string | null
  signal: AbortSignal
}>
export interface KeiExpClient {
  extract(request: KeiExpRequest): Promise<KeiExpAnyArtifact>
  /** The extraction models kei-exp's deployment serves, the roles each may take, and its default per role. */
  listModels(signal?: AbortSignal): Promise<KeiExpModelListing>
  /** The OCR and layout models a new parse may run on, whether kei-exp's OCR server serves each now, and the default
   *  per role. */
  listIngestionModels(signal?: AbortSignal): Promise<KeiExpIngestionModelListing>
}

export function createKeiExpClient({
  url,
  fetch: fetchRequest = globalThis.fetch,
  pollIntervalMs = 1500,
}: {
  url: string
  fetch?: typeof globalThis.fetch
  pollIntervalMs?: number
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
    async extract(request) {
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(request.strategy === 'catalog' ? 3 * 60 * 60 * 1000 : 10 * 60 * 1000),
      ])
      const base = `${root}/api/runs/${encodeURIComponent(request.runId)}`
      // Keys of kei-exp's own model registry, per role; never a single legacy `model`, and never a FREE Model
      // Connection's model id. A role left out keeps kei-exp's deployment default.
      const models = modelChoice(request.models)
      const recipe = request.strategy === 'catalog' ? request.catalogRecipe ?? null : null
      const body = JSON.stringify({ schema: request.schema, options: {
        strategy: request.strategy, ...(models === null ? {} : { models }), ...(recipe === null ? {} : { catalog: { recipe } }),
      } })
      /** `resumable` says whether a request that may already have reached kei-exp can simply be
       *  sent again. Polling is; the POST is not, because kei-exp mints the extraction id per
       *  request, so a second POST admits a second extraction that holds the run's only
       *  admission slot for its whole model run — and kei-exp has no cancel route to stop it. */
      async function read(endpoint: string, init: RequestInit, resumable: boolean): Promise<unknown> {
        for (;;) {
          signal.throwIfAborted()
          let wait = pollIntervalMs
          try {
            const response = await fetchRequest(endpoint, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
            if (response.status === 429 || response.status === 503) {
              // Nothing was committed: kei-exp answers these before it mints an id.
              wait = retryAfterMs(response.headers.get('retry-after'), pollIntervalMs)
              await response.body?.cancel()
            } else {
              if (!response.ok) throw new ExtractionError('extraction_failed', await httpFailure(response))
              return await response.json()
            }
          } catch (error) {
            signal.throwIfAborted()
            if (error instanceof SyntaxError)
              throw new ExtractionError('invalid_model_output', 'kei-exp returned invalid JSON.', { cause: error })
            if (!(error instanceof TypeError) && !(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))) throw error
            if (!resumable)
              throw new ExtractionError('extraction_failed', `kei-exp could not be reached to start the Extraction: ${error.message}`, { cause: error })
          }
          await delay(wait, undefined, { signal })
        }
      }
      const accepted = acceptedSchema.safeParse(await read(`${base}/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }, false))
      if (!accepted.success || accepted.data.run_id !== request.runId)
        throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid extraction acknowledgement.')
      // Before the first poll, so that a re-parsed source costs no model run: the acknowledgement
      // already names the generation kei-exp will read.
      if (request.expectedGeneration !== null && accepted.data.generation !== request.expectedGeneration)
        throw new ExtractionError('invalid_source_representation', `kei-exp accepted the Extraction against parse generation ${accepted.data.generation}, not the pinned ${request.expectedGeneration}.`)
      for (;;) {
        await delay(pollIntervalMs, undefined, { signal })
        const envelope = envelopeSchema.safeParse(await read(`${base}/extractions/${encodeURIComponent(accepted.data.id)}`, { method: 'GET' }, true))
        if (!envelope.success || envelope.data.id !== accepted.data.id || envelope.data.run_id !== request.runId)
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid extraction status.')
        const { status } = envelope.data
        if (status === 'queued' || status === 'running') continue
        if (status === 'failed')
          throw new ExtractionError('extraction_failed', `kei-exp could not complete the Extraction: ${envelope.data.error ?? 'it reported no reason.'}`)
        if (status === 'cancelled')
          throw new ExtractionError('cancelled', 'kei-exp cancelled the Extraction.')
        if (status !== 'done')
          throw new ExtractionError('invalid_model_output', `kei-exp reported the unknown extraction status "${status}".`)
        const artifact = anyArtifactSchema.safeParse(envelope.data.result)
        if (!artifact.success)
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid extraction artifact.')
        // Only this client saw the acknowledgement; acceptKeiArtifact checks the artifact against every other input.
        if (artifact.data.generation !== accepted.data.generation)
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an artifact for different extraction inputs.')
        return artifact.data
      }
    },
  }
}
