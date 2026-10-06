import { authenticatedFetch } from './auth/authenticatedFetch'
import type { DurableRead, DurablePage, DurableHistory } from 'extraction/durable-types'
import type { ParsedDocument } from 'extraction/parsed-document'
export type PinnedExtractionSource={document:ParsedDocument;markdown:string}
export type DurableReviewProgress={extractionId:string;snapshotVersion:number;feedbackVersion:number;required:number;toCheck:number;finalized:boolean}
/** The Extraction's state; while discovery still looks for its records, the starts it has found so far. */
export type DurableState=DurableRead&{discovery?:{found:{segment:string;label:string|null}[]}|null}

export async function durableRequest<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T> {
  const response=await authenticatedFetch(url,{signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})})
  const result=await response.json()
  if(!response.ok) throw new Error(result.error?.message ?? 'Unable to save. Your draft is still here.')
  return result as T
}
export const durableRoot=(id:string)=>`/api/extractions/${id}/durable`
/** Every value of one saved cut (`query` names it), read in pages of the server's largest size. */
export async function readValues(id:string,query:Record<string,string|number>,signal?:AbortSignal):Promise<DurablePage> {
  const at=(params:Record<string,string|number>)=>`${durableRoot(id)}/values?${new URLSearchParams(Object.entries({limit:500,...params}).map(([k,v])=>[k,String(v)]))}`
  let page=await durableRequest<DurablePage>(at(query),undefined,signal)
  while(page.next) {
    const more:DurablePage=await durableRequest<DurablePage>(at(page.next),undefined,signal)
    page={...more,values:[...page.values,...more.values]}
  }
  return page
}
/** The Extraction's state and every value of its latest results. A poll reads the values again only once new
 *  results or decisions are saved (`previous` is the last read). */
export async function readDurable(id:string,signal?:AbortSignal,previous?:{page:DurablePage}|null) {
  const state=await durableRequest<DurableState>(durableRoot(id),undefined,signal)
  if(previous&&previous.page.snapshotVersion===state.snapshotVersion&&previous.page.feedbackVersion===state.feedbackVersion)
    return {state,page:previous.page}
  // ponytail: the whole cut is read again on each change; read only the changed values if catalogues outgrow this.
  return {state,page:await readValues(id,{snapshotVersion:state.snapshotVersion},signal)}
}
export const readDurableHistory=(id:string)=>durableRequest<DurableHistory>(`${durableRoot(id)}/history`)
