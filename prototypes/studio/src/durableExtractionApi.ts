import { authenticatedFetch } from './auth/authenticatedFetch'
import type { DurableRead, DurablePage, DurableHistory } from 'extraction/durable-types'
import type { ParsedDocument } from 'extraction/parsed-document'
export type PinnedExtractionSource={document:ParsedDocument;markdown:string}
export type DurableReviewProgress={extractionId:string;snapshotVersion:number;feedbackVersion:number;required:number;toCheck:number;finalized:boolean}

export async function durableRequest<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T> {
  const response=await authenticatedFetch(url,{signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})})
  const result=await response.json()
  if(!response.ok) throw new Error(result.error?.message ?? 'Unable to save. Your draft is still here.')
  return result as T
}
export const durableRoot=(id:string)=>`/api/extractions/${id}/durable`
export async function readDurable(id:string,signal?:AbortSignal) {
  const state=await durableRequest<DurableRead>(durableRoot(id),undefined,signal)
  const page=await durableRequest<DurablePage>(`${durableRoot(id)}/values?snapshotVersion=${state.snapshotVersion}`,undefined,signal)
  return {state,page}
}
export const readDurableHistory=(id:string)=>durableRequest<DurableHistory>(`${durableRoot(id)}/history`)
