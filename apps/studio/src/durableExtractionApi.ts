import { authenticatedFetch } from './auth/authenticatedFetch'
import { ApiRequestError } from './api'
import type { DurableRead, DurablePage, DurableHistory, DurableHistorySummary } from 'extraction/durable-types'
import type { ParsedDocument } from 'extraction/parsed-document'
export type PinnedExtractionSource={document:ParsedDocument;markdown:string}
export type DurableReviewProgress={extractionId:string;snapshotVersion:number;feedbackVersion:number;required:number;toCheck:number;finalized:boolean}
/** The Extraction's state; while discovery still looks for its records, the starts it has found so far. */
export type DurableState=DurableRead&{discovery?:{found:{segment:string;label:string|null}[]}|null}

const READ_RETRY_DELAYS = [1000, 2000] as const
function waitForReadRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** Retry interrupted reads, including a body cut off after successful headers. Writes, HTTP errors and invalid
 * JSON are terminal; replaying a correction or a control command could apply it twice. An HTTP error keeps its status
 * and code, whatever its body. */
export async function durableRequest<T>(url:string,body?:unknown,signal?:AbortSignal):Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    signal?.throwIfAborted()
    let response: Response | undefined
    try {
      response=await authenticatedFetch(url,{signal,...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})})
      if(!response.ok) {
        // A gateway's error page is no JSON.
        const failure=await response.json().catch(()=>null) as {error?:{message?:string;code?:string;details?:unknown}}|null
        throw new ApiRequestError(failure?.error?.message ?? (body===undefined?`Request failed (HTTP ${response.status}).`:'Unable to save. Your draft is still here.'),
          response.status,failure?.error?.code ?? null,failure?.error?.details)
      }
      return await response.json() as T
    } catch (error) {
      if (body !== undefined || signal?.aborted || response?.ok === false ||
        !(error instanceof TypeError) || attempt === READ_RETRY_DELAYS.length) throw error
      await waitForReadRetry(READ_RETRY_DELAYS[attempt], signal)
    }
  }
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
/** The Extraction's state and, with `pages`, every value of its latest results. A poll reads the values again only
 *  once new results or decisions are saved (`previous` is the last read). A failed values read keeps `previous` and
 *  says why (`pageError`), so the state read before it is not lost. */
export async function readDurable(id:string,signal?:AbortSignal,previous:DurablePage|null=null,pages=true,onState?:(state:DurableState)=>void):Promise<{state:DurableState;page:DurablePage|null;pageError?:unknown}> {
  const state=await durableRequest<DurableState|null>(durableRoot(id),undefined,signal)
  // A body that names no status and versions is no state: reading it again cannot help.
  if(typeof state?.status!=='string'||![state.controlVersion,state.snapshotVersion,state.feedbackVersion].every(Number.isInteger))
    throw new Error('The saved results could not be read.')
  onState?.(state)
  if(!pages||previous&&previous.snapshotVersion===state.snapshotVersion&&previous.feedbackVersion===state.feedbackVersion)
    return {state,page:previous}
  // ponytail: the whole cut is read again on each change; read only the changed values if catalogues outgrow this.
  try {return {state,page:await readValues(id,{snapshotVersion:state.snapshotVersion},signal)}}
  catch(pageError) {if(signal?.aborted)throw pageError;return {state,page:previous,pageError}}
}
export const readDurableHistory=(id:string,signal?:AbortSignal)=>durableRequest<DurableHistory>(`${durableRoot(id)}/history`,undefined,signal)
/** History's saved versions without their values or any call's request: small however long the run. */
export const readDurableHistorySummary=(id:string,signal?:AbortSignal)=>durableRequest<DurableHistorySummary>(`${durableRoot(id)}/history?summary`,undefined,signal)
