import { useCallback, useEffect, useRef, useState } from 'react'
import { useMachine } from '@xstate/react'
import type { DurablePage, DurableRead, DurableHistory } from 'extraction/durable-types'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import type { ParsedDocument } from 'extraction/parsed-document'
import { durableRequest, durableRoot, readDurable, readDurableHistory } from './durableExtractionApi'
import { durableReviewMachine, reviewDraft } from './durableReviewMachine'
import { savedMethodFor, useSavedMethod } from './savedMethod'
import { SavedMethodSummary } from './SavedMethodSummary'
import Button from './ui/Button'
import { ProjectFeedback } from './ProjectFeedback'

type Value=DurablePage['values'][number]
const inputClass='w-full rounded-md border border-line bg-surface px-3 py-2 text-secondary text-ink focus-visible:outline-accent'
function ValueReview({id,value,snapshotVersion,document,onSaved,onClose,onEvidence}:{id:string;value:Value;snapshotVersion:number;document:ParsedDocument|null;onSaved:()=>void;onClose:()=>void;onEvidence:(id:string)=>void}) {
  const [state,send]=useMachine(durableReviewMachine,{input:{extractionId:id,value,snapshotVersion}})
  const [text,setText]=useState(()=> {const saved=reviewDraft(value).value;return typeof saved==='string'?saved:JSON.stringify(saved,null,2)})
  const [parseError,setParseError]=useState<string|null>(null)
  useEffect(()=> {if(state.matches('saved')) onSaved()},[state,onSaved])
  const update=(next:string)=> {
    setText(next)
    try {
      const parsed=['boolean','number','integer','object','array'].includes(value.node.type)?JSON.parse(next):next
      send({type:'edit',draft:{...state.context.draft,value:parsed}});setParseError(null)
    } catch {setParseError('Enter a valid value for this field’s type.')}
  }
  const busy=state.matches('saving')||state.matches('reloading')
  return <section className="space-y-3 rounded-md border border-accent bg-surface p-3" aria-label={`Review ${value.node.name}`}>
    <label className="block text-secondary font-semibold">{value.node.name} · {value.node.type}
      <textarea className={`${inputClass} mt-1 min-h-24`} value={text??''} onChange={e=>update(e.target.value)} disabled={busy}/>
    </label>
    <label className="flex gap-2 text-secondary"><input type="checkbox" checked={state.context.draft.included} disabled={busy} onChange={e=>send({type:'edit',draft:{...state.context.draft,included:e.target.checked}})}/>Use this correction as Project guidance</label>
    <p className="text-compact text-ink-muted">Guidance teaches a pattern; it does not supply another document’s facts. Evidence is optional.</p>
    <label className="block text-secondary">Link Evidence from this source
      <select className={`${inputClass} mt-1`} value={state.context.draft.evidence[0]?.anchorId??''} disabled={busy} onChange={e=> {
        const anchor=document?.evidence_index.anchors.find(a=>a.anchor_id===e.target.value)
        send({type:'edit',draft:{...state.context.draft,evidence:anchor?[{anchorId:anchor.anchor_id,occurrenceIds:anchor.producer_observations.map(o=>o.occurrence_id)}]:[]}})
        if(anchor) onEvidence(anchor.anchor_id)
      }}><option value="">No Evidence linked</option>{document?.evidence_index.anchors.map(a=><option key={a.anchor_id} value={a.anchor_id}>Page {a.producer_observations[0]?.page_number} · {a.anchor_id}</option>)}</select>
    </label>
    {state.context.value.correction&&<p className="text-secondary text-ink-muted">Saved decision: {state.context.value.correction.decision.action} · {JSON.stringify(state.context.value.correction.decision.value)}</p>}
    {state.context.error&&<Button disabled={busy} onClick={()=>send({type:'refresh'})}>Reload saved decision · keep my draft</Button>}
    {(state.context.error||parseError)&&<p role="alert" className="text-secondary text-danger">{parseError??state.context.error}</p>}
    <div className="flex flex-wrap gap-2">
      <Button variant="positive" disabled={busy||Boolean(parseError)} onClick={()=>send({type:'save',action:'EDITED'})}>{busy?'Saving…':'Save correction'}</Button>
      <Button disabled={busy} onClick={()=>send({type:'save',action:'APPROVED'})}>Approve original</Button>
      <Button variant="danger" disabled={busy} onClick={()=>send({type:'save',action:'REJECTED'})}>Reject</Button>
      <Button disabled={busy} onClick={onClose}>Close</Button>
    </div>
  </section>
}

