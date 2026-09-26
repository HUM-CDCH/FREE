/** The kei stand-in as a process (kei-stand-in-client.ts spawns it), with a control API under /control/ on its own
 *  server. Test-only: nothing in the runtime imports it.
 *
 *  Env: KEI_STAND_IN_DATABASE_URL, KEI_STAND_IN_SCHEMA, KEI_STAND_IN_PORT (0 = any; the chosen port is printed as
 *  `kei stand-in serving <port>` once launched) and KEI_STAND_IN_FIXTURE (a directory with a version 5 `result.json`
 *  and `pages/<n>.json`; Studio's test/fixtures/kei-exp by default). SIGTERM closes the stand-in and exits 0.
 *
 *  Control: POST /control/policy (a StandInPolicy, merged into the current one; both start `'auto'`), GET /control/held
 *  (the decisions a `'hold'` parked, as HeldWork) and POST /control/answer ({ workflowId } and a StandInAnswer), which
 *  releases one held decision and answers 404 when that workflow holds none. */
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { keiExpArtifact } from '../kei-exp-fixture.js'
import { KEI_FAILURE_CODES, type KeiConvertInput, type KeiExtractInput } from '../kei-handoff.js'
import { launchKeiStandIn, type StandInConversion, type StandInDecision } from './kei-stand-in.js'
import type { HeldWork, StandInAnswer, StandInPolicy } from './kei-stand-in-client.js'

const DEFAULT_FIXTURE = fileURLToPath(new URL('../../../../prototypes/studio/test/fixtures/kei-exp/', import.meta.url))
const failureSchema = z.object({ code: z.enum(KEI_FAILURE_CODES), reason: z.string(), retryable: z.boolean() }).strict()
const ruleSchema = z.union([z.enum(['auto', 'hold']), z.object({ failure: failureSchema }).strict()])
const policySchema = z.object({ convert: ruleSchema.optional(), extract: ruleSchema.optional() }).strict()
const answerSchema = z.union([
  z.object({ workflowId: z.string().min(1), artifact: z.unknown() }).strict(),
  z.object({ workflowId: z.string().min(1), failure: failureSchema }).strict(),
  z.object({ workflowId: z.string().min(1), convert: z.literal('auto') }).strict(),
])

type Held = HeldWork & { release(answer: StandInAnswer): boolean }

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Set ${name}.`)
  return value
}

/** The fixture run every `'auto'` conversion publishes: its manifest and its page files, read once. */
function readFixture(directory: string) {
  const manifest = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')) as Record<string, unknown>
  const pages = new Map<number, Uint8Array>()
  for (const name of readdirSync(join(directory, 'pages'))) {
    const page = /^([1-9][0-9]*)\.json$/.exec(name)
    if (page) pages.set(Number(page[1]), readFileSync(join(directory, 'pages', name)))
  }
  return { manifest, pages }
}

const fixture = readFixture(process.env.KEI_STAND_IN_FIXTURE ?? DEFAULT_FIXTURE)
let policy: Required<StandInPolicy> = { convert: 'auto', extract: 'auto' }
const held = new Map<string, Held>()

/** The stand-in plays kei, so it picks its own run ID rule; Studio reads the run ID from the output. */
function autoConversion(request: KeiConvertInput, workflowId: string): StandInDecision<StandInConversion> {
  const manifest = structuredClone(fixture.manifest)
  manifest.recipe = { ...(manifest.recipe as Record<string, unknown> | undefined), source_sha256: request.source_sha256 }
  const digest = createHash('sha256').update(workflowId).digest('hex')
  return { output: { runId: `stand-in-${digest.slice(0, 16)}`, manifest, pages: fixture.pages } }
}

function autoExtraction(request: KeiExtractInput): StandInDecision<{ artifact: unknown }> {
  const { schema, options } = request.request
  const model = 'fixture/nuextract'
  return {
    output: {
      artifact: keiExpArtifact({
        run_id: request.run_id,
        generation: request.generation,
        strategy: options.strategy === 'catalog' ? 'catalog' : 'article',
        schema: schema as { recordDescription: string; schemaNodes: unknown[] },
        options: { model: null, models: null, ...options },
        model,
        models: { fields: model, reasoning: model },
        complete: true,
        records: [],
        evidence: [],
        ungrounded: [],
      }),
    },
  }
}

function hold<T>(
  workflow: HeldWork['workflow'], workflowId: string, request: unknown, decide: (answer: StandInAnswer) => T | undefined,
): Promise<T> {
  return new Promise((resolve) => {
    held.set(workflowId, {
      workflowId, workflow, request,
      release(answer) {
        const decision = decide(answer)
        if (decision === undefined) return false
        held.delete(workflowId)
        resolve(decision)
        return true
      },
    })
  })
}

const standIn = await launchKeiStandIn({
  databaseUrl: required('KEI_STAND_IN_DATABASE_URL'),
  schema: required('KEI_STAND_IN_SCHEMA'),
  port: Number(process.env.KEI_STAND_IN_PORT ?? '0'),
  script: {
    async convert(request, workflowId) {
      const rule = policy.convert
      if (rule === 'auto') return autoConversion(request, workflowId)
      if (rule !== 'hold') return rule
      return hold('convert', workflowId, request, (answer) => {
        if ('failure' in answer) return { failure: answer.failure }
        if ('convert' in answer) return autoConversion(request, workflowId)
        return undefined
      })
    },
    async extract(request, workflowId) {
      const rule = policy.extract
      if (rule === 'auto') return autoExtraction(request)
      if (rule !== 'hold') return rule
      return hold('extract', workflowId, request, (answer) => {
        if ('failure' in answer) return { failure: answer.failure }
        if ('artifact' in answer) return { output: { artifact: answer.artifact } }
        return undefined
      })
    },
  },
  control,
})

async function control(request: IncomingMessage, response: ServerResponse) {
  const path = new URL(request.url ?? '/', 'http://kei-stand-in').pathname
  if (request.method === 'GET' && path === '/control/held')
    return send(response, 200, [...held.values()].map(({ workflowId, workflow, request: body }) => ({ workflowId, workflow, request: body })))
  if (request.method !== 'POST') return send(response, 404, { detail: 'Not Found' })
  if (path === '/control/policy') {
    const body = policySchema.safeParse(await json(request))
    if (!body.success) return send(response, 400, { detail: body.error.message })
    policy = { ...policy, ...body.data }
    return send(response, 200, policy)
  }
  if (path === '/control/answer') {
    const body = answerSchema.safeParse(await json(request))
    if (!body.success) return send(response, 400, { detail: body.error.message })
    const { workflowId, ...answer } = body.data
    const work = held.get(workflowId)
    if (!work) return send(response, 404, { detail: `${workflowId} holds no decision.` })
    if (!work.release(answer as StandInAnswer))
      return send(response, 400, { detail: `That answer does not finish a held ${work.workflow}.` })
    return send(response, 200, { workflowId })
  }
  return send(response, 404, { detail: 'Not Found' })
}

async function json(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

let stopping = false
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    if (stopping) return
    stopping = true
    standIn.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('The kei stand-in failed to stop:', error)
        process.exit(1)
      },
    )
  })
process.stdout.write(`kei stand-in serving ${new URL(standIn.readUrl).port}\n`)
