import { runGenerationScenario } from '../generationScenario.js'

/** Dies right after the generateSchema step checkpointed; a later run replays it without a call or a key (A14). */
export function run(context: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  return runGenerationScenario(context, 'after-step')
}
