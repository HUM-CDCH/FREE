import { runOperationScenario } from '../operationScenario.js'

/** Killed by the test while the provider call is in flight; a later run recovers the generation (spec M5 acceptance A2, A7, A13). */
export function run(context: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  return runOperationScenario(context, { kind: 'generation', kill: 'by-parent' })
}
