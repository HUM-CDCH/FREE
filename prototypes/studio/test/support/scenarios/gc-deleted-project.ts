import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { canonicalPackageStore, createResearcherProjectStore, studioDataRoot } from 'db'
import { keiConvertWorkflowId } from 'extraction/kei-handoff'
import { createSourceDocumentIngestion } from '../../../api/source_documents.js'
import { cancelScopeWork } from '../../../api/_scope_cancellation.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../../../server/workflows.js'
import { ageFile } from '../garbage.js'
import { uploadRequest } from '../ingestion.js'
import type { GarbageSummary } from '../../../api/_garbage_workflow.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The deleted-project GC scenario needs ${name}.`)
  return value
}

/** A completed ingestion survives one boot; the next deletes its project and sweeps both DBOS histories. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const project = required(env, 'FREE_TEST_PROJECT')
  const observations = required(env, 'GC_OBSERVATIONS')
  const store = createResearcherProjectStore(required(env, 'FREE_TEST_ACCOUNT'))
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: registerStudioWorkflows,
    schedule: applyStudioSchedules,
  })
  try {
    if (firstRun) {
      const pdf = new Uint8Array(await readFile(required(env, 'FREE_TEST_PDF')))
      const response = await createSourceDocumentIngestion(store, { resultPollIntervalMs: 50 })(uploadRequest(project, pdf))
      if (response.status !== 201) throw new Error(`Ingestion answered ${response.status}.`)
      const [attempt] = await studioDbos().admission.listWorkflows({
        workflow_id_prefix: `ingest:${project}:`, loadInput: false, loadOutput: false,
      })
      if (!attempt || attempt.status !== 'SUCCESS') throw new Error('The completed ingestion has no history.')
      const [entry] = await canonicalPackageStore.list()
      if (!entry) throw new Error('The completed ingestion has no canonical package.')
      writeFileSync(observations, JSON.stringify({
        ingestId: attempt.workflowID, convertId: keiConvertWorkflowId(attempt.workflowID),
        packageReference: entry.descriptor.artifactReference,
      }))
      return
    }
    const first = JSON.parse(readFileSync(observations, 'utf8')) as {
      ingestId: string; convertId: string; packageReference: string
    }
    await ageFile(join(studioDataRoot(), 'source-representations', `${first.packageReference}.zip`), 25 * 3600_000)
    if (!(await store.deleteProjectContext(project))) throw new Error('The project was not deleted.')
    await cancelScopeWork({ projectContextId: project })
    const summary = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
    const studioHistory = await studioDbos().admission.getWorkflow(first.ingestId)
    writeFileSync(observations, JSON.stringify({
      ...first, summary, studioHistory: studioHistory?.status ?? null,
      packageAvailable: await canonicalPackageStore.available({
        artifactReference: first.packageReference, artifactSha256: first.packageReference,
      }),
    }))
  } finally {
    await shutdownStudioDbos()
  }
}
