import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createResearcherProjectStore, db } from 'db'
import { createExtractions } from 'extraction'
import { keiExtractWorkflowId } from 'extraction/kei-handoff'
import { extractionExecution } from '../../../api/_extractions.js'
import { createSourceDocumentIngestion } from '../../../api/source_documents.js'
import { launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../../../server/workflows.js'
import { uploadRequest } from '../ingestion.js'
import type { GarbageSummary } from '../../../api/_garbage_workflow.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The missed-cancel GC scenario needs ${name}.`)
  return value
}

async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await delay(50)
  }
}

/** Kill Studio after the cancellation's domain commit, before its DBOS cancellation; the next sweep repairs it. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const project = required(env, 'FREE_TEST_PROJECT')
  const owner = required(env, 'FREE_TEST_ACCOUNT')
  const extractionId = required(env, 'FREE_TEST_EXTRACTION_ID')
  const observations = required(env, 'GC_OBSERVATIONS')
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: registerStudioWorkflows,
    schedule: applyStudioSchedules,
  })
  if (firstRun) {
    const pdf = new Uint8Array(await readFile(required(env, 'FREE_TEST_PDF')))
    const uploaded = await createSourceDocumentIngestion(createResearcherProjectStore(owner),
      { resultPollIntervalMs: 50 })(uploadRequest(project, pdf))
    if (uploaded.status !== 201) throw new Error(`Ingestion answered ${uploaded.status}.`)
    const { sourceRepresentationId } = await uploaded.json() as { sourceRepresentationId: string }
    await createExtractions(owner, extractionExecution()).runSingle({
      kind: 'fresh', extractionId, sourceRepresentationRevisionId: sourceRepresentationId,
      schemaRevisionId: required(env, 'FREE_TEST_SCHEMA_REVISION'), strategy: 'ARTICLE',
    })
    const childId = keiExtractWorkflowId(extractionId)
    await until(async () => (await studioDbos().kei.listWorkflows({ workflowIDs: [childId],
      loadInput: false, loadOutput: false }))[0]?.status === 'PENDING', 'held kei extraction')
    writeFileSync(observations, JSON.stringify({ childId }))
    const execution = extractionExecution()
    await createExtractions(owner, {
      ...execution,
      async cancel() { process.kill(process.pid, 'SIGKILL') },
    }).cancelSingle(extractionId)
    throw new Error('The cancellation returned instead of killing Studio.')
  }
  const prior = JSON.parse(readFileSync(observations, 'utf8')) as { childId: string }
  const beforeStudio = (await studioDbos().admission.getWorkflow(`extract:${extractionId}`))?.status ?? null
  const beforeKei = (await studioDbos().kei.getWorkflow(prior.childId))?.status ?? null
  const summary = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
  const row = await db.orm.public.Extraction.select('outcome', 'failure').first({ id: extractionId })
  writeFileSync(observations, JSON.stringify({ ...prior, beforeStudio, beforeKei, summary,
    afterStudio: (await studioDbos().admission.getWorkflow(`extract:${extractionId}`))?.status ?? null,
    afterKei: (await studioDbos().kei.getWorkflow(prior.childId))?.status ?? null,
    domainOutcome: row?.outcome ?? null,
    domainFailureCode: (row?.failure as { code?: string } | null)?.code ?? null,
  }))
  await shutdownStudioDbos()
}
