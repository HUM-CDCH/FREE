import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { durableRequest } from './durableExtractionApi'
import Button from './ui/Button'
import {savedCorrectionHref, type SavedCorrectionLink} from './durableReviewLinks'

type Correction=SavedCorrectionLink&{id:string;sourceDocumentId:string;revision:number;included:boolean;active:boolean;selectionId:string;targetCompatibility:string;candidate:{value:unknown;grounded:boolean;sourceContext:string;node?:{name:string}};decision:{action:string}}
export function ProjectFeedback({projectId,target,revision,selection,onIncompatible,initiallyOpen=false}:{projectId:string;target?:string;revision?:string;selection?:string;onIncompatible?:(count:number)=>void;initiallyOpen?:boolean}) {
  const url=`/api/project-contexts/${projectId}/feedback${target?`?target=${target}${selection?`&selection=${selection}`:''}`:''}`
  return <FeedbackResource key={url} projectId={projectId} url={url} revision={revision} preview={Boolean(selection)} onIncompatible={onIncompatible} initiallyOpen={initiallyOpen}/>
}
function FeedbackResource({projectId,url,revision,preview,onIncompatible,initiallyOpen}:{projectId:string;url:string;revision?:string;preview:boolean;onIncompatible?:(count:number)=>void;initiallyOpen:boolean}) {
  const incompatibleId=useId()
  const [rows,setRows]=useState<Correction[]>([]),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState<string|null>(null)
  const [open,setOpen]=useState(preview||initiallyOpen)
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
  useEffect(()=>{onIncompatible?.(incompatible)},[incompatible,onIncompatible])
  useEffect(()=>()=>onIncompatible?.(0),[onIncompatible])
  const firstIncompatible=rows.find(row=>row.active&&row.decision.action==='EDITED'&&row.targetCompatibility==='incompatible')?.id
  return <details open={open} className="rounded-md border border-line bg-surface p-3" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-secondary font-semibold">{preview?'Corrections for the pending inputs':'Corrections the model learns from'}{open?` · ${rows.filter(r=>r.active&&r.included).length} in use${incompatible?` · ${incompatible} don’t fit`:''}`:''}</summary>
    {incompatible>0&&<p role="status" className="my-2 text-secondary"><a className="text-accent underline" href={`#${incompatibleId}`}>{incompatible} {incompatible===1?'correction doesn’t':'corrections don’t'} fit</a> {preview?'the pending':'this'} schema. They stay saved but aren’t shown to the model.</p>}
    <p className="my-2 text-compact text-ink-muted">Your edits are shown to the model as examples in later runs. Stop using one to leave it out.</p>
    {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
    <div className="space-y-2">{rows.map(row=><article key={row.id} id={row.id===firstIncompatible?incompatibleId:undefined} className="border-t border-line py-2 text-secondary">
      <p className="m-0 break-words">{row.candidate.node&&<span className="font-semibold">{row.candidate.node.name}: </span>}{typeof row.candidate.value==='string'?row.candidate.value:JSON.stringify(row.candidate.value)}</p>
      <p className="m-0 text-compact text-ink-muted">{[!row.active?'Replaced by a newer edit':row.included?'In use':'Not used',
        row.candidate.grounded&&'Has evidence',row.active&&row.targetCompatibility==='incompatible'&&'Doesn’t fit this schema'].filter(Boolean).join(' · ')}</p>
      <a className="inline-block text-compact text-accent underline" href={savedCorrectionHref(projectId,row.sourceDocumentId,row)}>Open in document</a>
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
      }}>{busy===row.id?'Saving…':row.included?'Stop using':'Use'}</Button>}
    </article>)}</div>
  </details>
}
