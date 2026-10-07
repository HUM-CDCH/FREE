import { DBOS } from '@dbos-inc/dbos-sdk'
import { reconcileDurableAttempts, collectDeletedDurableGraphs, DURABLE_RECONCILE } from 'extraction/durable'
import { KEI_APPLICATION, KEI_PRIORITY, KEI_QUEUE } from 'extraction/kei-handoff'
import { studioDbos, STUDIO_APPLICATION, STUDIO_QUEUE } from './dbos.js'
import { awaitWorkflowOutcome } from './workflowOutcome.js'

/** The committed outbox remains authoritative if this low-latency wake fails. */
export async function requestDurableReconciliation(identity:string):Promise<void> {
  try {
    await studioDbos().admission.enqueuePortable({workflowName:DURABLE_RECONCILE,workflowID:`studio:durable-reconcile:${identity}`,
      queueName:STUDIO_QUEUE,applicationName:STUDIO_APPLICATION},[])
  } catch {console.warn('Durable dispatch wake deferred to the scheduled reconciler.')}
}

/** A dispatch receipt reconciler; DBOS owns execution and recovery. Register
 * once before launch so committed attempts and deleted graphs are reconciled. */
export function registerDurableExtractionReconciler() {
  return DBOS.registerWorkflow(async () => {
    await DBOS.runStep(async () => {
      const statuses = async (ids: readonly string[]) => {
        const states = new Map<string, string>()
        for (let start = 0; start < ids.length; start += 100) {
          const workflows = await studioDbos().kei.listWorkflows({ workflowIDs: ids.slice(start, start + 100), loadInput: false, loadOutput: false })
          for (const workflow of workflows) states.set(workflow.workflowID, workflow.status)
        }
        return states
      }
      await reconcileDurableAttempts(async attempt => {
      await studioDbos().kei.enqueuePortable({workflowName:'extractDurableV1',
        workflowID:attempt.workflowId,queueName:KEI_QUEUE.extract,applicationName:KEI_APPLICATION,
        priority:attempt.batch?KEI_PRIORITY.batch:KEI_PRIORITY.interactive,authenticatedUser:attempt.owner,
        attributes:{extractionId:attempt.extractionId,projectContextId:attempt.projectContextId,sourceDocumentId:attempt.sourceDocumentId}},
      [{protocol:1,extraction_id:attempt.extractionId,attempt_id:attempt.id}])
      },undefined,statuses)
      await collectDeletedDurableGraphs(statuses,undefined,{
        remove:async(extractionId,fence)=> {
          const workflowID=`kei-gc:durable:${extractionId}:${fence}:${Math.floor(Date.now()/60000)}`
          await studioDbos().kei.enqueuePortable({workflowName:'deleteDurableHistoryV1',workflowID,queueName:KEI_QUEUE.gc,
            applicationName:KEI_APPLICATION},[{protocol:1,extraction_id:extractionId,fence}])
          const result=await awaitWorkflowOutcome<{removed:boolean}>(studioDbos().kei,workflowID,{timeoutMs:3000})
          return result.state==='finished'&&result.output.removed
        },
        cancelQueued:async id=>{await studioDbos().kei.cancelWorkflow(id)},
      })
    },{name:'reconcileDurableExtractionDispatchesV1'})
  },{name:DURABLE_RECONCILE})
}
