import { writeFileSync } from 'node:fs'
import { createInternalProjectWorkerStore, db } from 'db'
import { dbosSteps } from 'extraction'
import type { WorkflowSteps } from 'extraction/workflow-steps'
import { createCanonicalPackageStore } from '../../../../packages/db/src/artifact-store.js'
import { deploymentModels } from '../../api/_deployment_models.js'
import { generateSchemaWithModel } from '../../api/_schema_suggestion.js'
import { createModelKeyCache } from '../../api/_model_keys.js'
import { generateSchemaEditJson, proposeSchemaEdit } from '../../api/_schema_edit.js'
import { registerSchemaEditWorkflow, type SchemaEditPorts } from '../../api/_schema_edit_workflow.js'
import { registerSchemaGenerationWorkflow, type SchemaGenerationPorts } from '../../api/_schema_generation_workflow.js'
import { createPostEditSchema } from '../../api/edit_schema.js'
import { createPostGenerateSchema } from '../../api/generate_schema.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../server/dbos.js'
import { awaitWorkflowOutcome } from '../../server/workflowOutcome.js'
import { suggestionResearcherStore } from './suggestionWorkflow.js'

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The operation scenario needs ${name}.`)
  return value
}

export type OperationScenario = Readonly<{
  /** `generation`: suggestion:<op> through POST /api/generate_schema; `edit`: edit:<op> through POST /api/edit_schema
   *  over FREE_TEST_SCHEMA and FREE_TEST_BASE_REVISION. */
  kind: 'generation' | 'edit'
  /** `by-parent`: the test SIGKILLs the child once the scripted server holds the call; `after-step`: the child kills
   *  itself right after the model step checkpointed. */
  kill: 'by-parent' | 'after-step'
}>

/**
 * Studio with both interactive workflows on its own DBOS schemas, over the parent's scripted model server. The first
 * run starts the operation through the real handler and dies (SIGKILL). A later run puts the key first unless
 * FREE_TEST_RESEND is `0` (no page to resend it), waits for the workflow and writes its outcome to FREE_TEST_OUTPUT and
 * the number of key waits to FREE_TEST_WAIT_COUNT.
 */
export async function runOperationScenario(
  { firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv },
  { kind, kill }: OperationScenario,
): Promise<void> {
  const packages = createCanonicalPackageStore(required(env, 'FREE_TEST_PACKAGE_ROOT'))
  const keys = createModelKeyCache()
  let waits = 0
  const wait = keys.wait.bind(keys)
  keys.wait = (...args) => {
    waits += 1
    return wait(...args)
  }
  const keyWaitMs = Number(env.FREE_TEST_KEY_WAIT_MS ?? 60_000)
  if (firstRun || env.FREE_TEST_RESEND !== '0') {
    keys.put(required(env, 'FREE_TEST_ACCOUNT'), required(env, 'FREE_TEST_CONNECTION'),
      { provider: 'openai-compatible', baseUrl: required(env, 'FREE_TEST_MODEL_BASE') }, required(env, 'FREE_TEST_KEY'))
  }
  const die = () => process.kill(process.pid, 'SIGKILL')
  const steps: WorkflowSteps = {
    ...dbosSteps,
    step: async (name, run, config) => {
      const result = await dbosSteps.step(name, run, config)
      if (firstRun && kill === 'after-step' && (name === 'generateSchema' || name === 'proposeSchemaEdit')) die()
      return result
    },
  }
  const worker = createInternalProjectWorkerStore(db, { packages })
  const dependencies = { keys, keyWaitMs, deployment: deploymentModels({}) }
  // No `patched`: these crash scenarios recover a run from before the schema-suggestion-windows patch.
  const generation: SchemaGenerationPorts = {
    steps,
    readSource: (id) => worker.readRevisionSchemaSource(id),
    generate: (caller, input) => generateSchemaWithModel(caller, input, undefined, dependencies),
  }
  const edit: SchemaEditPorts = {
    steps,
    readSchemaTree: (schemaId, revisionId) => worker.readSchemaRevisionTree(schemaId, revisionId),
    readMarkdown: (id) => worker.readRevisionMarkdown(id),
    propose: proposeSchemaEdit,
    generateJson: (caller, prompt, temperature, signal, target) => generateSchemaEditJson(caller, prompt, temperature, signal, target, dependencies),
  }
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () => {
      registerSchemaGenerationWorkflow(() => generation)
      registerSchemaEditWorkflow(() => edit)
    },
  })
  const operationId = required(env, 'FREE_TEST_OPERATION')
  const workflowId = `${kind === 'generation' ? 'suggestion' : 'edit'}:${operationId}`
  if (firstRun) {
    const form = new FormData()
    form.append('project_context_id', required(env, 'FREE_TEST_PROJECT'))
    form.append('source_representation_revision_id', required(env, 'FREE_TEST_REVISION'))
    form.append('operation_id', operationId)
    form.append('instruction', kind === 'generation' ? 'Catalog entries' : 'Rename title to heading')
    if (kind === 'edit') {
      form.append('extraction_schema_id', required(env, 'FREE_TEST_SCHEMA'))
      form.append('schema_revision_id', required(env, 'FREE_TEST_BASE_REVISION'))
    }
    const store = suggestionResearcherStore(required(env, 'FREE_TEST_ACCOUNT'))
    const admission = () => studioDbos().admission
    // The first run never gets past this: it dies inside the workflow.
    const response = kind === 'generation'
      ? await createPostGenerateSchema(store, admission)(new Request('http://local.test/api/generate_schema', { method: 'POST', body: form }))
      : await createPostEditSchema(store, admission)(new Request('http://local.test/api/edit_schema', { method: 'POST', body: form }))
    throw new Error(`The first run answered ${response.status} instead of dying.`)
  }
  if (!(await studioDbos().admission.getWorkflow(workflowId))) throw new Error('The recovered workflow is missing.')
  const outcome = await awaitWorkflowOutcome(studioDbos().admission, workflowId, { timeoutMs: 60_000 })
  await shutdownStudioDbos()
  writeFileSync(required(env, 'FREE_TEST_OUTPUT'), JSON.stringify(outcome))
  writeFileSync(required(env, 'FREE_TEST_WAIT_COUNT'), String(waits))
}
