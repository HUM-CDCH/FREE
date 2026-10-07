import type { DurableRead } from 'extraction/durable-types'
import { durableRequest, durableRoot } from './durableExtractionApi'

/** Acknowledgement precedes the local edit. This also cancels an earlier
 * pending Resume when the researcher returns to an input editor. */
export async function beginDurableInputEdit(id:string) {
  const state=await durableRequest<DurableRead>(durableRoot(id))
  await durableRequest(`${durableRoot(id)}/control`,{id:crypto.randomUUID(),expectedVersion:state.controlVersion,action:'editing'})
}
