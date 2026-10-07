import { DBOS, Error as DBOSErrors, type StepConfig } from '@dbos-inc/dbos-sdk'

/** The DBOS surface a workflow body uses, so its sequence is testable without DBOS. */
export type WorkflowSteps = Readonly<{
  step<T>(name: string, run: () => Promise<T>, config?: StepConfig): Promise<T>
  /** DBOS.stepStatus.cancelSignal inside a step (it fires about 1 s after a cancel); undefined outside one. */
  cancelSignal(): AbortSignal | undefined
}>
export const dbosSteps: WorkflowSteps = {
  step: (name, run, config) => DBOS.runStep(run, { ...config, name }),
  cancelSignal: () => DBOS.stepStatus?.cancelSignal,
}

/** A read of a published artifact that another attempt may get through (kei's API restarting). Ingestion and
 *  reprocessing reuse it for their manifest and page reads. */
export const ARTIFACT_READ_RETRY: StepConfig = {
  retriesAllowed: true, intervalSeconds: 5, backoffRate: 2, maxAttempts: 3,
  shouldRetry: (error) => error instanceof TypeError || (error as { transient?: unknown })?.transient === true,
}

export function isWorkflowCancellation(error: unknown): boolean {
  return error instanceof DBOSErrors.DBOSWorkflowCancelledError || error instanceof DBOSErrors.DBOSAwaitedWorkflowCancelledError
}