function Inputs({attempt,state,currentSchema,onSaved}:{attempt:ExtractionAttempt;state:DurableRead;currentSchema:string|null;onSaved:()=>void}) {
  const saved=useSavedMethod(),method=saved.state.status==='ready'?savedMethodFor(saved.state,attempt.strategy,attempt.catalogRecipe):null
  const [schemaId,setSchemaId]=useState(state.selection.schemaRevisionId as string)
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false)
  return <section aria-label="Revised inputs" className="space-y-3 rounded-md border border-line bg-surface-muted p-3">
    <p className="text-secondary">Changes apply after in-flight work is saved. Earlier values keep the schema and settings that produced them.</p>
    <label className="block text-secondary">Schema to use next<select className={inputClass} value={schemaId} onChange={e=>setSchemaId(e.target.value)}>
      <option value={state.selection.schemaRevisionId}>Keep used schema</option>
      {currentSchema&&currentSchema!==state.selection.schemaRevisionId&&<option value={currentSchema}>Current saved schema</option>}
    </select></label>
    <SavedMethodSummary saved={saved.state} method={method} conflict={error} onRefresh={()=>void saved.refresh()}/>
    <Button variant="positive" disabled={!method||busy} onClick={()=> {setBusy(true);void durableRequest(`${durableRoot(attempt.extractionId)}/selection`,{expectedVersion:state.controlVersion,schemaRevisionId:schemaId,method}).then(onSaved).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>Save pending inputs</Button>
  </section>
}

function History({id,onSnapshot}:{id:string;onSnapshot:(version:number)=>void}) {
  const [history,setHistory]=useState<DurableHistory|null>(null),[error,setError]=useState<string|null>(null)
  return <details className="rounded-md border border-line bg-surface p-3" onToggle={event=> {
    if(event.currentTarget.open&&!history)void readDurableHistory(id).then(setHistory).catch(e=>setError(e.message))
  }}>
    <summary className="cursor-pointer text-secondary font-semibold">Saved history and producing inputs</summary>
    {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
    {history&&<div className="space-y-3 pt-2">
      {history.selections.map(selection=><details key={selection.id} className="text-secondary">
        <summary className="cursor-pointer">Input selection {selection.ordinal} · schema {selection.schemaRevisionId.slice(0,8)}</summary>
        <p className="text-compact text-ink-muted">Earlier values retain this schema and these settings.</p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify({schema:selection.schemaTree,method:selection.method,resolved:selection.resolved},null,2)}</pre>
      </details>)}
      {history.snapshots.map(snapshot=><details key={snapshot.id} className="text-secondary">
        <summary className="cursor-pointer">Saved result snapshot {snapshot.version} · {snapshot.values.length} values</summary>
        <Button onClick={()=>onSnapshot(snapshot.version)}>Open snapshot {snapshot.version}</Button>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify(snapshot.values.map((v:Value)=>({field:v.node.name,schema:v.schemaRevisionId,selection:v.selectionId,modelValue:v.modelValue,lineage:v.lineage})),null,2)}</pre>
      </details>)}
    </div>}
  </details>
}

/** Durable live review in the existing results rail. All lifecycle states
 * share the same retained snapshot and independent researcher decisions. */
