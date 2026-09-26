import { writeFileSync } from 'node:fs'
import { createInternalProjectWorkerStore, db } from 'db'
import { dbosSteps } from 'extraction'
import type { WorkflowSteps } from 'extraction/workflows'
import { createCanonicalPackageStore } from '../../../../packages/db/src/artifact-store.js'
import { deploymentModels } from '../../api/_deployment_models.js'
import { generateSchemaWithModel } from '../../api/_model.js'
import { createModelKeyCache } from '../../api/_model_keys.js'
import { registerSchemaGenerationWorkflow, type SchemaGenerationInput, type SchemaGenerationPorts } from '../../api/_schema_generation_workflow.js'
import { createPostGenerateSchema } from '../../api/generate_schema.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../server/dbos.js'
import { suggestionResearcherStore } from './suggestionWorkflow.js'

export function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The generation scenario needs ${name}.`)
  return value
}

/**
 * Studio with suggestSchema on its own DBOS schemas, over the parent's scripted model server. The first run starts
 * `suggestion:FREE_TEST_OPERATION` through the real handler and dies (SIGKILL): `by-parent`, killed by the test once
 * the scripted server holds the call (in flight), or `after-step`, killing itself right after the generateSchema step
 * checkpointed. A later run puts the key first unless FREE_TEST_RESEND is `0` (no page to resend it), waits for the
 * workflow and writes its outcome to FREE_TEST_OUTPUT and the number of key waits to FREE_TEST_WAIT_COUNT.
 */
export async function runGenerationScenario(
  { firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv },
  kill: 'by-parent' | 'after-step',
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
      if (firstRun && kill === 'after-step' && name === 'generateSchema') die()
      return result
    },
  }
  const worker = createInternalProjectWorkerStore(db, { packages })
  const ports: SchemaGenerationPorts = {
    steps,
    readMarkdown: (id) => worker.readRevisionMarkdown(id),
    generate: (caller, input) => generateSchemaWithModel(caller, input, undefined, { keys, keyWaitMs, deployment: deploymentModels({}) }),
  }
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () => registerSchemaGenerationWorkflow(() => ports),
  })
  const operationId = required(env, 'FREE_TEST_OPERATION')
  if (firstRun) {
    const form = new FormData()
    form.append('project_context_id', required(env, 'FREE_TEST_PROJECT'))
    form.append('source_representation_revision_id', required(env, 'FREE_TEST_REVISION'))
    form.append('operation_id', operationId)
    form.append('instruction', 'Catalog entries')
    const store = suggestionResearcherStore(required(env, 'FREE_TEST_ACCOUNT'))
    // The first run never gets past this: it dies inside the workflow.
    const response = await createPostGenerateSchema(store, () => studioDbos().admission)(
      new Request('http://local.test/api/generate_schema', { method: 'POST', body: form }),
    )
    throw new Error(`The first run answered ${response.status} instead of dying.`)
  }
  const input: SchemaGenerationInput | undefined = (await studioDbos().admission.getWorkflow(`suggestion:${operationId}`))?.input?.[0] as SchemaGenerationInput | undefined
  if (!input) throw new Error('The recovered workflow is missing.')
  const outcome = await awaitWorkflowOutcome(studioDbos().admission, `suggestion:${operationId}`, { timeoutMs: 60_000 })
  await shutdownStudioDbos()
  writeFileSync(required(env, 'FREE_TEST_OUTPUT'), JSON.stringify(outcome))
  writeFileSync(required(env, 'FREE_TEST_WAIT_COUNT'), String(waits))
}
