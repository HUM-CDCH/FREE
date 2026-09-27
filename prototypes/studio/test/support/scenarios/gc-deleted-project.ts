import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { canonicalPackageStore, createResearcherProjectStore, studioDataRoot } from 'db'
import { createExtractions } from 'extraction'
import { keiConvertWorkflowId, keiExtractWorkflowId } from 'extraction/kei-handoff'
import { extractionExecution } from '../../../api/_extractions.js'
import { uploadedDocument } from '../upload.js'
import { cancelScopeWork } from '../../../api/_scope_cancellation.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../../../server/workflows.js'
import { ageFile } from '../garbage.js'
import type { GarbageSummary } from '../../../api/_garbage_workflow.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The deleted-project GC scenario needs ${name}.`)
  return value
}

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await delay(50)
  }
}

/** A completed extraction and one cancelled in this boot protect different parts of a deleted project's history. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const project = required(env, 'FREE_TEST_PROJECT')
  const owner = required(env, 'FREE_TEST_ACCOUNT')
  const completedId = required(env, 'FREE_TEST_COMPLETED_EXTRACTION')
  const cancelledId = required(env, 'FREE_TEST_CANCELLED_EXTRACTION')
  const observations = required(env, 'GC_OBSERVATIONS')
  const store = createResearcherProjectStore(owner)
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
      const { sourceRepresentationId } = await uploadedDocument(store, project, pdf)
      const [attempt] = await studioDbos().admission.listWorkflows({
        workflow_id_prefix: `ingest:${project}:`, loadInput: false, loadOutput: false,
      })
      if (!attempt || attempt.status !== 'SUCCESS') throw new Error('The completed ingestion has no history.')
      const [entry] = await canonicalPackageStore.list()
      if (!entry) throw new Error('The completed ingestion has no canonical package.')
      const input = { sourceRepresentationRevisionId: sourceRepresentationId,
        schemaRevisionId: required(env, 'FREE_TEST_SCHEMA_REVISION'), strategy: 'ARTICLE' as const }
      await createExtractions(owner, extractionExecution()).runSingle({ kind: 'fresh', extractionId: completedId, ...input })
      await until(async () => (await studioDbos().admission.getWorkflow(`extract:${completedId}`))?.status === 'SUCCESS',
        'completed extraction')
      const policy = await fetch(`${required(env, 'KEI_EXP_URL')}/control/policy`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ extract: 'hold' }),
      })
      if (!policy.ok) throw new Error(`Holding the next extraction answered ${policy.status}.`)
      await createExtractions(owner, extractionExecution()).runSingle({ kind: 'fresh', extractionId: cancelledId, ...input })
      await until(async () => (await studioDbos().kei.getWorkflow(keiExtractWorkflowId(cancelledId)))?.status === 'PENDING',
        'held extraction')
      const convertId = keiConvertWorkflowId(attempt.workflowID)
      const packageReference = entry.descriptor.artifactReference
      await ageFile(join(studioDataRoot(), 'source-representations', `${packageReference}.zip`), 25 * 3600_000)
      if (!(await store.deleteProjectContext(project))) throw new Error('The project was not deleted.')
      await cancelScopeWork({ projectContextId: project })
      const current = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
      writeFileSync(observations, JSON.stringify({
        ingestId: attempt.workflowID, convertId, packageReference, completedId, cancelledId, current,
        currentIngestStatus: (await studioDbos().admission.getWorkflow(attempt.workflowID))?.status ?? null,
        currentCompletedStatus: (await studioDbos().admission.getWorkflow(`extract:${completedId}`))?.status ?? null,
        currentCancelledStatus: (await studioDbos().admission.getWorkflow(`extract:${cancelledId}`))?.status ?? null,
      }))
    } else {
      const first = JSON.parse(readFileSync(observations, 'utf8')) as {
        ingestId: string; convertId: string; packageReference: string; completedId: string; cancelledId: string;
      }
      const next = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
      writeFileSync(observations, JSON.stringify({ ...first,
        next, nextCancelledStatus: (await studioDbos().admission.getWorkflow(`extract:${cancelledId}`))?.status ?? null,
        packageAvailable: await canonicalPackageStore.available({
          artifactReference: first.packageReference, artifactSha256: first.packageReference,
        }),
      }))
    }
  } finally {
    await shutdownStudioDbos()
  }
}
