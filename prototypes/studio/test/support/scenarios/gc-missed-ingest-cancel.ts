import { readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { DBOS } from '@dbos-inc/dbos-sdk'
import { createResearcherProjectStore } from 'db'
import { keiConvertWorkflowId } from 'extraction/kei-handoff'
import { createSourceDocumentIngestion } from '../../../api/source_documents.js'
import type { GarbageSummary } from '../../../api/_garbage_workflow.js'
import { awaitWorkflowOutcome, launchStudioDbos, shutdownStudioDbos, studioDbos } from '../../../server/dbos.js'
import { applyStudioSchedules, registerStudioWorkflows } from '../../../server/workflows.js'
import { orphanPayloadRows } from '../garbage.js'
import { uploadRequest } from '../ingestion.js'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value=env[name]
  if(!value)throw new Error(`The missed-ingestion-cancel scenario needs ${name}.`)
  return value
}

type Observations={ingestId:string;convertId:string;repaired?:GarbageSummary;currentIngestStatus?:string|null}

/** Crash after domain deletion, repair the missed cancellations, then prove the next boot can collect history. */
export async function run({firstRun,env}:{firstRun:boolean;env:NodeJS.ProcessEnv}):Promise<void> {
  const url=required(env,'DATABASE_URL'),schema=required(env,'FREE_TEST_DBOS_SCHEMA')
  const project=required(env,'FREE_TEST_PROJECT'),observations=required(env,'GC_OBSERVATIONS')
  await launchStudioDbos({databaseUrl:url,schema,keiSchema:required(env,'FREE_TEST_KEI_SCHEMA'),
    executorId:required(env,'FREE_TEST_EXECUTOR'),register:registerStudioWorkflows,schedule:applyStudioSchedules})
  if(firstRun) {
    const store=createResearcherProjectStore(required(env,'FREE_TEST_ACCOUNT'))
    const pdf=new Uint8Array(await readFile(required(env,'FREE_TEST_PDF')))
    const response=await createSourceDocumentIngestion(store)(uploadRequest(project,pdf))
    if(response.status!==202)throw new Error(`Expected an admitted ingestion, got ${response.status}.`)
    const {workflowId:ingestId}=await response.json() as {workflowId:string}
    const convertId=keiConvertWorkflowId(ingestId),deadline=Date.now()+60_000
    for(;;) {
      if((await studioDbos().kei.getWorkflow(convertId))?.status==='PENDING')break
      if(Date.now()>deadline)throw new Error('The held conversion never became pending.')
      await delay(50)
    }
    if(!await store.deleteProjectContext(project))throw new Error('The test Project was not deleted.')
    writeFileSync(observations,JSON.stringify({ingestId,convertId}))
    // Deliberately omit the HTTP handler's following cancelScopeWork call.
    process.kill(process.pid,'SIGKILL')
    return
  }
  const before=JSON.parse(readFileSync(observations,'utf8')) as Observations
  const summary=await (await DBOS.triggerSchedule('collectGarbage')).getResult() as GarbageSummary
  const currentIngestStatus=(await studioDbos().admission.getWorkflow(before.ingestId))?.status??null
  if(!before.repaired) {
    writeFileSync(observations,JSON.stringify({...before,repaired:summary,currentIngestStatus}))
    process.kill(process.pid,'SIGKILL')
    return
  }
  if(summary.keiRequest) {
    const outcome=await awaitWorkflowOutcome(studioDbos().kei,summary.keiRequest.workflowId,{timeoutMs:20_000})
    if(outcome.state!=='finished')throw new Error('The requested kei cleanup did not finish.')
  }
  writeFileSync(observations,JSON.stringify({...before,next:summary,nextIngestStatus:currentIngestStatus,
    orphanPayloads:await orphanPayloadRows(url,schema)}))
  await shutdownStudioDbos()
}