export function DurableResults({attempt,document,currentSchema,onEvidence,readOnly=false}:{attempt:ExtractionAttempt|null;document:ParsedDocument|null;currentSchema:string|null;onEvidence:(id:string)=>void;readOnly?:boolean}) {
  const id=attempt?.extractionId
  const [loaded,setLoaded]=useState<Awaited<ReturnType<typeof readDurable>>|null>(null)
  const [page,setPage]=useState<DurablePage|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false)
  const [editing,setEditing]=useState(false),[review,setReview]=useState<{value:Value;version:number}|null>(null)
  const [reprocess,setReprocess]=useState<Set<string>>(()=>new Set()),[notice,setNotice]=useState<string|null>(null)
  const [filter,setFilter]=useState<'all'|'attention'>('all')
  const readGeneration=useRef(0), pageGeneration=useRef(0)
  const acceptedRead=useRef<Awaited<ReturnType<typeof readDurable>>|null>(null)
  const refresh=useCallback(async(signal?:AbortSignal)=> {
    if(!id) return
    const generation=++readGeneration.current
    let next:Awaited<ReturnType<typeof readDurable>>
    try {next=await readDurable(id,signal)}
    catch(error){if(signal?.aborted||generation!==readGeneration.current)return;throw error}
    if(signal?.aborted||generation!==readGeneration.current) return
    const previous=acceptedRead.current
    if(previous && (next.state.controlVersion<previous.state.controlVersion ||
      next.state.controlVersion===previous.state.controlVersion && (next.state.snapshotVersion<previous.state.snapshotVersion ||
        next.state.snapshotVersion===previous.state.snapshotVersion && next.page.feedbackVersion<previous.page.feedbackVersion))) return
    acceptedRead.current=next
    setLoaded(next);setPage(previous=>previous??next.page);setError(null)
  },[id])
  useEffect(()=> {
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>
    const poll=async()=> {try{await refresh(controller.signal)}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to update saved results.')}
      if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),1500)}
    void poll();return()=> {++readGeneration.current;++pageGeneration.current;controller.abort();clearTimeout(timer)}
  },[refresh])
  if(!loaded||!page||!attempt||!id) return <p role={error?'alert':'status'} className="p-3 text-secondary">{error??'Loading saved extraction results…'}</p>
  const state=loaded.state,terminal=state.status==='STOPPED'||state.status==='STOPPING'
  const idle=['PAUSED','FAILED','COMPLETED'].includes(state.status)
  const command=async(action:string)=> {
    setBusy(true);setError(null)
    try {await durableRequest(`${durableRoot(id)}/control`,{id:crypto.randomUUID(),expectedVersion:state.controlVersion,action});await refresh()}
    catch(e){setError(e instanceof Error?e.message:'Unable to save control.')}
    finally{setBusy(false)}
  }
  const selectPage=async(url:string)=> {
    const generation=++pageGeneration.current
    try {const next=await durableRequest<DurablePage>(url);if(generation===pageGeneration.current)setPage(next)}
    catch(error){if(generation===pageGeneration.current)setError(error instanceof Error?error.message:'Unable to load the saved snapshot.')}
  }
  const saved=()=> {++pageGeneration.current;setReview(null);setEditing(false);setPage(null);void refresh()}
  const values=page.values.filter(v=>filter==='all'||v.correction?.decision.action!=='APPROVED')
  return <div className="flex h-full min-h-0 flex-col">
    <div className="shrink-0 space-y-2 border-b border-line p-3">
      <p role="status" aria-atomic="true" className="text-secondary font-semibold">{state.status.toLowerCase()} · {state.counts.saved} calls saved · {state.counts.inFlight} in flight</p>
      {!readOnly&&<div className="flex flex-wrap gap-2">
        {['QUEUED','RUNNING','PAUSING'].includes(state.status)&&<Button disabled={busy||state.status==='PAUSING'} onClick={()=>void command('pause')}>{state.status==='PAUSING'?'Saving in-flight work…':'Pause'}</Button>}
        {['PAUSED','PAUSING','FAILED'].includes(state.status)&&<Button variant="positive" disabled={busy||Boolean(state.pendingSelection)} onClick={()=>void command(state.status==='FAILED'?'retry':'resume')}>{state.pendingResume?'Resume requested':state.status==='FAILED'?'Retry':'Resume'}</Button>}
        {!terminal&&<Button variant="danger" disabled={busy} onClick={()=>void command('stop')}>Stop</Button>}
        {!terminal&&<Button disabled={busy} onClick={()=> {setEditing(true);void command('editing')}}>Change inputs</Button>}
      </div>}
      {state.pendingSelection&&<div className="space-y-2 text-secondary"><p>Changes pending — apply or discard, then resume.</p><div className="flex gap-2">
        <Button variant="positive" disabled={!idle||busy||state.pendingSelection.id===state.selection.id} onClick={()=> {setBusy(true);void durableRequest(`${durableRoot(id)}/adopt`,{expectedVersion:state.controlVersion,selectionId:state.pendingSelection.id,reprocessValueIds:[...reprocess]}).then(()=>{setReprocess(new Set());saved()}).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>Apply changes</Button>
        <Button disabled={busy} onClick={()=>void command('discard')}>Discard changes</Button>
      </div><details><summary className="cursor-pointer">Reprocess completed values (optional)</summary><p className="text-compact text-ink-muted">Selected values receive new model versions. Earlier versions and corrections remain saved.</p>
        {page.values.filter(v=>v.processing==='saved').map(v=><label key={v.id} className="flex gap-2"><input type="checkbox" checked={reprocess.has(v.id)} onChange={e=>setReprocess(previous=>{const next=new Set(previous);if(e.target.checked)next.add(v.id);else next.delete(v.id);return next})}/>{v.node.name} · {v.recordId.slice(0,8)}</label>)}
      </details></div>}
      {editing&&<Inputs attempt={attempt} state={state} currentSchema={currentSchema} onSaved={saved}/>}
      {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
      {notice&&<p role="status" className="text-secondary">{notice}</p>}
      <p className="text-compact text-ink-muted">Snapshot {page.snapshotVersion} · {page.total} retained values · saved input selection {state.selection.ordinal}. Recall is unmeasured.</p>
      {state.snapshotVersion>page.snapshotVersion&&<Button onClick={()=> {++pageGeneration.current;setPage(loaded.page)}}>Show new saved results</Button>}
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <ProjectFeedback projectId={state.projectId} target={id} revision={`${state.selection.id}:${loaded.page.feedbackVersion}`}/>
      <History key={`${id}:${state.snapshotVersion}:${state.selection.id}`} id={id} onSnapshot={version=>void selectPage(`${durableRoot(id)}/values?snapshotVersion=${version}`)}/>
      {page.coverage?.historicalProposals&&Object.keys(page.coverage.historicalProposals).length>0&&<details className="rounded-md border border-line p-3"><summary className="cursor-pointer text-secondary font-semibold">Remaining-source proposals need review</summary><pre className="whitespace-pre-wrap break-words text-compact">{JSON.stringify(page.coverage.historicalProposals,null,2)}</pre></details>}
      <div className="flex flex-wrap gap-2"><Button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>All saved</Button><Button aria-pressed={filter==='attention'} onClick={()=>setFilter('attention')}>Needs review</Button>
        <Button onClick={()=>void readDurableHistory(id).then(history=>import('./durableExport').then(module=>module.downloadDurableExport({state,page,history},'xlsx'))).catch(e=>setError(e.message))}>Export XLSX</Button>
        <Button onClick={()=>void readDurableHistory(id).then(history=>import('./durableExport').then(module=>module.downloadDurableExport({state,page,history},'csv'))).catch(e=>setError(e.message))}>Export CSV bundle</Button>
      </div>
      {review&&<ValueReview key={`${id}:${review.value.id}:${review.version}`} id={id} value={review.value} snapshotVersion={review.version} document={document} onSaved={saved} onClose={()=>setReview(null)} onEvidence={onEvidence}/>}
      {values.map(value=><article key={value.id} className="space-y-1 rounded-md border border-line bg-surface p-3">
        <p className="text-secondary font-semibold">{value.node.name}</p><p className="break-words whitespace-pre-wrap text-secondary text-ink">{JSON.stringify(value.correction?.decision.action==='EDITED'?value.correction.decision.value:value.modelValue)}</p>
        <p className="text-compact text-ink-muted">{value.processing} · {value.grounding} · schema {value.schemaRevisionId.slice(0,8)}</p>
        {value.historicalCorrection&&<p className="text-secondary text-ink-muted">A historical correction is saved but incompatible with this value.</p>}
        {value.evidence.map(e=><Button key={e.anchorId} onClick={()=>onEvidence(e.anchorId)}>View Evidence</Button>)}
        {!readOnly&&value.processing==='saved'&&<Button onClick={()=>setReview({value,version:page.snapshotVersion})}>{value.correction?'Review saved decision':'Review value'}</Button>}
      </article>)}
      {!values.length&&<p className="text-secondary text-ink-muted">No saved values in this view yet. Completed work will appear here as it is saved.</p>}
      {page.next&&<Button onClick={()=>void selectPage(`${durableRoot(id)}/values?${new URLSearchParams(Object.entries(page.next!).map(([k,v])=>[k,String(v)]))}`)}>Next saved page</Button>}
      {!readOnly&&page.total>0&&<Button onClick={()=>void durableRequest(`${durableRoot(id)}/finalize`,{snapshotVersion:page.snapshotVersion,feedbackVersion:page.feedbackVersion}).then(()=>{setError(null);setNotice('This saved review snapshot is finalized.')}).catch(e=>setError(e.message))}>Finalize this snapshot</Button>}
    </div>
  </div>
}
