import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ExtractionError } from './errors.js'
import type { ExtractionSchemaDefinition } from './schema.js'
import { modelChoice } from './model-choice.js'
import type { ExtractionModelChoice } from './types.js'

const path = z.array(z.union([z.string(), z.number().int().nonnegative()]))
/** One model call, as kei-exp's `kie/extract/stages.py` `Call` is written into the artifact. */
const callSchema = z.object({
  stage: z.string(),
  record: z.number().int().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  seconds: z.number().nonnegative(),
  finish: z.string().nullable(),
  ok: z.boolean(),
  error: z.string().nullable(),
})
/** One grounded value's evidence: kei-exp's `Link`, with `path` and `bbox_pt` as lists. */
const evidenceSchema = z.object({
  path,
  segment: z.string().regex(/^p\d+_s\d+$/),
  page: z.number().int().positive(),
  bbox_pt: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
  verbatim: z.boolean(),
  hits: z.number().int().nonnegative(),
  linked_by: z.enum(['lexical', 'model']),
  cell: z
    .string()
    .regex(/^r\d+_c\d+$/)
    .nullable()
    .optional(),
  precision: z.enum(['cell', 'segment', 'input']).optional(),
})
/** The dict kei-exp's `kie/extract/run.py` `extract()` returns, field by field. */
const artifactSchema = z.object({
  extraction_version: z.number().int().positive(),
  run_id: z.string().min(1),
  // The parse manifest's generation is a minted string, not a counter (kei-exp `pagefile.Result`).
  generation: z.string().min(1),
  digest: z.string(),
  fingerprint: z.string(),
  strategy: z.enum(['catalog', 'article']),
  // The fields model's repo id: the model that read the values, and the one attribution names.
  model: z.string().min(1),
  // The repo id each role ran on (`kie/extract/models.py` `Router.models`): the run's choice over the deployment defaults.
  models: z.object({ fields: z.string().min(1), reasoning: z.string().min(1) }),
  // kei-exp writes its `PROMPT_VERSION`: a number, not a label.
  prompt_version: z.number().int(),
  schema: z.object({ recordDescription: z.string(), schemaNodes: z.array(z.unknown()) }),
  options: z.record(z.string(), z.unknown()),
  started: z.string(),
  seconds: z.number().nonnegative(),
  complete: z.boolean(),
  records: z.array(z.record(z.string(), z.unknown())),
  evidence: z.array(evidenceSchema),
  ungrounded: z.array(path),
  // The names of the document-level fields (`valueSource: document`): extracted into every
  // record, never grounded and never listed under `ungrounded`.
  unverified: z.array(z.string()),
  issues: z.array(z.object({ code: z.string(), detail: z.string(), record: z.number().int().nullable(), path: path.nullable() })),
  // One object per model call, not a count.
  calls: z.array(callSchema),
  // Null when no call reported usage (kei-exp's `_total()`).
  tokens: z.object({ input: z.number().int().nullable(), output: z.number().int().nullable() }),
})
const span = z.object({ segment: z.string().regex(/^p\d+_s\d+$/), start: z.number().int().nonnegative(), end: z.number().int().positive() })
/** Version 2 evidence (`kie/extract/grounded.py` `_link`): the version 1 link plus the raw code-point spans of the value,
 *  its key, its provenance and alternatives, and the precision its box can claim. */
