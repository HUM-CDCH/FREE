import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { registerBatchSuggestionWorkflow } from '../../../api/_batch_suggestion_workflow.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { awaitWorkflowOutcome } from '../../../server/workflowOutcome.js'
import { scriptedGenerate, suggestionPorts, suggestionResearcherStore } from '../suggestionWorkflow.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The suggestion-recover scenario needs ${name}.`)
  return value
}

/**
 * Studio with suggestSchemaBatch on its own DBOS schemas and a scripted model that logs every call. The first run
 * creates a Batch Schema Suggestion over FREE_TEST_SOURCES and dies (SIGKILL) inside the model call FREE_TEST_KILL_AT,
 * after the earlier sources' steps checkpointed. A later run recovers the attempt and waits for it to finish.
 */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const killAt = required(env, 'FREE_TEST_KILL_AT')
  const packages = createCanonicalPackageStore(required(env, 'FREE_TEST_PACKAGE_ROOT'))
  const generate = scriptedGenerate(required(env, 'FREE_TEST_MODEL_LOG'), (call) => {
    if (firstRun && call === killAt) process.kill(process.pid, 'SIGKILL')
  })
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () => registerBatchSuggestionWorkflow(() => suggestionPorts(packages, generate)),
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
