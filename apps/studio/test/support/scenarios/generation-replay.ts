import { runOperationScenario } from '../operationScenario.js'

/** Dies right after the generateSchema step checkpointed; a later run replays it without a call or a key (A14). */
export function run(context: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  return runOperationScenario(context, { kind: 'generation', kill: 'after-step' })
}
