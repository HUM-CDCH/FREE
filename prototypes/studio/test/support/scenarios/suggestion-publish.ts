import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { registerBatchSuggestionWorkflow } from '../../../api/_batch_suggestion_workflow.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { scriptedGenerate, suggestionPorts, suggestionResearcherStore } from '../suggestionWorkflow.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The suggestion-publish scenario needs ${name}.`)
  return value
}

/**
 * Studio with suggestSchemaBatch on its own DBOS schemas and a scripted model. The first run creates a Batch Schema
 * Suggestion over FREE_TEST_SOURCES and dies (SIGKILL) right after its publication commits, before DBOS checkpoints the
 * step. A later run recovers the attempt, whose repeated publication finds the outcome and writes nothing.
 */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const packages = createCanonicalPackageStore(required(env, 'FREE_TEST_PACKAGE_ROOT'))
  const ports = () =>
    suggestionPorts(packages, scriptedGenerate(required(env, 'FREE_TEST_MODEL_LOG')), (store) => ({
      ...store,
      async publish(id, attempt, result) {
        const written = await store.publish(id, attempt, result)
        if (firstRun && written === 'published') process.kill(process.pid, 'SIGKILL')
        return written
      },
    }))
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () => registerBatchSuggestionWorkflow(ports),
  })
  const projectContextId = required(env, 'FREE_TEST_PROJECT')
  const store = suggestionResearcherStore(required(env, 'FREE_TEST_ACCOUNT'))
  if (firstRun) await store.createBatchSchemaSuggestion(projectContextId, required(env, 'FREE_TEST_SOURCES').split(','))
  const [suggestion] = (await store.listBatchSchemaSuggestions(projectContextId, 1)) ?? []
  if (!suggestion) throw new Error('The scenario\'s Batch Schema Suggestion is missing.')
  // The first run never gets past this wait.
  const outcome = await awaitWorkflowOutcome(
    studioDbos().admission,
    `suggest:${suggestion.batchSchemaSuggestionId}:${suggestion.attempt}`,
    { timeoutMs: 90_000 },
  )
  await shutdownStudioDbos()
  if (outcome.state !== 'finished') throw new Error(`suggestSchemaBatch ended ${JSON.stringify(outcome)}.`)
}
