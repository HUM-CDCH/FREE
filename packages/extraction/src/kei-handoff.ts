import { setTimeout as delay } from 'node:timers/promises'
import type { DBOSClient, StepConfig } from '@dbos-inc/dbos-sdk'
import { context, propagation } from '@opentelemetry/api'
import { z } from 'zod'

/** kei's lanes, priorities and identities (apps/parsing_service/src/kei_exp/workflows/config.py and contracts.py;
 *  pinned by tests/fixtures/contracts/). kei registers the queues; Studio only names one. */
export const KEI_APPLICATION = 'kei'
export const KEI_QUEUE = {
  convertLarge: 'kei-convert-large', convertSmall: 'kei-convert-small', extract: 'kei-extract', gc: 'kei-gc',
} as const
export const KEI_PRIORITY = { interactive: 1, batch: 10 } as const
/** A conversion lane runs one job at a time, so every conversion goes at one constant priority (kei refuses 0). */
export const CONVERSION_PRIORITY = KEI_PRIORITY.interactive
/** At most this many pages convert on kei-convert-small, beside a book on kei-convert-large (decision 14). */
export const SMALL_DOCUMENT_PAGES = 30
/** kei's page limit (KEI_MAX_PAGES): the budget of a PDF whose pages pdf.js could not count. */
export const UNCOUNTED_PAGE_BUDGET = 2000
const CONVERT_PREFIX = 'kei-convert:'
export const DELETE_RUNS = 'deleteRuns'
export const GC_PREFIX = 'kei-gc:'
/** One path component, kei's runs.COMPONENT; `$` without the m flag matches only at the very end in JavaScript. */
export const KEI_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const KEI_PREPROCESS = /^kei-exp:([A-Za-z0-9][A-Za-z0-9._-]*):([^:\s]+)$/

/** The kei run and parse generation a Source Representation Revision was made from (`kei-exp:<run>:<generation>`,
 *  written by ingestion from kei's convert output). Studio reads the run ID; it never derives one. */
export function keiRunOf(preprocessId: string): { runId: string; generation: string } | null {
  const match = KEI_PREPROCESS.exec(preprocessId)
  return match && KEI_RUN_ID.test(match[1]!) ? { runId: match[1]!, generation: match[2]! } : null
}

export type ConversionLane = typeof KEI_QUEUE.convertLarge | typeof KEI_QUEUE.convertSmall

/** The lane is fixed at admission from the page count and recorded in the workflow input, so recovery keeps it. A PDF
 *  pdf.js cannot open (null) goes to the large lane; kei's PDFium still decides whether it is readable. */
export function conversionLane(pages: number | null): ConversionLane {
  return pages !== null && pages <= SMALL_DOCUMENT_PAGES ? KEI_QUEUE.convertSmall : KEI_QUEUE.convertLarge
}

/** M0R 4: max(10 min, 60 s + 18.9 s × pages), provisional until the ~2000-page Spark run. */
export function conversionTimeoutMs(pages: number | null): number {
  return Math.max(600_000, 3 * (20_000 + 6_300 * (pages ?? UNCOUNTED_PAGE_BUDGET)))
}

export const keiConvertWorkflowId = (parentWorkflowId: string) => `${CONVERT_PREFIX}${parentWorkflowId}`
/** One kei cleanup per sweep: re-enqueueing the same ID is a no-op in every state (M0 #1), so a recovered sweep asks once. */
export const keiGcWorkflowId = (scheduledTime: Date) => `${GC_PREFIX}${scheduledTime.toISOString()}`

const runId = z.string().regex(KEI_RUN_ID)
const sha256 = z.string().regex(/^[0-9a-f]{64}$/)
const pageSource = z.enum(['pdf', 'ingest'])
export const keiConvertInputSchema = z.object({
  source: z.string().min(1), source_sha256: sha256, source_name: z.string().min(1).max(512), page_source: pageSource,
  ingest: z.record(z.string(), z.unknown()).nullable(), model: z.string().min(1).nullable(),
  layout_model: z.string().min(1).nullable(), cut: z.enum(['auto', 'none']), debug: z.boolean(),
}).strict()
export const keiConvertOkSchema = z.object({
  ok: z.literal(true), run_id: runId, generation: z.string().min(1), page_count: z.number().int().positive(),
  source_sha256: sha256, page_source: pageSource,
}).strict()
/** Studio names conversions, never runs: kei derives each run from its conversion and deletes the conversion's history
 *  only once the run is gone, since that history is the only index through which Studio can name the run. */
