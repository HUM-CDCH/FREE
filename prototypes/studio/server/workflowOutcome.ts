import { setTimeout as delay } from 'node:timers/promises'
import type { DBOSClient } from '@dbos-inc/dbos-sdk'

const TERMINAL = new Set(['SUCCESS', 'ERROR', 'CANCELLED', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'])

export type AwaitedWorkflow<T> =
  | { state: 'finished'; output: T }
  | { state: 'stopped'; status: string }
  | { state: 'timed-out' }

/** Waits for a workflow without ClientHandle.getResult, which cannot time out and would keep polling after the caller
 *  gave up. Reads the status every `intervalMs` until it is terminal, the deadline passes or `signal` aborts; an abort
 *  rejects with the signal's reason whether it arrives before a read or between two. */
export async function awaitWorkflowOutcome<T>(
  client: Pick<DBOSClient, 'listWorkflows'>,
  workflowId: string,
  options: { timeoutMs: number; signal?: AbortSignal; intervalMs?: number; now?: () => number },
): Promise<AwaitedWorkflow<T>> {
  const now = options.now ?? Date.now
  const deadline = now() + options.timeoutMs
  for (;;) {
    options.signal?.throwIfAborted()
    const [status] = await client.listWorkflows({ workflowIDs: [workflowId], loadInput: false, loadOutput: true })
    if (!status) return { state: 'stopped', status: 'MISSING' }
    if (status.status === 'SUCCESS') return { state: 'finished', output: status.output as T }
    if (TERMINAL.has(status.status)) return { state: 'stopped', status: status.status }
    const remaining = deadline - now()
    if (remaining <= 0) return { state: 'timed-out' }
    await delay(Math.min(options.intervalMs ?? 500, remaining), undefined, { signal: options.signal }).catch(
      (error: unknown) => {
        // The timer rejects with a generic AbortError; report the caller's own reason instead.
        options.signal?.throwIfAborted()
        throw error
      },
    )
  }
}
