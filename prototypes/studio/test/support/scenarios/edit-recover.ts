import { runOperationScenario } from '../operationScenario.js'

/** Killed by the test while the proposal's provider call is in flight; a later run recovers the proposal on its base (A2). */
export function run(context: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  return runOperationScenario(context, { kind: 'edit', kill: 'by-parent' })
}