export const keiDeleteRunsInputSchema = z.object({
  conversions: z.array(z.string().regex(/^kei-convert:.+$/)),
  history: z.array(z.string().min(1).refine((id) => !id.startsWith(CONVERT_PREFIX),
    "A conversion's history goes with its run: name it under conversions.")),
}).strict()
export const keiDeleteRunsOkSchema = z.object({
  ok: z.literal(true), deleted_runs: z.array(z.string()), kept_runs: z.array(z.string()),
  deleted_history: z.array(z.string()), kept_history: z.array(z.string()),
}).strict()
export const KEI_FAILURE_CODES = [
  'invalid_request', 'source_missing', 'source_mismatch', 'source_unreadable', 'too_many_pages', 'model_unavailable',
  'conversion_failed', 'conversion_incomplete', 'cancelled',
] as const
export const keiFailureSchema = z.object({
  ok: z.literal(false), code: z.enum(KEI_FAILURE_CODES), reason: z.string(), retryable: z.boolean(),
}).strict()
export type KeiConvertInput = z.infer<typeof keiConvertInputSchema>
export type KeiConvertOk = z.infer<typeof keiConvertOkSchema>
export type KeiDeleteRunsInput = z.infer<typeof keiDeleteRunsInputSchema>
export type KeiDeleteRunsOk = z.infer<typeof keiDeleteRunsOkSchema>
export type KeiFailureCode = (typeof KEI_FAILURE_CODES)[number]

