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
import { generateSchemaEditJson, generateSchemaWithModel } from '../api/_model.js'
import { registerReprocessWorkflow, REPROCESS_SOURCE, type ReprocessWorkflowPorts } from '../api/_reprocess_workflow.js'
import { proposeSchemaEdit } from '../api/_schema_edit.js'
import { PROPOSE_SCHEMA_EDIT, registerSchemaEditWorkflow } from '../api/_schema_edit_workflow.js'
import { registerSchemaGenerationWorkflow, SUGGEST_SCHEMA } from '../api/_schema_generation_workflow.js'
import { sourceInboxRoot } from '../api/_source_inbox.js'
import { COLLECT_GARBAGE, garbagePorts, registerGarbageWorkflow, type GarbagePorts } from '../api/_garbage_workflow.js'
import { COLLECT_GARBAGE_CRON, COLLECT_GARBAGE_SCHEDULE, GC_QUEUE, studioDbos } from './dbos.js'
import { DBOS, type ScheduledWorkflowFn } from '@dbos-inc/dbos-sdk'

/** Every Studio workflow's explicit name. A bundler renames unnamed functions (M0R 2: `job$1`), and a workflow started
 *  under one build must be recoverable by another. */
export const STUDIO_WORKFLOW_NAMES: readonly string[] = [
  RUN_EXTRACTION, SUGGEST_SCHEMA_BATCH, INGEST_SOURCE, REPROCESS_SOURCE, SUGGEST_SCHEMA, PROPOSE_SCHEMA_EDIT,
  COLLECT_GARBAGE,
]

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
let collectGarbage: ReturnType<typeof registerGarbageWorkflow> | undefined

/** Registers every Studio workflow. Only launchStudioDbos calls it, once, before DBOS.launch(); no module registers a
 *  workflow at import, because the API dispatcher and several tests import every handler module. */
export function registerStudioWorkflows(options: { garbagePorts?: () => GarbagePorts } = {}): void {
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
  registerSchemaGenerationWorkflow(() => {
    const worker = createInternalProjectWorkerStore()
    return { steps: dbosSteps, readMarkdown: (id) => worker.readRevisionMarkdown(id), generate: generateSchemaWithModel }
  })
  registerSchemaEditWorkflow(() => {
    const worker = createInternalProjectWorkerStore()
    return {
      steps: dbosSteps,
      readSchemaTree: (schemaId, revisionId) => worker.readSchemaRevisionTree(schemaId, revisionId),
      readMarkdown: (id) => worker.readRevisionMarkdown(id),
      propose: proposeSchemaEdit,
      generateJson: generateSchemaEditJson,
    }
  })
  collectGarbage = registerGarbageWorkflow(options.garbagePorts ?? (() => garbagePorts()))
}

export async function applyStudioSchedules(): Promise<void> {
  if (!collectGarbage) throw new Error('applyStudioSchedules runs after registerStudioWorkflows.')
  await DBOS.applySchedules([{
    scheduleName: COLLECT_GARBAGE_SCHEDULE,
    // The scheduler's type narrows results to void; DBOS still persists this workflow's summary for gc:now.
    workflowFn: collectGarbage as unknown as ScheduledWorkflowFn,
    schedule: COLLECT_GARBAGE_CRON,
    queueName: GC_QUEUE,
    automaticBackfill: false,
  }])
}
