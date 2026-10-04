import { DBOS } from '@dbos-inc/dbos-sdk'
import { reconcileDurableAttempts, DURABLE_RECONCILE } from 'extraction/durable'
import { KEI_APPLICATION, KEI_PRIORITY, KEI_QUEUE } from 'extraction/kei-handoff'
import { studioDbos } from './dbos.js'

/** A dispatch receipt reconciler; DBOS owns execution and recovery. Register
 * once before launch, independently of the admission feature gate. */
export function registerDurableExtractionReconciler() {
  return DBOS.registerWorkflow(async () => {
    await DBOS.runStep(() => reconcileDurableAttempts(async attempt => {
      await studioDbos().kei.enqueuePortable({workflowName:'extractDurableV1',
        workflowID:attempt.workflowId,queueName:KEI_QUEUE.extract,applicationName:KEI_APPLICATION,
        priority:KEI_PRIORITY.interactive,authenticatedUser:attempt.owner,
        attributes:{extractionId:attempt.extractionId}},
      [{protocol:1,extraction_id:attempt.extractionId,attempt_id:attempt.id}])
    }),{name:'reconcileDurableExtractionDispatchesV1'})
  },{name:DURABLE_RECONCILE})
}
