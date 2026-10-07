/** The DBOS statuses of named workflows; a workflow DBOS no longer holds is absent. A DBOS or store outage rejects:
 *  callers let it reach the handlers, which answer 503, never a fabricated status. */
export type WorkflowStatuses = (workflowIds: readonly string[]) => Promise<ReadonlyMap<string, string>>

const CHUNK = 500

/** One listWorkflows call per 500 IDs (spec: list endpoints read statuses in one call), without inputs or outputs. */
export function workflowStatusesOf(
  listWorkflows: (input: { workflowIDs: string[]; loadInput: false; loadOutput: false }) =>
    Promise<readonly { workflowID: string; status: string }[]>,
): WorkflowStatuses {
  return async (workflowIds) => {
    const statuses = new Map<string, string>()
    for (let start = 0; start < workflowIds.length; start += CHUNK)
      for (const status of await listWorkflows({
        workflowIDs: workflowIds.slice(start, start + CHUNK),
        loadInput: false,
        loadOutput: false,
      }))
        statuses.set(status.workflowID, status.status)
    return statuses
  }
}

/** The statuses of a workflow that may still write its outcome: work is active only while its workflow has one. */
export const LIVE_WORKFLOW_STATUSES: ReadonlySet<string> = new Set(['ENQUEUED', 'DELAYED', 'PENDING'])

export type UnsettledExecution = 'QUEUED' | 'RUNNING' | 'REREAD' | 'INTERRUPTED'

/**
 * How work stands while its row has no outcome (spec, *Status and ownership*). An outcome on the row always wins, so
 * callers ask only for rows without one. SUCCESS means the workflow wrote its outcome just now: re-read the row, and a
 * row that still has none is interrupted, never perpetually running. ERROR, CANCELLED, MAX_RECOVERY_ATTEMPTS_EXCEEDED
 * and a workflow gone after retention are interrupted too.
 */
export function executionOf(status: string | undefined): UnsettledExecution {
  switch (status) {
    case 'ENQUEUED':
    case 'DELAYED':
      return 'QUEUED'
    case 'PENDING':
      return 'RUNNING'
    case 'SUCCESS':
      return 'REREAD'
    default:
      return 'INTERRUPTED'
  }
}

/** What a researcher reads for work that stopped without an outcome. */
export const INTERRUPTED_FAILURE = Object.freeze({
  code: 'interrupted',
  message: 'This work stopped before it finished. Start it again.',
} as const)
