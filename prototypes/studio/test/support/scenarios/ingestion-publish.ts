import { readFile } from 'node:fs/promises'
import { createResearcherProjectStore } from 'db'
import { createKeiHandoff } from 'extraction/kei-handoff'
import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { registerIngestionWorkflow, type IngestionStore } from '../../../api/_ingestion_workflow.js'
import { createSourceDocumentIngestion } from '../../../api/source_documents.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { sourceConversionWorkflowPorts } from '../../../server/workflows.js'
import { ingestionStoreFor, uploadRequest } from '../ingestion.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The ingestion-publish scenario needs ${name}.`)
  return value
}

/** Dies (SIGKILL) right after the first run's publication commits, before DBOS checkpoints the step. */
function killAfterPublish(store: IngestionStore, firstRun: boolean): IngestionStore {
  return {
    ...store,
    async ingestSourceDocument(projectContextId, input) {
      const published = await store.ingestSourceDocument(projectContextId, input)
      if (firstRun && published?.disposition === 'created') process.kill(process.pid, 'SIGKILL')
      return published
    },
  }
}

/**
 * Studio with ingestSource on its own DBOS schemas, talking to the kei stand-in the parent spawned (FREE_TEST_KEI_SCHEMA,
 * KEI_EXP_URL) and staging in FREE_SOURCE_INBOX. The first run uploads FREE_TEST_PDF through the handler into
 * FREE_TEST_PROJECT and dies: in `kill-after-publish` mode right after its publication commits, in `kill-before-submit`
 * mode as the workflow is about to hand the file to kei. A later run recovers the workflow and waits for it.
 */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const mode = required(env, 'FREE_TEST_INGESTION_MODE')
  const owner = required(env, 'FREE_TEST_ACCOUNT')
  const projectContextId = required(env, 'FREE_TEST_PROJECT')
  const packageStore = createCanonicalPackageStore(required(env, 'FREE_TEST_PACKAGE_ROOT'))
  const ownersStore = ingestionStoreFor(packageStore)
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () =>
      registerIngestionWorkflow(() => {
        const ports = sourceConversionWorkflowPorts()
        const kei = createKeiHandoff(studioDbos().kei, { pollIntervalMs: 100 })
        return {
          ...ports,
          packageStore,
          kei: {
            ...kei,
            async submit(submission) {
              if (firstRun && mode === 'kill-before-submit') process.kill(process.pid, 'SIGKILL')
              await kei.submit(submission)
            },
          },
          storeFor: (account) =>
            killAfterPublish(ownersStore(account), firstRun && mode === 'kill-after-publish'),
        }
      }),
  })
  if (firstRun) {
    const pdf = new Uint8Array(await readFile(required(env, 'FREE_TEST_PDF')))
    const response = await createSourceDocumentIngestion(createResearcherProjectStore(owner), { packageStore })(
      uploadRequest(projectContextId, pdf),
    )
    throw new Error(`The first run answered ${response.status} instead of dying: ${await response.text()}`)
  }
  // The recovered attempt: the only ingestion this scenario's schema holds for the project.
  const [attempt] = await studioDbos().admission.listWorkflows({
    workflow_id_prefix: `ingest:${projectContextId}:`, loadInput: false, loadOutput: false,
  })
  if (!attempt) throw new Error('The first run left no ingestSource workflow.')
  const outcome = await awaitWorkflowOutcome(studioDbos().admission, attempt.workflowID, { timeoutMs: 90_000 })
  await shutdownStudioDbos()
  if (outcome.state !== 'finished') throw new Error(`ingestSource ended ${JSON.stringify(outcome)}.`)
}
