import { createInternalProjectWorkerStore } from 'db'
import { dbosSteps, registerExtractionWorkflow, RUN_EXTRACTION } from 'extraction'
import {
  registerBatchSuggestionWorkflow,
  SUGGEST_SCHEMA_BATCH,
  workerSuggestionStore,
} from '../api/_batch_suggestion_workflow.js'
import { extractionWorkflowPorts } from '../api/_extractions.js'
import { generateSchemaWithModel } from '../api/_model.js'

/** Every Studio workflow's explicit name. A bundler renames unnamed functions (M0R 2: `job$1`), and a workflow started
 *  under one build must be recoverable by another. */
export const STUDIO_WORKFLOW_NAMES: readonly string[] = [RUN_EXTRACTION, SUGGEST_SCHEMA_BATCH]

let registered = false

/** Registers every Studio workflow. Only launchStudioDbos calls it, once, before DBOS.launch(); no module registers a
 *  workflow at import, because the API dispatcher and several tests import every handler module. */
export function registerStudioWorkflows(): void {
  if (registered) return
  registered = true
  // Ports are built per run, after launch: they hold the launched DBOS's kei client.
  registerExtractionWorkflow(extractionWorkflowPorts)
  registerBatchSuggestionWorkflow(() => ({
    steps: dbosSteps,
    generate: generateSchemaWithModel,
    store: workerSuggestionStore(createInternalProjectWorkerStore()),
  }))
}
