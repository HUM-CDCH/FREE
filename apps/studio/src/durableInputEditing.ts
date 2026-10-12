import type { DurableRead } from 'extraction/durable-types'
import { durableRequest, durableRoot } from './durableExtractionApi'

/** Acknowledgement precedes the local edit. This also cancels an earlier
 * pending Resume when the researcher returns to an input editor. The receipt's
 * version fences the edit session's Save; the draft starts from the read it
 * acknowledged, whose inputs editing keeps. */
export async function beginDurableInputEdit(id:string) {
  const state=await durableRequest<DurableRead>(durableRoot(id))
  const receipt=await durableRequest<{controlVersion:number}>(`${durableRoot(id)}/control`,{id:crypto.randomUUID(),expectedVersion:state.controlVersion,action:'editing'})
  return {controlVersion:receipt.controlVersion,read:state}
}
