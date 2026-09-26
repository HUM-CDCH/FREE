import { isDeepStrictEqual } from 'node:util'
import type { DBOSClient } from '@dbos-inc/dbos-sdk'
import { INTERRUPTED_FAILURE } from 'db'
import { awaitWorkflowOutcome, STUDIO_QUEUE } from '../server/dbos.js'
import { ApiError, persistenceUnavailable } from './_http.js'

/** One model call's limit (spec: each call keeps a 10-minute timeout). */
export const MODEL_OPERATION_TIMEOUT_MS = 600_000
/** How long a handler waits for its operation: an edit's two calls plus the 60 s key wait. */
export const OPERATION_WAIT_MS = 25 * 60_000

export type OperationFailure = Readonly<{ status: number; code: string; message: string }>
export type OperationResult<T extends object> = ({ ok: true } & T) | ({ ok: false } & OperationFailure)
export type ModelOperationClient = Pick<DBOSClient, 'enqueue' | 'getWorkflow' | 'listWorkflows' | 'cancelWorkflow' | 'deleteWorkflows'>
export type OperationStart<I> = Readonly<{
  workflowName: string
  workflowID: string
  /** The Project Context owner: recorded as authenticatedUser, which locates the scope but never authorizes it. */
  owner: string
  attributes: Readonly<Record<string, string | null>>
  input: I
}>

/** What a model step returns instead of throwing (spec, *Typed results*): an ApiError's own status, code and copy —
 *  FREE's words — and nothing else. A step that rethrew would hand a provider error's cause to DBOS's serializer. */
export function operationFailureOf(error: unknown): OperationFailure {
  if (error instanceof ApiError) return { status: error.status, code: error.code, message: error.message.slice(0, 512) }
  return { status: 500, code: 'unexpected_failure', message: 'An unexpected failure occurred.' }
}

const unavailable = (cause: unknown) => persistenceUnavailable(cause, 'Model operations are unavailable.')

/**
 * Workflow-first admission (spec, *No-row operations*): enqueue by name on the studio queue. A reused workflow ID
 * returns the existing workflow (DBOS's default reuse policy), so the recorded input decides: the same request joins
 * it, anything else is 409 — a confirmed failure needs a new operation ID (spec, *Client IDs*).
 */
export async function startOrJoinOperation<I>(client: ModelOperationClient, start: OperationStart<I>): Promise<void> {
  let recorded: Awaited<ReturnType<ModelOperationClient['getWorkflow']>>
  try {
    await client.enqueue({
      queueName: STUDIO_QUEUE,
      workflowName: start.workflowName,
      workflowID: start.workflowID,
      authenticatedUser: start.owner,
      attributes: { ...start.attributes },
    }, start.input)
    recorded = await client.getWorkflow(start.workflowID)
  } catch (cause) {
    throw unavailable(cause)
  }
  if (!recorded || recorded.workflowName !== start.workflowName || !isDeepStrictEqual(recorded.input?.[0], start.input))
    throw new ApiError(409, 'operation_conflict', 'This operation ID was already used for a different request. Start a new one.')
}

/** Waits for the operation's typed result without ClientHandle.getResult, which cannot time out. A client abort ends
 *  the wait only: the workflow runs on and a reloaded page finds it (spec, *A client abort only detaches*). */
export async function awaitOperation<T extends object>(
  client: ModelOperationClient,
  workflowID: string,
  signal: AbortSignal | undefined,
  waitMs = OPERATION_WAIT_MS,
): Promise<OperationResult<T>> {
  let awaited
  try {
    awaited = await awaitWorkflowOutcome<OperationResult<T>>(client, workflowID, { timeoutMs: waitMs, signal, intervalMs: 250 })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw unavailable(cause)
  }
  if (awaited.state === 'finished') return awaited.output
  if (awaited.state === 'timed-out')
    return { ok: false, status: 504, code: 'operation_pending', message: 'The operation is still running. Reload the page to see it when it finishes.' }
  if (awaited.status === 'CANCELLED') return { ok: false, status: 409, code: 'operation_cancelled', message: 'The operation was stopped.' }
  return { ok: false, status: 500, ...INTERRUPTED_FAILURE }
}