const groundedEvidenceSchema = evidenceSchema.extend({
  linked_by: z.enum(['key', 'structure']),
  spans: z.array(span).min(1),
  alternatives: z.array(z.array(span)),
  provenance: z.enum(['token', 'positional', 'inherited']),
  key_spans: z.array(span),
  heading: z.string().nullable(),
  precision: z.enum(['cell', 'segment', 'input']),
  raw: z.string(),
  // The document's own glossary expansion of the raw value, which the record keeps unchanged.
  normalized: z.object({ value: z.string(), rule: z.literal('glossary'), key_span: span, expansion_span: span }).nullable(),
})
/** A proposed or rejected candidate kept for review: never part of the accepted record. */
const candidateSchema = z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative(), z.null()])),
  value: z.unknown(),
  quote: z.string().nullable(),
  key: z.string().nullable(),
  provenance: z.string().nullable(),
  spans: z.array(span),
  alternatives: z.array(z.array(span)),
  window: z.number().int().nonnegative(),
  reason: z.string().optional(),
  raw: z.string().optional(),
})
const coverageSchema = z.object({
  complete: z.boolean(), lines: z.number().int().nonnegative(), entries: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(), roles: z.record(z.string(), z.number().int()),
  excluded: z.record(z.string(), z.number().int()), potential_duplicates: z.number().int().nonnegative(),
  reading_order_issues: z.number().int().nonnegative(),
  withheld_intentional: z.array(z.string()), withheld_failures: z.array(z.string()),
})
/** The dict kei-exp's recipe path returns: version 2, discriminated from version 1 by `extraction_version`. */
const groundedArtifactSchema = artifactSchema.extend({
  extraction_version: z.literal(2),
  strategy: z.literal('catalog'),
  evidence: z.array(groundedEvidenceSchema),
  segmentation: z.object({
    fingerprint: z.string(), digest: z.string(),
    recipe: z.object({ id: z.string().min(1), version: z.number().int().positive(), structure_sha256: z.string(), bindings_sha256: z.string() }),
    bindings: z.record(z.string(), z.string()),
    bindings_unmatched: z.array(z.string()),
    diagnostics: z.array(z.object({ code: z.string(), detail: z.string(), block: z.string().nullable(), spans: z.array(span) })),
  }),
  budget: z.object({
    version: z.number().int().positive(), input_tokens: z.number().int().positive(), output_tokens: z.number().int().positive(),
    tokenizer: z.object({ source: z.string(), model: z.string(), model_digest: z.string().nullable(), template_tokens: z.number().int().nullable() }),
    // One tokenizer identity per role, since the roles may be served apart; `tokenizer` is the fields role's.
    tokenizers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  }),
  normalization: z.object({ version: z.number().int().positive(), rules: z.array(z.literal('glossary')) }),
  record_blocks: z.array(z.object({ block: z.string(), entry_label: z.string() })),
  proposed: z.array(candidateSchema),
  rejected: z.array(candidateSchema),
  competitors: z.array(z.object({ path: z.array(z.union([z.string(), z.number().int()])), candidates: z.array(z.object({ value: z.unknown(), spans: z.array(span), window: z.number().int() })), outcome: z.enum(['arbitrated', 'unresolved']) })),
  coverage: coverageSchema,
  completeness: z.object({ processing: z.boolean(), coverage: z.boolean(), grounding: z.boolean(), recall: z.literal('unmeasured') }),
})
const versionOneSchema = artifactSchema.extend({ extraction_version: z.literal(1) })
const anyArtifactSchema = z.discriminatedUnion('extraction_version', [versionOneSchema, groundedArtifactSchema])
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

/** A version 1 artifact: Article, and Catalog without a recipe. */
export type KeiExpArtifact = z.infer<typeof versionOneSchema>
export type KeiExpGroundedArtifact = z.infer<typeof groundedArtifactSchema>
export type KeiExpGroundedEvidence = z.infer<typeof groundedEvidenceSchema>
export type KeiExpAnyArtifact = z.infer<typeof anyArtifactSchema>
export type KeiExpModelListing = z.infer<typeof modelListingSchema>
export type KeiExpIngestionModelListing = z.infer<typeof ingestionListingSchema>
export type KeiExpCall = z.infer<typeof callSchema>
export type KeiExpEvidence = z.infer<typeof evidenceSchema>
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
        const produced = artifact.data.extraction_version === 2
          ? `${artifact.data.segmentation.recipe.id}@${artifact.data.segmentation.recipe.version}`
          : null
        // kei-exp records the options it ran under; `models` is absent from an artifact of a run that chose none.
        const routed = artifact.data.options.models ?? null
        if (artifact.data.run_id !== request.runId || artifact.data.generation !== accepted.data.generation || artifact.data.strategy !== request.strategy || !isDeepStrictEqual(artifact.data.schema, request.schema) || produced !== recipe || !isDeepStrictEqual(routed, models))
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an artifact for different extraction inputs.')
        return artifact.data
      }
    },
  }
}
