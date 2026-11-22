import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { registerBatchSuggestionWorkflow } from '../../../api/_batch_suggestion_workflow.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { awaitWorkflowOutcome } from '../../../server/workflowOutcome.js'
import { scriptedGenerate, suggestionPorts, suggestionResearcherStore } from '../suggestionWorkflow.js'
import { requiredScenarioValue, scenarioDbosOptions } from '../scenarioEnvironment.js'

/**
 * Studio with suggestSchemaBatch on its own DBOS schemas and a scripted model. The first run creates a Batch Schema
 * Suggestion over FREE_TEST_SOURCES and dies (SIGKILL) right after its publication commits, before DBOS checkpoints the
 * step. A later run recovers the attempt, whose repeated publication finds the outcome and writes nothing.
 */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const required = requiredScenarioValue(env, 'suggestion-publish')
  const packages = createCanonicalPackageStore(required('FREE_TEST_PACKAGE_ROOT'))
  const ports = () =>
    suggestionPorts(packages, scriptedGenerate(required('FREE_TEST_MODEL_LOG')), (store) => ({
      ...store,
      async publish(id, attempt, result) {
        const written = await store.publish(id, attempt, result)
        if (firstRun && written === 'published') process.kill(process.pid, 'SIGKILL')
        return written
      },
    }))
  await launchStudioDbos({
    ...scenarioDbosOptions(required),
    register: () => registerBatchSuggestionWorkflow(ports),
  })
  const projectContextId = required('FREE_TEST_PROJECT')
  const store = suggestionResearcherStore(required('FREE_TEST_ACCOUNT'))
  if (firstRun) await store.createBatchSchemaSuggestion(projectContextId, required('FREE_TEST_SOURCES').split(','))
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
