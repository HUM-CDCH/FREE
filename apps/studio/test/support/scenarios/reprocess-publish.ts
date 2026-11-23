import { createResearcherProjectStore, type ResearcherProjectStore } from 'db'
import { dbosSteps } from 'extraction'
import { createKeiHandoff } from 'extraction/kei-handoff'
import { createCanonicalPackageStore } from '../../../../../packages/db/src/artifact-store.js'
import { registerReprocessWorkflow } from '../../../api/_reprocess_workflow.js'
import { createSourceDocumentReprocessing } from '../../../api/source_reprocess.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { awaitWorkflowOutcome } from '../../../server/workflowOutcome.js'
import { ingestionStoreFor } from '../ingestion.js'
import { requiredScenarioValue, scenarioDbosOptions } from '../scenarioEnvironment.js'

export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const required = requiredScenarioValue(env, 'reprocess-publish')
  const owner = required('FREE_TEST_ACCOUNT')
  const project = required('FREE_TEST_PROJECT')
  const document = required('FREE_TEST_DOCUMENT')
  const head = required('FREE_TEST_HEAD')
  const key = required('FREE_TEST_REQUEST_KEY')
  const packages = createCanonicalPackageStore(required('FREE_TEST_PACKAGE_ROOT'))
  const ordinaryStoreFor = ingestionStoreFor(packages)
  await launchStudioDbos({
    ...scenarioDbosOptions(required),
    register: () => registerReprocessWorkflow(() => ({
      steps: dbosSteps, kei: createKeiHandoff(studioDbos().kei, { pollIntervalMs: 100 }),
      readBase: required('KEI_EXP_URL'), inboxRoot: required('FREE_SOURCE_INBOX'), packageStore: packages,
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
