import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { canonicalPackageStore, createResearcherProjectStore } from 'db'
import { createExtractions, registerExtractionWorkflow } from 'extraction'
import { keiConvertWorkflowId, keiExtractWorkflowId } from 'extraction/kei-handoff'
import { garbagePorts, registerGarbageWorkflow, type GarbageSummary } from '../../../api/_garbage_workflow.js'
import { extractionExecution, extractionWorkflowPorts } from '../../../api/_extractions.js'
import { registerIngestionWorkflow } from '../../../api/_ingestion_workflow.js'
import { cancelScopeWork } from '../../../api/_scope_cancellation.js'
import { uploadedDocument } from '../upload.js'
import { COLLECT_GARBAGE_CRON, COLLECT_GARBAGE_SCHEDULE, GC_QUEUE, launchStudioDbos,
  shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { sourceConversionWorkflowPorts } from '../../../server/workflows.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) throw new Error(`The late-handoff GC scenario needs ${name}.`)
  return value
}

async function until(predicate: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await delay(50)
  }
}

/** Cancel after Studio begins the kei handoff but before the child enqueue; a new boot may finally clean the run. */
export async function run({ firstRun, env }: { firstRun: boolean; env: NodeJS.ProcessEnv }): Promise<void> {
  const project = required(env, 'FREE_TEST_PROJECT')
  const owner = required(env, 'FREE_TEST_ACCOUNT')
  const extractionId = required(env, 'FREE_TEST_EXTRACTION_ID')
  const observations = required(env, 'GC_OBSERVATIONS')
  const latch = required(env, 'GC_LATCH')
  const entered = required(env, 'GC_ENTERED')
  const store = createResearcherProjectStore(owner)
  let scheduled: ReturnType<typeof registerGarbageWorkflow> | undefined
  await launchStudioDbos({
    databaseUrl: required(env, 'DATABASE_URL'),
    schema: required(env, 'FREE_TEST_DBOS_SCHEMA'),
    keiSchema: required(env, 'FREE_TEST_KEI_SCHEMA'),
    executorId: required(env, 'FREE_TEST_EXECUTOR'),
    register: () => {
      registerIngestionWorkflow(sourceConversionWorkflowPorts)
      registerExtractionWorkflow(() => {
        const ports = extractionWorkflowPorts()
        return {
          ...ports,
          kei: {
            ...ports.kei,
            async submit(submission) {
              if (firstRun) {
                writeFileSync(entered, 'before kei submit\n')
                await until(() => existsSync(latch), 'late handoff release')
              }
              return ports.kei.submit(submission)
            },
          },
        }
      })
      scheduled = registerGarbageWorkflow(() => garbagePorts())
    },
    schedule: async () => {
      if (!scheduled) throw new Error('GC was not registered.')
      await DBOS.applySchedules([{
        scheduleName: COLLECT_GARBAGE_SCHEDULE, workflowFn: scheduled as never,
        schedule: COLLECT_GARBAGE_CRON, queueName: GC_QUEUE, automaticBackfill: false,
      }])
    },
  })
  if (firstRun) {
    const pdf = new Uint8Array(await readFile(required(env, 'FREE_TEST_PDF')))
    const { sourceDocumentId, sourceRepresentationId } = await uploadedDocument(store, project, pdf)
    const [ingest] = await studioDbos().admission.listWorkflows({
      workflow_id_prefix: `ingest:${project}:`, loadInput: false, loadOutput: false,
    })
    if (!ingest) throw new Error('The ingested conversion has no parent.')
    const convertId = keiConvertWorkflowId(ingest.workflowID)
    await createExtractions(owner, extractionExecution()).runSingle({
      kind: 'fresh', extractionId, sourceRepresentationRevisionId: sourceRepresentationId,
      schemaRevisionId: required(env, 'FREE_TEST_SCHEMA_REVISION'), strategy: 'ARTICLE',
    })
    await until(() => existsSync(entered), 'the extraction handoff')
    const deletion = await store.deleteSourceDocument(project, sourceDocumentId)
    if (!deletion) throw new Error('The Source Document was not deleted.')
    await cancelScopeWork({ projectContextId: project, sourceDocumentId }, deletion.interruptedAttempts)
    const before = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
    writeFileSync(latch, 'release\n')
    const childId = keiExtractWorkflowId(extractionId)
    await until(async () => Boolean((await studioDbos().kei.listWorkflows({ workflowIDs: [childId],
      loadInput: false, loadOutput: false }))[0]), 'late kei child')
    const after = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
    writeFileSync(observations, JSON.stringify({ convertId, childId, before, after }))
    process.kill(process.pid, 'SIGKILL')
    return
  }
  const prior = JSON.parse(readFileSync(observations, 'utf8')) as {
    convertId: string; childId: string; before: GarbageSummary; after: GarbageSummary
  }
  const afterRestart = await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
  writeFileSync(observations, JSON.stringify({ ...prior, afterRestart,
    parentStatus: (await studioDbos().admission.getWorkflow(`extract:${extractionId}`))?.status ?? null,
    childStatus: (await studioDbos().kei.getWorkflow(prior.childId))?.status ?? null,
    packageCount: (await canonicalPackageStore.list()).length,
  }))
  await shutdownStudioDbos()
}