export type KeiSubmission = Readonly<{
  workflow: 'convert'
  workflowId: string
  queueName: string
  priority: number
  timeoutMs: number
  request: KeiConvertInput
  authenticatedUser: string
  /** The parent's attributes, so a scope's kei work is found like its Studio work. */
  attributes: Readonly<Record<string, unknown>>
}>
export type KeiPoll =
  | { state: 'live' }
  | { state: 'missing' }
  | { state: 'SUCCESS'; output: unknown }
  | { state: 'ERROR' | 'CANCELLED' | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'; deadlinePassed: boolean }
export type KeiHandoff = Readonly<{
  /** Enqueues the child; reusing its deterministic ID returns the existing workflow in every state (M0 #1). */
  submit(submission: KeiSubmission): Promise<void>
  /** Reads the child every pollIntervalMs for at most pollWindowMs (M0 #2); an aborted signal rejects at once. */
  poll(workflowId: string, signal?: AbortSignal): Promise<KeiPoll>
  /** Cancels the child only while it is live: a repeated cancel moves a cancelled workflow's updated_at (M0R 4). */
  cancel(workflowId: string): Promise<void>
  /** Enqueues kei's `deleteRuns` under `workflowId` (keiGcWorkflowId); a request outside the contract throws. */
  requestDeleteRuns(workflowId: string, request: KeiDeleteRunsInput): Promise<void>
}>

/** The submitting step's trace, where kei's DBOS reads it on dequeue and recovery (dbos-transact-py's
 *  PropagateOtelContext attribute), so kei's spans join Studio's trace. Nothing while Studio does not trace. */
function traceCarrier(): Record<string, unknown> {
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  return Object.keys(carrier).length ? { 'dbos.otelContext': carrier } : {}
}

const LIVE = new Set(['ENQUEUED', 'DELAYED', 'PENDING'])
const STOPPED = new Set(['ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])

export function createKeiHandoff(
  client: Pick<DBOSClient, 'enqueuePortable' | 'listWorkflows' | 'cancelWorkflow'>,
  options: { pollWindowMs?: number; pollIntervalMs?: number; now?: () => number } = {},
): KeiHandoff {
  const windowMs = options.pollWindowMs ?? 30_000
  const intervalMs = options.pollIntervalMs ?? 2_000
  const now = options.now ?? Date.now
  const status = async (workflowId: string, loadOutput: boolean) =>
    (await client.listWorkflows({ workflowIDs: [workflowId], loadInput: false, loadOutput }))[0]
  return {
    async submit(submission) {
      await client.enqueuePortable(
        {
          workflowName: submission.workflow,
          queueName: submission.queueName,
          workflowID: submission.workflowId,
          priority: submission.priority,
          workflowTimeoutMS: submission.timeoutMs,
          applicationName: KEI_APPLICATION, // unowned rows could be dequeued by any application (M0R 3)
          authenticatedUser: submission.authenticatedUser,
          attributes: { ...submission.attributes, ...traceCarrier() },
        },
        [submission.request],
      )
    },
    async poll(workflowId, signal) {
      const deadline = now() + windowMs
      for (;;) {
        signal?.throwIfAborted()
        const current = await status(workflowId, true)
        if (!current) return { state: 'missing' }
        if (current.status === 'SUCCESS') return { state: 'SUCCESS', output: current.output }
        if (STOPPED.has(current.status))
          return {
            state: current.status as 'ERROR' | 'CANCELLED' | 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
            // kei stamps a deadline cancel with the database clock (M0R 4); a live parent reads it right after.
            deadlinePassed: current.deadlineEpochMS !== undefined && (current.updatedAt ?? now()) >= current.deadlineEpochMS,
          }
        const remaining = deadline - now()
        if (remaining <= 0) return { state: 'live' }
        await delay(Math.min(intervalMs, remaining), undefined, { signal })
      }
    },
    async cancel(workflowId) {
      const current = await status(workflowId, false)
      if (current && LIVE.has(current.status)) await client.cancelWorkflow(workflowId)
    },
    async requestDeleteRuns(workflowId, request) {
      keiDeleteRunsInputSchema.parse(request)
      // Only kei registers kei-gc (spec, *Ownership*); the client names kei's application so only kei dequeues it.
      await client.enqueuePortable(
        { workflowName: DELETE_RUNS, queueName: KEI_QUEUE.gc, workflowID: workflowId, applicationName: KEI_APPLICATION },
        [request],
      )
    },
  }
}

export type KeiOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; code: KeiFailureCode | 'deadline_exceeded' | 'stopped' | 'invalid_output'; reason: string; retryable: boolean }

export function settleKei<T>(poll: Exclude<KeiPoll, { state: 'live' }>, okSchema: z.ZodType<T>): KeiOutcome<T> {
  if (poll.state === 'SUCCESS') {
    const ok = okSchema.safeParse(poll.output)
    if (ok.success) return { ok: true, value: ok.data }
    const failed = keiFailureSchema.safeParse(poll.output)
    if (failed.success)
      return { ok: false, code: failed.data.code, reason: failed.data.reason, retryable: failed.data.retryable }
    return { ok: false, code: 'invalid_output', reason: 'The Parsing Service answered outside its contract.', retryable: false }
  }
  if (poll.state === 'CANCELLED')
    return poll.deadlinePassed
      ? { ok: false, code: 'deadline_exceeded', reason: 'The Parsing Service stopped the work at its deadline.', retryable: false }
      : { ok: false, code: 'cancelled', reason: 'The Parsing Service work was cancelled.', retryable: false }
  return {
    ok: false, code: 'stopped', reason: 'The Parsing Service stopped this work.',
    retryable: poll.state === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED',
  }
}

/** 57P01 (admin_shutdown) ends a query in flight while PostgreSQL restarts; 57P03 refuses the next connection. */
const NOT_READY = new Set(['42P01', '3F000', '57P01', '57P03', 'ECONNREFUSED', 'ECONNRESET'])
/** pg's own errors for a connection the server dropped mid-query ("Connection terminated unexpectedly") carry no code. */
const CONNECTION_TERMINATED = /^Connection terminated\b/

/** kei has not migrated kei_dbos yet (it starts after Studio is healthy), or the database is restarting. The walk is
 *  bounded, so a cause chain with a cycle ends. */
export function keiNotReady(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && NOT_READY.has(code)) return true
    if (code === undefined && current instanceof Error && CONNECTION_TERMINATED.test(current.message)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/** submitToKei retries until kei has migrated kei_dbos (spec, *Target architecture*): 5 s apart, for 10 minutes. */
export const SUBMIT_TO_KEI_RETRY: StepConfig = {
  retriesAllowed: true, intervalSeconds: 5, backoffRate: 1, maxAttempts: 120, shouldRetry: keiNotReady,
}
