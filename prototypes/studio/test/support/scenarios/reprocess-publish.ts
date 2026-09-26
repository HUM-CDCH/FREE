import { createResearcherProjectStore, type ResearcherProjectStore } from 'db'
import { dbosSteps } from 'extraction'
import { createKeiHandoff } from 'extraction/kei-handoff'
import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { registerReprocessWorkflow } from '../../../api/_reprocess_workflow.js'
import { createSourceDocumentReprocessing } from '../../../api/source_reprocess.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { ingestionStoreFor } from '../ingestion.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The reprocess-publish scenario needs ${name}.`)
  return value
}

export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const owner = required(env, 'FREE_TEST_ACCOUNT')
  const project = required(env, 'FREE_TEST_PROJECT')
  const document = required(env, 'FREE_TEST_DOCUMENT')
  const head = required(env, 'FREE_TEST_HEAD')
  const key = required(env, 'FREE_TEST_REQUEST_KEY')
  const packages = createCanonicalPackageStore(required(env, 'FREE_TEST_PACKAGE_ROOT'))
  const ordinaryStoreFor = ingestionStoreFor(packages)
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'), schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'), executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () => registerReprocessWorkflow(() => ({
      steps: dbosSteps, kei: createKeiHandoff(studioDbos().kei, { pollIntervalMs: 100 }),
      readBase: required(env, 'KEI_EXP_URL'), inboxRoot: required(env, 'FREE_SOURCE_INBOX'), packageStore: packages,
      storeFor: (account): ResearcherProjectStore => {
        const store = ordinaryStoreFor(account)
        return { ...store, async reprocessSourceDocument(projectId, documentId, input) {
          const published = await store.reprocessSourceDocument(projectId, documentId, input)
          if (firstRun && published?.revisionNumber === 2) process.kill(process.pid, 'SIGKILL')
          return published
        } }
      },
    })),
  })
  if (firstRun) {
    const response = await createSourceDocumentReprocessing(createResearcherProjectStore(owner), {
      readPackage: packages.read,
    })(new Request(`http://studio.test/api/project-contexts/${project}/source-documents/${document}/reprocess`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestKey: key, expectedRepresentationId: head, layout: 'pages' }),
    }))
    throw new Error(`The first run answered ${response.status} instead of dying: ${await response.text()}`)
  }
  const result = await awaitWorkflowOutcome(studioDbos().admission, `reprocess:${document}:${key}`, { timeoutMs: 90_000 })
  await shutdownStudioDbos()
  if (result.state !== 'finished' || !(result.output as { ok?: boolean }).ok)
    throw new Error(`reprocessSource ended ${JSON.stringify(result)}.`)
}
