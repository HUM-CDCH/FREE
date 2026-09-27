/** A TypeScript kei for tests: a DBOS application named `kei` that plays kei's worker at the contract
 *  (prototypes/parsing_service/src/kei_exp/workflows/) and serves kei's read routes (kei_exp/api.py).
 *
 *  It registers kei's portable `convert`, `extract` and `deleteRuns` workflows under kei's names, with kei's recovery
 *  limit, and kei's four lanes with kei's limits. Each workflow runs one step (`convert_run`, `extract_run`,
 *  `delete_runs`, as kei names its own) that asks `script` how to finish. A decision the script holds blocks inside the
 *  step, as kei's native step does, so a cancel leaves the step running and its lane occupied until the step returns
 *  (M0R 4).
 *
 *  Its default `deleteRuns` diverges from kei's gc.py on purpose: it ignores kei's 24-hour run age and the boot boundary.
 *  A named conversion or history ID whose workflow ended (SUCCESS or ERROR) or is already gone is deleted, a deleted
 *  conversion's run (the one its output named) is forgotten, and everything else is kept. Every valid request is
 *  recorded (`deleteRunsRequests`) so a test can see what Studio asked for.
 *
 *  Test-only: nothing in the runtime imports it. DBOS is one singleton per process, so the stand-in runs only where no
 *  other DBOS application runs; a test process whose DBOS is Studio's spawns it (kei-stand-in-client.ts). */
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { DBOS } from '@dbos-inc/dbos-sdk'
import {
  DELETE_RUNS, KEI_APPLICATION, KEI_QUEUE, KEI_RUN_ID, keiConvertInputSchema, keiConvertOkSchema,
  keiDeleteRunsInputSchema, keiExtractInputSchema, keiExtractWorkflowId, type KeiConvertInput, type KeiDeleteRunsInput,
  type KeiDeleteRunsOk, type KeiExtractInput, type KeiFailureCode,
} from '../kei-handoff.js'

export type StandInFailure = { code: KeiFailureCode; reason: string; retryable: boolean }
export type StandInDecision<T> = { output: T } | { failure: StandInFailure }
export type StandInConversion = { runId: string; manifest: Record<string, unknown>; pages: ReadonlyMap<number, Uint8Array> }
export type KeiStandInScript = {
  convert?(request: KeiConvertInput, workflowId: string): Promise<StandInDecision<StandInConversion>>
  extract?(request: KeiExtractInput, workflowId: string): Promise<StandInDecision<{ artifact: unknown }>>
  /** Replaces the default cleanup (see the module comment). */
  deleteRuns?(request: KeiDeleteRunsInput, workflowId: string): Promise<KeiDeleteRunsOk>
}
/** A `deleteRuns` request as the stand-in received it. */
export type KeiDeleteRunsRequest = { workflowId: string; request: KeiDeleteRunsInput; receivedAtMs: number }
/** Answers a request under `/control/` on the stand-in's own server (the CLI's control API), so a test never needs a
 *  second port. */
export type KeiStandInControl = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
export type KeiStandIn = Readonly<{
  readUrl: string
  /** Every valid `deleteRuns` request, in the order the stand-in received them. */
  deleteRunsRequests(): readonly KeiDeleteRunsRequest[]
  close(): Promise<void>
}>

/** kei's config.QUEUES: global limit == worker limit. */
const LANES = { [KEI_QUEUE.convertLarge]: 1, [KEI_QUEUE.convertSmall]: 1, [KEI_QUEUE.extract]: 2, [KEI_QUEUE.gc]: 1 }
/** kei's config.MAX_RECOVERY_ATTEMPTS. */
const MAX_RECOVERY_ATTEMPTS = 5
/** Workflows that ended with their steps (kei's gc.ENDED); the stand-in keeps every other status. */
const ENDED = new Set(['SUCCESS', 'ERROR'])
/** The listings kei's GET /api/extraction-models and /api/ingestion-models answer, as the canonical spec shows them. */
const EXTRACTION_MODELS = {
  defaults: { fields: 'instruct', reasoning: 'instruct' },
  models: [{ key: 'instruct', repo: 'fixture/nuextract', roles: ['fields', 'reasoning'], reachable: true, serving: true }],
}
const INGESTION_MODELS = {
  defaults: { ocr: 'surya', layout: 'layout_heron_101' },
  models: {
    ocr: [{ key: 'surya', label: 'Surya', serving: true }],
    layout: [{ key: 'layout_heron_101', label: 'Heron 101', serving: true }],
  },
}

