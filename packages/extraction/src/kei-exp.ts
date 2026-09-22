import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ExtractionError } from './errors.js'
import type { ExtractionSchemaDefinition } from './schema.js'

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
  model: z.string().nullable(),
  // kei-exp writes `PROMPT_VERSION = 1`: a number, not a label.
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

export type KeiExpArtifact = z.infer<typeof artifactSchema>
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
  signal: AbortSignal
}>
export interface KeiExpClient {
  extract(request: KeiExpRequest): Promise<KeiExpArtifact>
}

export function createKeiExpClient({
  url,
  model = async () => null,
  fetch: fetchRequest = globalThis.fetch,
  pollIntervalMs = 1500,
}: {
  url: string
  model?: () => Promise<string | null>
  fetch?: typeof globalThis.fetch
  pollIntervalMs?: number
}): KeiExpClient {
  return {
    async extract(request) {
      const signal = AbortSignal.any([
        request.signal,
        AbortSignal.timeout(request.strategy === 'catalog' ? 3 * 60 * 60 * 1000 : 10 * 60 * 1000),
      ])
      const base = `${url.replace(/\/$/, '')}/api/runs/${encodeURIComponent(request.runId)}`
      const body = JSON.stringify({ schema: request.schema, options: { strategy: request.strategy, model: await model() } })
      async function read(endpoint: string, init: RequestInit): Promise<unknown> {
        for (;;) {
          signal.throwIfAborted()
          try {
            const response = await fetchRequest(endpoint, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
            if (response.status === 429 || response.status === 503) {
              await response.body?.cancel()
            } else {
              if (!response.ok) {
                await response.body?.cancel()
                throw new ExtractionError('extraction_failed', `kei-exp returned HTTP ${response.status}.`)
              }
              return await response.json()
            }
          } catch (error) {
            signal.throwIfAborted()
            if (error instanceof SyntaxError)
              throw new ExtractionError('invalid_model_output', 'kei-exp returned invalid JSON.', { cause: error })
            if (!(error instanceof TypeError) && !(error instanceof DOMException && ['TimeoutError', 'AbortError'].includes(error.name))) throw error
          }
          await delay(pollIntervalMs, undefined, { signal })
        }
      }
      const accepted = acceptedSchema.safeParse(await read(`${base}/extract`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }))
      if (!accepted.success || accepted.data.run_id !== request.runId)
        throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid extraction acknowledgement.')
      for (;;) {
        await delay(pollIntervalMs, undefined, { signal })
        const envelope = envelopeSchema.safeParse(await read(`${base}/extractions/${encodeURIComponent(accepted.data.id)}`, { method: 'GET' }))
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
        const artifact = artifactSchema.safeParse(envelope.data.result)
        if (!artifact.success)
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid extraction artifact.')
        if (artifact.data.run_id !== request.runId || artifact.data.generation !== accepted.data.generation || artifact.data.strategy !== request.strategy || !isDeepStrictEqual(artifact.data.schema, request.schema))
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an artifact for different extraction inputs.')
        return artifact.data
      }
    },
  }
}
