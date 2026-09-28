import { setTimeout as delay } from 'node:timers/promises'
import { createModelConfigurationStore } from 'db'
import { createExtractions, createExtractionStore, registerExtractionWorkflow, type ExtractionStore } from 'extraction'
import { accountMethod } from 'extraction/extraction-method'
import { keiExtractWorkflowId, type KeiHandoff } from 'extraction/kei-handoff'
import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { extractionExecution, extractionWorkflowPorts } from '../../../api/_extractions.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The extraction-publish scenario needs ${name}.`)
  return value
}

/** Dies (SIGKILL) right after the first run's publication commits, before DBOS checkpoints the step. */
function killAfterSettle(store: ExtractionStore, firstRun: boolean): ExtractionStore {
  return {
    ...store,
    async settle(extractionId, settled) {
      const written = await store.settle(extractionId, settled)
      if (firstRun && written === 'settled') process.kill(process.pid, 'SIGKILL')
      return written
    },
  }
}

/** Dies (SIGKILL) as the first run is about to hand its Extraction to kei: loadAdmitted is checkpointed, submitToKei is not. */
function killBeforeSubmit(kei: KeiHandoff, firstRun: boolean): KeiHandoff {
  return {
    ...kei,
    async submit(submission) {
      if (firstRun) process.kill(process.pid, 'SIGKILL')
      return kei.submit(submission)
    },
  }
}

/**
 * Studio with runExtraction on its own DBOS schemas, talking to the kei stand-in the parent spawned (FREE_TEST_KEI_SCHEMA,
 * KEI_EXP_URL). The first run admits one Extraction and dies: in `kill-after-settle` mode right after its publication
 * commits, in `kill-while-held` mode once kei holds its child, in `kill-before-submit` mode as it is about to submit
 * the child. A later run recovers the workflow and waits for it.
 */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const mode = required(env, 'FREE_TEST_EXTRACTION_MODE')
  const extractionId = required(env, 'FREE_TEST_EXTRACTION_ID')
  const packages = createCanonicalPackageStore(required(env, 'FREE_TEST_PACKAGE_ROOT'))
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () =>
      registerExtractionWorkflow(() => {
        const ports = extractionWorkflowPorts()
        return {
          ...ports,
          kei: killBeforeSubmit(ports.kei, firstRun && mode === 'kill-before-submit'),
          store: killAfterSettle(createExtractionStore({ packages }), firstRun && mode === 'kill-after-settle'),
        }
      }),
  })
  if (firstRun) {
    const account = required(env, 'FREE_TEST_ACCOUNT')
    await createExtractions(account, extractionExecution()).runSingle({
      kind: 'fresh',
      extractionId,
      sourceRepresentationRevisionId: required(env, 'FREE_TEST_REVISION'),
      schemaRevisionId: required(env, 'FREE_TEST_SCHEMA_REVISION'),
      strategy: 'ARTICLE',
      // What a start view would submit: the account's saved method.
      method: accountMethod(await createModelConfigurationStore().read(account), 'ARTICLE', null),
    })
    if (mode === 'kill-while-held') {
      // kei has dequeued the child and holds its decision: Studio is polling it.
      for (;;) {
        const [child] = await studioDbos().kei.listWorkflows({
          workflowIDs: [keiExtractWorkflowId(extractionId)], loadInput: false, loadOutput: false,
        })
        if (child?.status === 'PENDING') process.kill(process.pid, 'SIGKILL')
        await delay(50)
      }
    }
  }
  // The first run never gets past this wait in either mode.
  const outcome = await awaitWorkflowOutcome(studioDbos().admission, `extract:${extractionId}`, { timeoutMs: 90_000 })
  await shutdownStudioDbos()
  if (outcome.state !== 'finished') throw new Error(`runExtraction ended ${JSON.stringify(outcome)}.`)
}