export async function launchKeiStandIn(options: {
  databaseUrl: string
  schema: string
  port: number
  script: KeiStandInScript
  executorId?: string
  control?: KeiStandInControl
}): Promise<KeiStandIn> {
  if (DBOS.isInitialized()) throw new Error('The kei stand-in needs a process without another DBOS application.')
  const results = new Map<string, { manifest: Record<string, unknown>; pages: ReadonlyMap<number, Uint8Array> }>()
  const artifacts = new Map<string, Uint8Array>() // `${runId}/${extractionId}`
  const deleteRunsRequests: KeiDeleteRunsRequest[] = []
  const fail = (code: KeiFailureCode, reason: string) => ({ ok: false, code, reason, retryable: false })
  DBOS.registerWorkflow(async (raw: unknown) => {
    const workflowId = DBOS.workflowID!
    return DBOS.runStep(async () => {
      const request = keiConvertInputSchema.safeParse(raw)
      if (!request.success) return fail('invalid_request', request.error.message)
      const decision = await options.script.convert?.(request.data, workflowId)
      if (!decision) return fail('conversion_failed', 'The stand-in has no conversion script.')
      if ('failure' in decision) return { ok: false, ...decision.failure }
      const { runId, manifest, pages } = decision.output
      if (!KEI_RUN_ID.test(runId)) throw new Error(`Invalid run ID ${JSON.stringify(runId)}`)
      results.set(runId, { manifest, pages })
      return {
        ok: true, run_id: runId, generation: String(manifest.generation), page_count: pages.size,
        source_sha256: request.data.source_sha256, page_source: request.data.page_source,
      }
    }, { name: 'convert_run' })
  }, { name: 'convert', serialization: 'portable', maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS })
  DBOS.registerWorkflow(async (raw: unknown) => {
    const workflowId = DBOS.workflowID!
    return DBOS.runStep(async () => {
      const extractionId = workflowId.slice(keiExtractWorkflowId('').length)
      const request = keiExtractInputSchema.safeParse(raw)
      if (!request.success || !workflowId.startsWith(keiExtractWorkflowId('')) || !KEI_RUN_ID.test(extractionId))
        return fail('invalid_request', 'The extract input or workflow ID is outside the contract.')
      const decision = await options.script.extract?.(request.data, workflowId)
      if (!decision) return fail('extraction_failed', 'The stand-in has no extraction script.')
      if ('failure' in decision) return { ok: false, ...decision.failure }
      const bytes = new TextEncoder().encode(JSON.stringify(decision.output.artifact))
      artifacts.set(`${request.data.run_id}/${extractionId}`, bytes)
      const artifact = decision.output.artifact as { generation: string; model: string; models: Record<string, string> }
      return {
        ok: true, run_id: request.data.run_id, extraction_id: extractionId, generation: artifact.generation,
        artifact_sha256: createHash('sha256').update(bytes).digest('hex'), model: artifact.model, models: artifact.models,
      }
    }, { name: 'extract_run' })
  }, { name: 'extract', serialization: 'portable', maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS })
  /** The default cleanup. DBOS runs listWorkflows and deleteWorkflows directly inside a step (runInternalStep). */
  async function deleteRuns(request: KeiDeleteRunsInput): Promise<KeiDeleteRunsOk> {
    const conversions = [...new Set(request.conversions)]
    const history = [...new Set(request.history)]
    const named = [...new Set([...history, ...conversions])]
    const statuses = new Map(named.length === 0 ? [] : (
      await DBOS.listWorkflows({ workflowIDs: named, loadInput: false, loadOutput: true })
    ).map((status) => [status.workflowID, status]))
    const ended = (workflowId: string) => {
      const status = statuses.get(workflowId)
      return status === undefined || ENDED.has(status.status) // an absent one's history is already gone, as in kei
    }
    const runOf = (workflowId: string) => {
      const output = keiConvertOkSchema.safeParse(statuses.get(workflowId)?.output)
      return output.success ? output.data.run_id : undefined
    }
    const deletedHistory = [...history, ...conversions].filter(ended)
    if (deletedHistory.length > 0) await DBOS.deleteWorkflows(deletedHistory)
    const deletedRuns: string[] = []
    const keptRuns: string[] = []
    for (const conversion of conversions) {
      const run = runOf(conversion)
      if (run === undefined) continue
      if (!ended(conversion)) {
        keptRuns.push(run)
        continue
      }
      results.delete(run)
      for (const key of artifacts.keys()) if (key.startsWith(`${run}/`)) artifacts.delete(key)
      deletedRuns.push(run)
    }
    return {
      ok: true, deleted_runs: deletedRuns, kept_runs: keptRuns, deleted_history: deletedHistory,
      kept_history: [...history, ...conversions].filter((workflowId) => !deletedHistory.includes(workflowId)),
    }
  }
  DBOS.registerWorkflow(async (raw: unknown) => {
    const workflowId = DBOS.workflowID!
    const request = keiDeleteRunsInputSchema.safeParse(raw)
    if (!request.success) return fail('invalid_request', request.error.message)
    deleteRunsRequests.push({ workflowId, request: request.data, receivedAtMs: Date.now() })
    return DBOS.runStep(
      async () => (options.script.deleteRuns ?? deleteRuns)(request.data, workflowId),
      { name: 'delete_runs' },
    )
  }, { name: DELETE_RUNS, serialization: 'portable', maxRecoveryAttempts: MAX_RECOVERY_ATTEMPTS })
  DBOS.setConfig({
    name: KEI_APPLICATION, systemDatabaseUrl: options.databaseUrl, systemDatabaseSchemaName: options.schema,
    applicationVersion: 'kei@1', executorID: options.executorId ?? 'kei-stand-in', enableOTLP: false, logLevel: 'error',
  })
  // kei's read routes (M3 Task 10): the model listings, a run's manifest and pages, and a published extraction artifact.
  const server = createServer((request, response) => {
    void route(request, response).catch(() => {
      if (response.headersSent) response.destroy()
      else send(response, 500, { detail: 'The kei stand-in failed on this request.' })
    })
  })
  async function route(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url ?? '/', 'http://kei-stand-in').pathname
    if (path.startsWith('/control/') && options.control) return options.control(request, response)
    if (request.method !== 'GET') return send(response, 404, { detail: 'Not Found' })
    if (path === '/api/models') return send(response, 200, []) // kei answers a list (api.py list_models)
    if (path === '/api/extraction-models') return send(response, 200, EXTRACTION_MODELS)
    if (path === '/api/ingestion-models') return send(response, 200, INGESTION_MODELS)
    const [api, runs, run, kind, item, ...rest] = path.split('/').slice(1)
    if (api !== 'api' || runs !== 'runs' || run === undefined || !KEI_RUN_ID.test(run))
      return send(response, 404, { detail: 'no such run' })
    if (kind === 'result' && item === undefined) {
      const manifest = results.get(run)?.manifest
      return manifest ? send(response, 200, manifest) : send(response, 404, { detail: 'no result yet' })
    }
    if (kind === 'pages' && item !== undefined && rest.length === 0 && /^[1-9][0-9]*$/.test(item)) {
      const page = results.get(run)?.pages.get(Number(item))
      return page ? sendBytes(response, page) : send(response, 404, { detail: 'no result for this page yet' })
    }
    if (kind === 'extractions' && item !== undefined && rest.length === 0 && KEI_RUN_ID.test(item)) {
      const artifact = artifacts.get(`${run}/${item}`)
      return artifact ? sendBytes(response, artifact) : send(response, 404, { detail: 'no such extraction' })
    }
    return send(response, 404, { detail: 'Not Found' })
  }
  try {
    await DBOS.launch()
    // Queues live in the system database, so they are registered after launch; only kei registers kei's lanes.
    for (const [name, limit] of Object.entries(LANES))
      await DBOS.registerQueue(name, { globalConcurrency: limit, workerConcurrency: limit, minPollingIntervalMs: 100 })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    // Leave the process as it was, so the startup error is the one reported and a retry can launch afresh.
    await DBOS.shutdown({ deregister: true }).catch(() => undefined)
    throw error
  }
  const port = (server.address() as { port: number }).port
  return {
    readUrl: `http://127.0.0.1:${port}`,
    deleteRunsRequests: () => [...deleteRunsRequests],
    async close() {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections()
      await closed
      // Deregistering lets a test process launch the stand-in again; production never relaunches in-process (F2).
      await DBOS.shutdown({ deregister: true })
    },
  }
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** A published file, byte for byte, as kei's FileResponse serves it. */
function sendBytes(response: ServerResponse, bytes: Uint8Array) {
  response.writeHead(200, { 'content-type': 'application/json', 'content-length': bytes.byteLength })
  response.end(bytes)
}
