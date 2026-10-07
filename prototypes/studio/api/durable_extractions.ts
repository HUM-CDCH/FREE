import { canonicalPackageStore, pool, type ResearcherProjectStore } from 'db'
import { correctionSourceContext, createDurableRepository, DurableConflict, DurableInvalid, DurableNotFound, setFeedbackIncluded } from 'extraction/durable'
import { ExtractionError } from 'extraction'
import { decodeParsedDocument } from 'extraction/parsed-document'
import { z } from 'zod'
import { ApiError, json, noStore, noStoreError, parseJsonRequest, persistenceUnavailable } from './_http.js'
import { requestDurableReconciliation } from '../server/durable-extraction-workflow.js'
import { studioDbos } from '../server/dbos.js'

type DiscoveryRun={found:{segment:string;label:string|null}[];lines:{segment:string}[];captures:string[]}
/** The record starts discovery has found while the run still looks for its records: the worker's progress events
 *  (the windows read, then the places the window being read has generated so far). Display only, so a missing or
 *  unreadable event reads as none. */
export async function discoveryProgress(attempt:{id:string;workflowId:string}|null,
  client?:Pick<ReturnType<typeof studioDbos>['kei'],'getEvent'>) {
  if(!attempt)return null
  try {
    const events=client??studioDbos().kei
    const run=await events.getEvent<DiscoveryRun>(attempt.workflowId,'discovery',0)
    if(!run)return null
    const streamed=await Promise.all(run.captures.map(capture=>events.getEvent<unknown[][]>(`kei-call:${attempt.id}:${capture}`,'places',0)))
    const starts=streamed.flatMap(places=>places??[]).flatMap(place=> {
      const line=typeof place[0]==='string'?run.lines[Number(place[0].slice(1))-1]:undefined
      return line&&place[1]==='record'?[{segment:line.segment,label:typeof place[2]==='string'?place[2]:null}]:[]
    })
    return {found:[...run.found,...starts]}
  } catch {return null}
}

/** Session/origin gates in server/app run before this researcher-scoped factory. */
export function createResearcherApiHandlers(store: ResearcherProjectStore) {
  const repository=createDurableRepository(store.researcherAccountId)
  const sourceRevision=async(sourceRevisionId:string)=> {
    const revision=(await pool.query('SELECT "artifactReference","artifactSha256" FROM public."sourceRepresentationRevision" WHERE id=$1',[sourceRevisionId])).rows[0]
    if(!revision)throw new DurableInvalid('The pinned source is unavailable.')
    return revision
  }
  const pinnedSource=async(sourceRevisionId:string)=> {
    const revision=await sourceRevision(sourceRevisionId)
    return decodeParsedDocument(JSON.parse(new TextDecoder().decode((await canonicalPackageStore.read(revision,'source')).bytes)))
  }
  const handle=async(request:Request):Promise<Response>=> {
    try {
      const url=new URL(request.url)
      const feedback=/^\/api\/project-contexts\/([0-9a-f-]+)\/feedback$/.exec(url.pathname)
      if(feedback && request.method==='POST') return json(await setFeedbackIncluded(store.researcherAccountId,z.uuid().parse(feedback[1]),z.object({id:z.uuid(),expectedRevision:z.number().int().positive(),included:z.boolean()}).strict().parse(await parseJsonRequest(request))),{headers:noStore})
      if(feedback && request.method==='GET') return json(await repository.feedback(z.uuid().parse(feedback[1]),url.searchParams.has('target')?z.uuid().parse(url.searchParams.get('target')):undefined,url.searchParams.has('selection')?z.uuid().parse(url.searchParams.get('selection')):undefined),{headers:noStore})
      const match=/^\/api\/extractions\/([0-9a-f-]+)\/durable(?:\/(control|selection|adopt|values|history|finalize|source))?(?:\/([^/]+))?$/.exec(url.pathname)
      if(!match) throw new ApiError(404,'not_found','API route not found.')
      const id=z.uuid().parse(match[1]), action=match[2]
      if(request.method==='GET') {
        if(!action) {
          const state=await repository.read(id)
          // While discovery still looks for the records, the ones it has found so far show on the source.
          return json(state.status==='RUNNING'&&state.strategy==='CATALOG'&&state.records===null?{...state,discovery:await discoveryProgress(state.attempt)}:state,{headers:noStore})
        }
        if(action==='source') {
          const head=await repository.read(id)
          const revision=await sourceRevision(head.sourceRevisionId)
          const [source,markdown]=await Promise.all([canonicalPackageStore.read(revision,'source'),canonicalPackageStore.read(revision,'markdown')])
          return json({document:decodeParsedDocument(JSON.parse(new TextDecoder().decode(source.bytes))),markdown:new TextDecoder().decode(markdown.bytes)},{headers:noStore})
        }
        if(action==='history') return json(await (url.searchParams.has('summary')?repository.historySummary(id):repository.history(id)),{headers:noStore})
        if(action==='values') {
          const input=z.object({snapshotVersion:z.coerce.number().int().nonnegative().optional(),feedbackVersion:z.coerce.number().int().nonnegative().optional(),offset:z.coerce.number().int().nonnegative().optional(),limit:z.coerce.number().int().min(1).max(500).optional()}).strict().parse(Object.fromEntries(url.searchParams))
          return json(await repository.page(id,{...input,...(match[3]?{valueId:decodeURIComponent(match[3])}:{})}),{headers:noStore})
        }
      }
      if(request.method==='POST') {
        const body=await parseJsonRequest(request)
        if(action==='control') {
          const result=await repository.command(id,body)
          await requestDurableReconciliation(`${id}:${result.controlVersion}`)
          return json(result,{headers:noStore})
        }
        if(action==='selection') return json(await repository.saveSelection(id,body),{headers:noStore})
        if(action==='adopt') return json(await repository.adoptSelection(id,body),{headers:noStore})
        if(action==='finalize') return json(await repository.finalize(id,z.object({snapshotVersion:z.number().int().positive(),feedbackVersion:z.number().int().nonnegative()}).strict().parse(body)),{headers:noStore})
        if(action==='values' && match[3]) return json(await repository.saveCorrection(id,decodeURIComponent(match[3]),body,async(value,evidence,sourceRevisionId)=> {
          const document=await pinnedSource(sourceRevisionId)
          for(const selected of evidence) {
            const anchor=document.evidence_index.anchors.find(a=>a.anchor_id===selected.anchorId)
            if(!anchor || selected.occurrenceIds.some(o=>!anchor.producer_observations.some(observation=>observation.occurrence_id===o)))
              throw new DurableInvalid('Link Evidence from this Extraction’s pinned source.')
          }
          const revision=await sourceRevision(sourceRevisionId)
          const markdown=new TextDecoder().decode((await canonicalPackageStore.read(revision,'markdown')).bytes)
          return correctionSourceContext(document,markdown,value,evidence)
        }),{headers:noStore})
      }
      throw new ApiError(404,'not_found','API route not found.')
    } catch(error) {
      if(error instanceof ExtractionError) return noStoreError(new ApiError(422,error.code,error.message))
      if(error instanceof DurableNotFound) return noStoreError(new ApiError(404,'not_found',error.message))
      if(error instanceof DurableConflict) return noStoreError(new ApiError(409,'review_conflict',error.message))
      if(error instanceof DurableInvalid || error instanceof z.ZodError) return noStoreError(new ApiError(422,'invalid_request',error instanceof DurableInvalid?error.message:'The saved request is invalid.'))
      return noStoreError(error instanceof ApiError?error:persistenceUnavailable(error))
    }
  }
  return {GET:handle,POST:handle}
}
