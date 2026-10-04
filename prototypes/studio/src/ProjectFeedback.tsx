import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { durableRequest } from './durableExtractionApi'
import Button from './ui/Button'
import {savedCorrectionHref, type SavedCorrectionLink} from './durableReviewLinks'

type Correction=SavedCorrectionLink&{id:string;sourceDocumentId:string;revision:number;included:boolean;active:boolean;selectionId:string;targetCompatibility:string;candidate:{value:unknown;grounded:boolean;sourceContext:string};decision:{action:string}}
export function ProjectFeedback({projectId,target,revision,selection}:{projectId:string;target?:string;revision?:string;selection?:string}) {
  const url=`/api/project-contexts/${projectId}/feedback${target?`?target=${target}${selection?`&selection=${selection}`:''}`:''}`
  return <FeedbackResource key={url} projectId={projectId} url={url} target={target} revision={revision} preview={Boolean(selection)}/>
}
function FeedbackResource({projectId,url,target,revision,preview}:{projectId:string;url:string;target?:string;revision?:string;preview:boolean}) {
  const incompatibleId=useId()
  const [rows,setRows]=useState<Correction[]>([]),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState<string|null>(null)
  const [open,setOpen]=useState(preview)
  const lifetime=useRef({active:false,version:0})
  useLayoutEffect(()=>{const resource=lifetime.current;resource.active=true;return()=>{resource.active=false}},[])
  useEffect(()=> {
    if(!open)return
    const resource=lifetime.current
    const controller=new AbortController(),version=++resource.version
    void durableRequest<Correction[]>(url,undefined,controller.signal).then(rows=>{
      if(resource.active&&!controller.signal.aborted&&version===resource.version){setRows(rows);setError(null)}
    }).catch(e=>{if(resource.active&&!controller.signal.aborted&&version===resource.version)setError(e.message)})
    return()=>controller.abort()
  },[url,open,revision])
  const incompatible=rows.filter(row=>row.active&&row.decision.action==='EDITED'&&row.targetCompatibility==='incompatible').length
  const firstIncompatible=rows.find(row=>row.active&&row.decision.action==='EDITED'&&row.targetCompatibility==='incompatible')?.id
  return <details open={open} className="rounded-md border border-line bg-surface p-3" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-secondary font-semibold">{preview?'Guidance for pending inputs':'Project guidance'}{open?` · ${rows.filter(r=>r.active&&r.included).length} included${incompatible?` · ${incompatible} incompatible`:''}`:''}</summary>
    {incompatible>0&&<p role="status" className="my-2 text-secondary"><a className="text-accent underline" href={`#${incompatibleId}`}>{incompatible} saved {incompatible===1?'correction is':'corrections are'} incompatible</a> with {preview?'the pending':'this'} schema. They remain saved and never enter its model context.</p>}
    <p className="my-2 text-compact text-ink-muted">{target?'Compatibility is evaluated for this Extraction’s selected schema.':'Open an Extraction to evaluate compatibility for its selected schema.'} Ungrounded corrections can provide guidance; linking Evidence is optional.</p>
    {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
    <div className="space-y-2">{rows.map(row=><article key={row.id} id={row.id===firstIncompatible?incompatibleId:undefined} className="border-t border-line py-2 text-secondary">
      <p className="break-words">{JSON.stringify(row.candidate.value)}</p>
      <p className="text-compact text-ink-muted">Revision {row.revision} · {row.active?'active':'superseded'} · {row.included?'included':'excluded'} · {row.candidate.grounded?'Evidence linked':'ungrounded'} · {row.targetCompatibility} for this target</p>
      <p className="text-compact text-ink-muted">Producing selection {row.selectionId.slice(0,8)}</p>
      <a className="inline-block text-compact text-accent underline" href={savedCorrectionHref(projectId,row.sourceDocumentId,row)}>Open saved correction and review · revision {row.revision}</a>
      {row.active&&row.decision.action==='EDITED'&&<Button disabled={busy!==null} onClick={()=> {
        const resource=lifetime.current
        ++resource.version
        setBusy(row.id);setError(null);void durableRequest(url,{id:row.id,expectedRevision:row.revision,included:!row.included}).then(async()=>{
          if(!resource.active)return
          // A reopened panel may have read before the POST committed. This
          // post-commit read starts a fresh generation for the same resource.
          const version=++resource.version,rows=await durableRequest<Correction[]>(url)
          if(resource.active&&version===resource.version)setRows(rows)
        }).catch(e=>{if(resource.active)setError(e.message)}).finally(()=>{if(resource.active)setBusy(null)})
      }}>{busy===row.id?'Saving…':row.included?'Exclude from guidance':'Include in guidance'}</Button>}
    </article>)}</div>
  </details>
}
