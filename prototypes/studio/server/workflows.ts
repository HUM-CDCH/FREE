import { createInternalProjectWorkerStore, createResearcherProjectStore } from 'db'
import { dbosSteps, registerExtractionWorkflow, RUN_EXTRACTION } from 'extraction'
import { createKeiHandoff } from 'extraction/kei-handoff'
import { canonicalPackageStore } from '../../../packages/db/src/artifact-store.js'
import {
  registerBatchSuggestionWorkflow,
  SUGGEST_SCHEMA_BATCH,
  workerSuggestionStore,
} from '../api/_batch_suggestion_workflow.js'
import { extractionWorkflowPorts, KEI_EXP_URL } from '../api/_extractions.js'
import {
  INGEST_SOURCE,
  registerIngestionWorkflow,
  type IngestionWorkflowPorts,
} from '../api/_ingestion_workflow.js'
import { generateSchemaWithModel } from '../api/_model.js'
import { registerReprocessWorkflow, REPROCESS_SOURCE, type ReprocessWorkflowPorts } from '../api/_reprocess_workflow.js'
import { sourceInboxRoot } from '../api/_source_inbox.js'
import { studioDbos } from './dbos.js'

/** Every Studio workflow's explicit name. A bundler renames unnamed functions (M0R 2: `job$1`), and a workflow started
 *  under one build must be recoverable by another. */
export const STUDIO_WORKFLOW_NAMES: readonly string[] = [RUN_EXTRACTION, SUGGEST_SCHEMA_BATCH, INGEST_SOURCE, REPROCESS_SOURCE]

/** Both source conversion workflows use the same kei handoff, inbox, package store and owner-scoped store. */
export function sourceConversionWorkflowPorts(): IngestionWorkflowPorts & ReprocessWorkflowPorts {
  return {
    steps: dbosSteps,
    kei: createKeiHandoff(studioDbos().kei),
    readBase: KEI_EXP_URL,
    inboxRoot: sourceInboxRoot(),
    packageStore: canonicalPackageStore,
    storeFor: (owner) => createResearcherProjectStore(owner),
  }
}

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
  registerIngestionWorkflow(sourceConversionWorkflowPorts)
  registerReprocessWorkflow(sourceConversionWorkflowPorts)
}
