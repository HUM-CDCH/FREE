import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { ExtractionError } from './errors.js'
import type { ExtractionSchemaDefinition } from './schema.js'

const path = z.array(z.union([z.string(), z.number().int().nonnegative()]))
const artifactSchema = z.object({
  extraction_version: z.number().int().positive(),
  run_id: z.string().min(1),
  generation: z.string().min(1),
  digest: z.string(),
  fingerprint: z.string(),
  strategy: z.enum(['catalog', 'article']),
  model: z.string().nullable(),
  prompt_version: z.string(),
  schema: z.object({ recordDescription: z.string(), schemaNodes: z.array(z.unknown()) }),
  options: z.record(z.string(), z.unknown()),
  started: z.string(),
  seconds: z.number().nonnegative(),
  complete: z.boolean(),
  records: z.array(z.record(z.string(), z.unknown())),
  evidence: z.array(z.object({
    path,
    segment: z.string().regex(/^p\d+_s\d+$/),
    page: z.number().int().positive(),
    bbox_pt: z.tuple([z.number(), z.number(), z.number(), z.number()]).nullable(),
    verbatim: z.boolean(),
    hits: z.number().int().nonnegative(),
    linked_by: z.enum(['lexical', 'model']),
  })),
  ungrounded: z.array(path),
  issues: z.array(z.object({ code: z.string(), detail: z.string(), record: z.number().int().nullable(), path: path.nullable() })),
  calls: z.number().int().nonnegative(),
  tokens: z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() }),
})
const acceptedSchema = z.object({ id: z.string().min(1), run_id: z.string(), status: z.literal('queued'), generation: z.string().min(1) })

export type KeiExpArtifact = z.infer<typeof artifactSchema>
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
        const raw = await read(`${base}/extractions/${encodeURIComponent(accepted.data.id)}`, { method: 'GET' })
        const status = z.object({ status: z.enum(['queued', 'running']) }).safeParse(raw)
        if (status.success) continue
        const artifact = artifactSchema.safeParse(raw)
        if (!artifact.success)
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an invalid or failed extraction artifact.')
        if (artifact.data.run_id !== request.runId || artifact.data.generation !== accepted.data.generation || artifact.data.strategy !== request.strategy || !isDeepStrictEqual(artifact.data.schema, request.schema))
          throw new ExtractionError('invalid_model_output', 'kei-exp returned an artifact for different extraction inputs.')
        return artifact.data
      }
    },
  }
}
