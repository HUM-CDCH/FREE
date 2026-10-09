import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useMachine } from '@xstate/react'
import type { DurablePage, DurableHistory, DurableHistorySummary } from 'extraction/durable-types'
import { durableSchemaNodes, type ExportChoices, type ExportFormat } from 'extraction-result-export'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { decodeParsedDocument, type ParsedDocument } from 'extraction/parsed-document'
import { durableRequest, durableRoot, readDurable, readDurableHistory, readDurableHistorySummary, readValues, type DurableState, type PinnedExtractionSource, type DurableReviewProgress } from './durableExtractionApi'
import { durableReviewMachine } from './durableReviewMachine'
import Button from './ui/Button'
import { DurableInputs } from './DurableInputs'
import ExtractionResultExportControl from './ExtractionResultExportControl'
import { ProjectFeedback } from './ProjectFeedback'
import ReviewRow from './ReviewRow'
import ReviewFocus from './ReviewFocus'
import ReviewList from './ReviewList'
import ResultsHeader, { type StatusLine } from './ResultsHeader'
import ResultsMenu from './ResultsMenu'
import { durableRailModel, durableRailRow, type RunProgress } from './durableRailModel'
import { evidenceQuote } from './evidenceQuote'
import { nextToCheck, previousInRecord, queuePosition, reviewQueue } from './reviewQueue'
import { shownValue, stateLabel, type RailModel, type RailRecord, type RailRow, type ValueFilter } from './reviewVocabulary'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { RailMarkState } from './useEvidenceOverlays'
import {savedCorrectionHref,type SavedReviewCut} from './durableReviewLinks'
import { keyAction } from './reviewKeys'

type Value=DurablePage['values'][number]
const inputClass='w-full rounded-md border border-line bg-surface px-3 py-2 text-secondary text-ink focus-visible:outline-accent'
const linkClass='cursor-pointer text-accent underline'
/** Admitted work whose lifecycle can still change without a researcher's command. */
const ACTIVE:ReadonlySet<string>=new Set(['QUEUED','RUNNING','PAUSING','STOPPING'])

/** The status line (results review redesign §2.1) for a durable Extraction: its lifecycle, and how far the run is. */
function statusLine(state:DurableState,model:RailModel,article:boolean,finalized:boolean):StatusLine {
  // Until discovery ends the records listed are those found so far (a pipelined run reads them meanwhile): no total.
  const planned=state.recordsFinal?state.records?.length??null:null,read=model.records.filter(record=>record.state==='finished').length
  const found=state.discovery?.found.length??0
  const kept=model.records.length+model.document.length>0
  switch(state.status) {
    case 'QUEUED': return {mark:'spinner',word:'Queued',rest:'· waiting for the extraction worker'}
    case 'RUNNING': return article?{mark:'spinner',word:'Reading the document',rest:''}
      :planned!==null?{mark:'spinner',word:'Reading records',rest:`· ${read} of ${planned}`}
      :found>0||read>0?{mark:'spinner',word:'Finding records',rest:`· ${found} found so far${read>0?` · ${read} read`:''}`}
      :{mark:'spinner',word:'Starting',rest:'· finding records…'}
    case 'PAUSING': return {mark:'spinner',word:'Pausing',rest:'· saving the calls in flight'}
    case 'STOPPING': return {mark:'spinner',word:'Stopping',rest:'· the run ends after the current call'}
    case 'PAUSED': return {mark:'incomplete',word:'Paused',rest:article?'':planned!==null?`· ${read} of ${planned} records read`
      :read>0?`· ${read} ${read===1?'record':'records'} read`:''}
    case 'STOPPED': return {mark:'stopped',word:'Stopped',rest:kept?'· its saved values stay':'· nothing to review'}
    case 'FAILED': return {mark:'failed',word:'Failed',rest:'',failure:'Its saved values stay; Retry continues the unfinished work.'}
    default: return finalized?{mark:'saved',word:'Review saved',rest:''}
      :{mark:'completed',word:'Completed',rest:article?'· Article':`· Catalog · ${read===0?'no records found':`${read} ${read===1?'record':'records'}`}`}
  }
}

function ValueReview({id,projectId,sourceDocumentId,article,value,snapshotVersion,document,recordLabel,newer=false,onSaved,onClose,focus,onNext,onPrevious,onGo,onFocus,queue,keyboardRoot,menuOpen,detailsOpen,exportOpen,onCloseOverlay,readOnly=false}:{
  id:string;value:Value;snapshotVersion:number;document:ParsedDocument|null;recordLabel:string;onSaved:()=>void;onClose:()=>void;
  /** The results shown now hold another version of this value; the open review stays on its own. */
  newer?:boolean;
  focus:boolean;onNext:()=>void;onPrevious:()=>void;onGo:(key:string)=>void;
  queue:ReturnType<typeof reviewQueue>;readOnly?:boolean;
  onFocus:()=>void;
  keyboardRoot:RefObject<HTMLDivElement|null>;
  menuOpen:boolean;detailsOpen:boolean;exportOpen:boolean;onCloseOverlay:(overlay:'menu'|'drawer'|'dialog')=>void;
  projectId:string;sourceDocumentId:string;article:boolean;
}) {
  const [state,send]=useMachine(durableReviewMachine,{input:{extractionId:id,value,snapshotVersion}})
  const [editing,setEditing]=useState(false)
  const headingRef=useRef<HTMLHeadingElement>(null)
  useEffect(()=>{if(focus&&!editing&&!menuOpen&&!detailsOpen&&!exportOpen)headingRef.current?.focus({preventScroll:true})},[focus,editing,menuOpen,detailsOpen,exportOpen])
  useEffect(()=> {if(state.matches('saved')) onSaved()},[state,onSaved])
  const row=durableRailRow(state.context.value,document)
  const busy=state.matches('saving')||state.matches('reloading')||state.matches('undoing')
  const quote=row.link&&document?evidenceQuote(document,row.link.evidenceAnchorId,row.link.grounding?.raw??null,value.modelValue):null
  const position=queuePosition(queue,value.id)
  // An edit is guidance for the model's later calls by default (`reviewDraft`): the researcher's fix reaches its context.
  const decide=(action:'APPROVED'|'EDITED'|'REJECTED'|'PENDING',edited?:unknown)=> {
    if(action==='EDITED')send({type:'edit',draft:{...state.context.draft,value:edited}})
    send({type:'save',action})
  }
  const common={quote,editing,node:value.node,onDecide:decide,onEdit:()=>setEditing(true),
    onCancelEdit:()=>setEditing(false),onUndo:()=>send({type:'undo'}),onTypedEdit:(edited:unknown)=>decide('EDITED',edited)}
  useEffect(()=> {
    const root=keyboardRoot.current
    if(!focus||readOnly||!root)return
    const keys=(event:KeyboardEvent)=> {
      if(event.defaultPrevented||root.closest('[hidden]')||event.target instanceof HTMLElement&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return
      const action=keyAction(event,{readable:true,saving:busy,editing:editing&&!exportOpen,dialog:exportOpen,drawer:detailsOpen,menu:menuOpen,
        oneByOne:focus,canUndo:row.kind!=='to-check',current:row.kind==='to-check'?'open':'decided'})
      if(!action)return
      event.preventDefault();event.stopPropagation()
      if(action==='cancel-edit')setEditing(false)
      else if(action==='close-dialog')onCloseOverlay('dialog')
      else if(action==='close-drawer')onCloseOverlay('drawer')
      else if(action==='close-menu')onCloseOverlay('menu')
      else if(action==='leave')onClose()
      else if(action==='next')onNext()
      else if(action==='previous')onPrevious()
      else if(action==='undo')send({type:'undo'})
      else if(action==='edit')setEditing(true)
      else if(action==='approve'||action==='reject')decide(action==='approve'?'APPROVED':'REJECTED')
    }
    root.addEventListener('keydown',keys)
    return()=>root.removeEventListener('keydown',keys)
  })
  return <section aria-label={`Review ${value.node.name}`} className="space-y-2">
    <fieldset disabled={busy||readOnly} className="m-0 min-w-0 border-0 p-0">
      {focus?<ReviewFocus {...common} article={article} current={row} items={position?.items??[]} position={position}
        recordLabel={recordLabel} label={recordLabel} upNext={queue.filter(item=>item.key!==value.id&&item.row.kind==='to-check').slice(0,3)}
        end={null} headingRef={headingRef} onNext={onNext} onPrevious={onPrevious} onGo={onGo} onContinue={()=>onNext()} onBack={onClose}/>
        :<ReviewRow {...common} row={row} selected pinned={false} onSelect={onClose} canDecide={!busy&&!readOnly&&Boolean(row.retained?.reviewable)}
          saved={readOnly} onReviewFromHere={onFocus}/>}
      {editing&&!readOnly&&document&&<details className="mx-3 mb-2 text-secondary">
        <summary className="cursor-pointer text-compact text-ink-muted">Link Evidence for your edit (optional)</summary>
        <label className="mt-1 block">Link correction Evidence from this source
          <select className={`${inputClass} mt-1`} value={state.context.draft.evidence[0]?JSON.stringify([state.context.draft.evidence[0].anchorId,state.context.draft.evidence[0].occurrenceIds[0]]):''} onChange={event=> {
            const selected=event.target.value?JSON.parse(event.target.value) as [string,string]:null
            send({type:'edit',draft:{...state.context.draft,evidence:selected?[{anchorId:selected[0],occurrenceIds:[selected[1]]}]:[]}})
          }}><option value="">No correction Evidence linked</option>{document.evidence_index.anchors.flatMap(anchor=>anchor.producer_observations.map(occurrence=><option key={`${anchor.anchor_id}:${occurrence.occurrence_id}`} value={JSON.stringify([anchor.anchor_id,occurrence.occurrence_id])}>Page {occurrence.page_number} · {anchor.anchor_id} · {occurrence.occurrence_id}</option>))}</select>
        </label>
      </details>}
    </fieldset>
    {newer&&<p role="status" className="mx-3 text-compact text-stale-ink">A newer version of this value was saved. Close this one and open the value again to review it.</p>}
    {value.historicalCorrection&&<p className="mx-3 text-compact"><a className={linkClass} href={savedCorrectionHref(projectId,sourceDocumentId,value.historicalCorrection)}>Open the earlier correction</a></p>}
    {state.context.error&&<div className="mx-3 space-y-2"><p role="alert" className="text-secondary text-danger">{state.context.error}</p><Button disabled={busy} onClick={()=>send({type:'refresh'})}>Reload saved decision · keep my draft</Button></div>}
    {(state.context.error||state.context.comparing)&&<section aria-label="Compare saved value and draft" className="mx-3 space-y-2 rounded-md border border-line p-3 text-secondary">
      <p className="text-compact text-ink-muted">Save replaces the whole field. Compare the saved value with your draft before retrying. Reinspect reordered arrays and changed shapes.</p>
      <dl className="space-y-1"><dt className="font-semibold">Saved value in this view</dt><dd className="m-0 break-words">{JSON.stringify(row.value)}</dd>
        <dt className="font-semibold">Your whole-value draft</dt><dd className="m-0 break-words">{JSON.stringify(state.context.draft.value)}</dd></dl>
    </section>}
    {busy&&<p role="status" className="mx-3 text-compact text-ink-muted">Saving your decision…</p>}
  </section>
}

type EffectiveConfiguration = {
  models: Record<string, {key:string;model:string;adapter:string;adapterVersion:number;nativeInfo?:Record<string,unknown>}>
  options: Record<string,unknown>
  planner: number
  protocols: {calls:number;source:string}
}

/** The worker's resolved configuration belongs to the producing selection, never to the current account settings. */
function ProducingMethod({ordinal,requested,effective}:{ordinal:number;requested:unknown;effective:EffectiveConfiguration|undefined}) {
  return <section aria-label={`Method used for input selection ${ordinal}`} className="space-y-2 pt-2">
    <h3 className="m-0 text-secondary font-semibold">Method used</h3>
    <p className="m-0 text-compact font-semibold">Requested method</p>
    <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify(requested,null,2)}</pre>
    {effective ? <>
      <p className="m-0 text-compact font-semibold">Effective model choices</p>
      <dl className="space-y-1 text-compact">
        {Object.entries(effective.models).map(([role,model])=><div key={role}>
          <dt className="font-semibold">{role==='fields'?'Field extraction':role==='reasoning'?'Reasoning':role}</dt>
          <dd className="m-0 break-words">{model.model} · model key {model.key} · {model.adapter} adapter version {model.adapterVersion}</dd>
          {model.nativeInfo&&<dd className="m-0"><details><summary className="cursor-pointer">Native model protocol and identity</summary>
            <pre className="overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(model.nativeInfo,null,2)}</pre>
          </details></dd>}
        </div>)}
      </dl>
      <p className="m-0 text-compact font-semibold">Effective method settings</p>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify(effective.options,null,2)}</pre>
      <p className="m-0 text-compact text-ink-muted">Planner version {effective.planner} · call protocol version {effective.protocols.calls} · source scope {effective.protocols.source}</p>
      <details><summary className="cursor-pointer text-compact">Exact effective configuration</summary>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify(effective,null,2)}</pre>
      </details>
    </> : <p className="m-0 text-compact text-ink-muted">Effective method: Not recorded</p>}
  </section>
}

const savedAt=(at:unknown)=>at?new Date(String(at)).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}):null

/** The full history for audit, read once it is opened: every call's exact request and output and every snapshot's
 *  values, which grow with the run (tens of megabytes for a long Catalog). */
function HistoryAudit({id}:{id:string}) {
  const [history,setHistory]=useState<DurableHistory|null>(null),[error,setError]=useState<string|null>(null)
  useEffect(()=> {
    const controller=new AbortController()
    void readDurableHistory(id,controller.signal).then(setHistory,e=>{if(!controller.signal.aborted)setError(e.message)})
    return()=>controller.abort()
  },[id])
  if(!history)return <p role={error?'alert':'status'} className="pt-2 text-compact text-ink-muted">{error??'Loading…'}</p>
  return <div className="space-y-3 pt-2">
    {history.selections.map(selection=><details key={selection.id}>
      <summary className="cursor-pointer">Input selection {selection.ordinal} · schema {selection.schemaRevisionId.slice(0,8)}</summary>
      <ProducingMethod ordinal={selection.ordinal} requested={selection.method} effective={history.effective?.find(entry=>entry.id===selection.id)?.configuration as EffectiveConfiguration|undefined}/>
      <details><summary className="cursor-pointer">Pinned schema and admission inputs</summary>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify({schema:selection.schemaTree,resolved:selection.resolved},null,2)}</pre>
      </details>
    </details>)}
    {history.captures?.map(capture=><details key={capture.id}>
      <summary className="cursor-pointer">Call · {capture.descriptor.stage} · input selection {history.selections.find(selection=>selection.id===capture.selectionId)?.ordinal??capture.selectionId.slice(0,8)} · decisions {capture.feedbackVersion}</summary>
      <p className="text-compact text-ink-muted">This call keeps its captured guidance even when a correction is later excluded or superseded.</p>
      <p className="text-compact text-ink-muted">{capture.outputDigest?'Saved output':'No saved output'} · capture {capture.id}</p>
      <details><summary className="cursor-pointer">{capture.invoked?'Consumed guidance and omitted candidates':'Captured guidance and omitted candidates'}</summary>
        <p className="text-compact text-ink-muted">Omissions are evaluated for this call’s target and budget.</p>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify({examples:capture.request?.examples??[],omissions:capture.request?.omissions??[],budget:capture.request?.budget??null,candidates:capture.candidates},null,2)}</pre>
      </details>
      <details><summary className="cursor-pointer">Exact producing request and output</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify({descriptor:capture.descriptor,inputDigest:capture.inputDigest,request:capture.request,outputDigest:capture.outputDigest,output:capture.output},null,2)}</pre></details>
    </details>)}
    {history.snapshots.map(snapshot=><details key={snapshot.id}>
      <summary className="cursor-pointer">Saved result snapshot {snapshot.version} · values and lineage</summary>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify(snapshot.values.map((v:Value)=>({field:v.node.name,schema:v.schemaRevisionId,selection:v.selectionId,modelValue:v.modelValue,lineage:v.lineage})),null,2)}</pre>
    </details>)}
  </div>
}

/** Saved versions in plain words; the exact producing inputs and calls stay one disclosure away for audit. */
function History({id,shown,onSnapshot}:{id:string;shown:boolean;onSnapshot:(version:number,feedbackVersion?:number)=>void}) {
  const [history,setHistory]=useState<DurableHistorySummary|null>(null),[error,setError]=useState<string|null>(null),[open,setOpen]=useState(true)
  const [audit,setAudit]=useState(false)
  // The saved versions are read once the tab is shown; a read it stops waiting for is abandoned, and tried again when
  // it is shown again.
  useEffect(()=> {
    if(!shown||!open||history)return
    const controller=new AbortController()
    void readDurableHistorySummary(id,controller.signal).then(summary=>{setHistory(summary);setError(null)},e=>{if(!controller.signal.aborted)setError(e.message)})
    return()=>controller.abort()
  },[id,shown,open,history])
  return <details open={open} className="rounded-md border border-line bg-surface p-3" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-secondary font-semibold">Saved versions</summary>
    {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
    {history&&<div className="space-y-3 pt-2 text-secondary">
      <p className="m-0 text-compact text-ink-muted">Every saved version stays available. Opening one shows it in Results.</p>
      {history.finalizations.length>0&&<section aria-label="Finalized reviews"><h3 className="m-0 text-compact font-semibold">Finalized reviews</h3>
        <ul className="m-0 list-none space-y-1 p-0">{[...history.finalizations].reverse().map(finalization=><li key={finalization.id} className="flex items-center justify-between gap-2">
          <span>Results {finalization.snapshotVersion}{savedAt(finalization.createdAt)&&<span className="text-ink-muted"> · {savedAt(finalization.createdAt)}</span>}</span>
          <Button aria-label={`Open finalized review of results ${finalization.snapshotVersion}`} onClick={()=>onSnapshot(finalization.snapshotVersion,finalization.feedbackVersion)}>Open</Button>
        </li>)}</ul></section>}
      <section aria-label="Saved results"><h3 className="m-0 text-compact font-semibold">Results</h3>
        {history.snapshots.length===0?<p className="m-0 text-compact text-ink-muted">Nothing saved yet.</p>:
        <ul className="m-0 list-none space-y-1 p-0">{[...history.snapshots].reverse().map(snapshot=><li key={snapshot.id} className="flex items-center justify-between gap-2">
          <span>Results {snapshot.version} <span className="text-ink-muted">· {snapshot.valueCount} {snapshot.valueCount===1?'value':'values'}</span></span>
          <Button aria-label={`Open results ${snapshot.version}`} onClick={()=>onSnapshot(snapshot.version)}>Open</Button>
        </li>)}</ul>}
      </section>
      {history.selections.length>0&&<section aria-label="Inputs"><h3 className="m-0 text-compact font-semibold">Schema and model used</h3>
        <ul className="m-0 list-none space-y-1 p-0">{[...history.selections].reverse().map(selection=> {
          const effective=history.effective?.find(entry=>entry.id===selection.id)?.configuration as EffectiveConfiguration|undefined
          const previous=history.selections.find(each=>each.ordinal===selection.ordinal-1)
          return <li key={selection.id}>
            {selection.ordinal===1?'First inputs':`Changed inputs (version ${selection.ordinal})`}
            <span className="text-ink-muted">{savedAt(selection.createdAt)&&` · ${savedAt(selection.createdAt)}`} · {effective?`model ${(effective.models.fields??Object.values(effective.models)[0])?.model??'not recorded'}`:'model not recorded yet'}{previous&&previous.schemaRevisionId!==selection.schemaRevisionId?' · schema changed':''}</span>
          </li>})}</ul></section>}
      <details onToggle={event=>{if(event.currentTarget.open)setAudit(true)}}><summary className="cursor-pointer text-compact text-ink-muted">Technical details (for audit)</summary>
        {audit&&<HistoryAudit id={id}/>}
      </details>
    </div>}
  </details>
}

/** Whether the results shown hold the same version of a value as the open review's. */
const sameValue=(a:Value,b:Value)=>a.selectionId===b.selectionId&&JSON.stringify(a.modelValue)===JSON.stringify(b.modelValue)

/** Durable live review in the results rail (results review redesign §2–§5): the latest saved values while the run
 * goes on, each record as it is read, and the researcher's decisions on them. An edit is guidance for the model's
 * later calls. Pause, Resume and Stop are the workspace's run button's (App). */
export function DurableResults({attempt,initialCut=null,document:currentDocument,documentRevisionId,currentSchema,sourceDocumentName,onEvidence,readOnly=false,onResultPathChange,onFocusEvidence,onMarksChange,selectValueRef,headerExtras,onStatusChange,onPinnedDocument,onReviewProgress,onReviewFinalized,historySlot,historyShown=false,onShowResults,onShowHistory}:{attempt:ExtractionAttempt|null;
  /** The explicit result/decision cut this view opens on, e.g. a finalized
   * review or a saved-correction link; null follows the latest saved results. */
  initialCut?:SavedReviewCut|null;document:ParsedDocument|null;documentRevisionId?:string;currentSchema:string|null;
  /** Names the export file; falls back to the pinned source's own name, then the Extraction's id. */
  sourceDocumentName?:string;onEvidence:(id:string,occurrenceIds?:readonly string[],precision?:EvidenceLink['precision'])=>void;readOnly?:boolean;
  onResultPathChange?:(path:string[]|null)=>void;onFocusEvidence?:(link:EvidenceLink|null)=>void;
  onMarksChange?:(marks:RailMarkState|null)=>void;
  selectValueRef?:RefObject<((key:string)=>void)|null>;headerExtras?:React.ReactNode;
  onStatusChange?:(id:string,status:ExtractionAttempt['executionStatus'])=>void;
  onPinnedDocument?:(id:string,source:PinnedExtractionSource|null)=>void;
  onReviewProgress?:(progress:DurableReviewProgress|null)=>void;
  onReviewFinalized?:()=>void;
  /** The History tab's body: guidance and saved versions render there, not in Results. */
  historySlot?:HTMLElement|null;historyShown?:boolean;onShowResults?:()=>void;onShowHistory?:()=>void;
}) {
  const id=attempt?.extractionId
  const article=attempt?.strategy==='ARTICLE'
  const keyboardRoot=useRef<HTMLDivElement>(null)
  const [loaded,setLoaded]=useState<Awaited<ReturnType<typeof readDurable>>|null>(null)
  const [page,setPage]=useState<DurablePage|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false)
  const [exportState,setExportState]=useState<
    {status:'pending';format:ExportFormat}|{status:'started'}|{status:'failed';message:string}|null
  >(null)
  const [exportOpen,setExportOpen]=useState(false)
  const exportRequest=useRef<AbortController|null>(null)
  const menuButton=useRef<HTMLButtonElement>(null)
  useEffect(()=>()=>{exportRequest.current?.abort()},[])
  const [unfit,setUnfit]=useState(0)
  const [pinnedDocument,setPinnedDocument]=useState<{revision:string;document:ParsedDocument}|null>(null)
  const document=loaded&&loaded.state.sourceRevisionId!==documentRevisionId
    ? pinnedDocument?.revision===loaded.state.sourceRevisionId?pinnedDocument.document:null : currentDocument
  const sourceRevisionId=loaded?.state.sourceRevisionId
  useEffect(()=> {
    if(!id||!sourceRevisionId||sourceRevisionId===documentRevisionId)return
    const controller=new AbortController(),revision=sourceRevisionId
    void durableRequest<PinnedExtractionSource>(`${durableRoot(id)}/source`,undefined,controller.signal).then(source=> {
      if(controller.signal.aborted)return
      const document=decodeParsedDocument(source.document)
      setPinnedDocument({revision,document});onPinnedDocument?.(id,{...source,document})
    }).catch(error=>{if(!controller.signal.aborted)setError(error.message)})
    return()=>{controller.abort();onPinnedDocument?.(id,null)}
  },[id,sourceRevisionId,documentRevisionId,onPinnedDocument])
  const [editing,setEditing]=useState(false),[review,setReview]=useState<{value:Value;version:number;feedbackVersion:number}|null>(null)
  const [reprocess,setReprocess]=useState<Set<string>>(()=>new Set()),[notice,setNotice]=useState<string|null>(null)
  const [filter,setFilter]=useState<ValueFilter>('all')
  const [focus,setFocus]=useState(false),[detailsOpen,setDetailsOpen]=useState(false),[menuOpen,setMenuOpen]=useState(false)
  const [toggledRecords,setToggledRecords]=useState<ReadonlyMap<string,boolean>>(()=>new Map())
  const selectedGeneration=useRef(0),linkedValue=useRef(new URLSearchParams(window.location.search).get('value'))
  const selectionFromMark=useRef<string|null>(null)
  const linkedCut=useRef(initialCut)
  // The view follows the latest saved results, so values and their Evidence appear while the run goes on. Only an
  // explicitly opened cut (a finalized review, a saved-correction link, History's "Open") stays put.
  const [pinned,setPinned]=useState(initialCut!==null)
  const pinnedRef=useRef(pinned)
  const pin=(value:boolean)=>{pinnedRef.current=value;setPinned(value)}
  const state=loaded?.state
  const progress=useMemo<RunProgress|null>(()=>state?{records:state.records,reading:new Set(state.status==='RUNNING'?state.reading:[]),
    fields:(state.selection?.schemaTree?.schemaNodes??[]).filter((node:{valueSource?:unknown})=>!node.valueSource).map((node:{name:string})=>node.name),
    startPage:state.selection?.resolved?.startPage??null}:null,[state])
  const model=useMemo(()=>page?durableRailModel(page,document,pinned?null:progress):null,[page,document,progress,pinned])
  // The export's fields are the shown values' own producing fields, never today's schema reinterpreting them.
  const exportFields=useMemo(()=>page?durableSchemaNodes(page.values,state?.selection?.schemaTree?.schemaNodes):[],[page,state?.selection?.schemaTree?.schemaNodes])
  // Records open as a run reads them; a settled Extraction opens only its first record with a value to check, chosen
  // once so a decision doesn't close it (§3.1). The record holding the reviewed value always opens.
  const [opening,setOpening]=useState<{live:boolean;first:string|undefined}|null>(null)
  if(model&&state&&!opening)setOpening({live:ACTIVE.has(state.status),first:model.records.find(record=>record.toCheck>0)?.key})
  // A resumed or retried run reads again: its records open as they are read, and stay open once it settles.
  else if(opening&&!opening.live&&state&&ACTIVE.has(state.status))setOpening({...opening,live:true})
  const reviewedRecord=review?.value.recordId
  // The record starts discovery has found while it still looks: marked on the source until the records are listed.
  const foundKey=JSON.stringify(state&&!state.recordsFinal?state.discovery?.found??[]:[])
  const found=useMemo(()=>JSON.parse(foundKey) as {segment:string}[],[foundKey])
  const queue=useMemo(()=>model?[...model.document.filter(row=>row.retained?.reviewable).map(row=>({key:row.key,record:-1,row})),...reviewQueue(model)]:[],[model])
  const followRef=useRef({review,onFocusEvidence,onEvidence})
  useEffect(()=>{followRef.current={review,onFocusEvidence,onEvidence}})
  // A chosen value shows in its record, whichever way the researcher last toggled it.
  const reveal=(record:string)=>setToggledRecords(previous=>{if(previous.get(record)!==false)return previous;const next=new Map(previous);next.delete(record);return next})
  const selectValue=useCallback((key:string,fromMark=false)=> {
    selectionFromMark.current=fromMark&&focus?key:null
    const generation=++selectedGeneration.current
    const value=page?.values.find(each=>each.id===key)
    if(value)reveal(value.recordId)
    if(value&&page)setReview(previous=>previous?.value.id===key&&previous.version===page.snapshotVersion&&previous.feedbackVersion===page.feedbackVersion?previous:{value,version:page.snapshotVersion,feedbackVersion:page.feedbackVersion})
    else if(page&&id)void durableRequest<DurablePage>(`${durableRoot(id)}/values/${encodeURIComponent(key)}?snapshotVersion=${page.snapshotVersion}&feedbackVersion=${page.feedbackVersion}`).then(result=> {
      if(generation!==selectedGeneration.current)return
      if(result.values[0]){reveal(result.values[0].recordId);setReview({value:result.values[0],version:result.snapshotVersion,feedbackVersion:result.feedbackVersion})}
      else setError('That value is not saved in this snapshot.')
    }).catch(error=>{if(generation===selectedGeneration.current)setError(error.message)})
  },[page,id,focus])
  // Choosing a value in the list, or opening a link to it, shows its Evidence on the source; one-by-one follows its
  // own, and a mark's selection scrolls nothing (§7.2).
  const choose=useCallback((key:string)=> {
    selectValue(key)
    const value=page?.values.find(each=>each.id===key),link=value?.links[0],own=value?.correction?.decision.evidence[0] as {anchorId:string;occurrenceIds:string[]}|undefined
    if(link)followRef.current.onEvidence(link.evidenceAnchorId,undefined,link.precision)
    else if(own)followRef.current.onEvidence(own.anchorId,own.occurrenceIds)
  },[page,selectValue])
  useEffect(()=>{if(page&&linkedValue.current){const key=linkedValue.current;linkedValue.current=null;choose(key)}},[page,choose])
  useEffect(()=>()=>{++selectedGeneration.current},[])
  useEffect(()=>{if(selectValueRef)selectValueRef.current=key=>selectValue(key,true);return()=>{if(selectValueRef)selectValueRef.current=null}},[selectValueRef,selectValue])
  useEffect(()=> {
    if(!model||!page)return
    const rows=[...model.document,...model.records.flatMap(record=>record.rows)]
    if(review){const row=durableRailRow(review.value,document),index=rows.findIndex(each=>each.key===row.key);if(index<0)rows.push(row);else rows[index]=row}
    const describe=new Map(rows.map(row=>[row.key,{name:row.name,value:shownValue(row.value),word:row.kind==='to-check'?null:stateLabel(row),style:row.chip?.style??'neutral',anchorId:row.link?.evidenceAnchorId??'',precision:row.link?.precision}]))
    const displayed=review?[...page.values.filter(value=>value.id!==review.value.id),review.value]:page.values
    const savedLinks=[...displayed.flatMap(value=>[
      ...value.links.map(link=>({key:value.id,link})),
      ...(value.correction?.decision.evidence??[]).map((evidence:{anchorId:string;occurrenceIds:string[]})=>({key:value.id,link:{resultPath:value.path,evidenceAnchorId:evidence.anchorId},occurrenceIds:evidence.occurrenceIds})),
    ]),...found.map((start,index)=>({key:`found:${index}`,link:{resultPath:['records',index],evidenceAnchorId:`a_${start.segment}`}}))]
    onMarksChange?.({describe,selected:review?.value.id??null,selectableKeys:new Set(rows.map(row=>row.key)),savedLinks})
  },[model,page,onMarksChange,review,document,found])
  useEffect(()=>()=>{onMarksChange?.(null);onFocusEvidence?.(null);onResultPathChange?.(null)},[onMarksChange,onFocusEvidence,onResultPathChange])
  // Every value's marks stay on the source; the chosen one is emphasized among them, not shown alone (§7.2).
  useEffect(()=>{onResultPathChange?.([])},[onResultPathChange])
  const currentLink=review?.value.links[0]??null
  const followKey=focus&&review&&document?`${sourceRevisionId??''}:${document.preprocessing.preprocess_id}:${review.version}:${review.value.id}:${currentLink?.evidenceAnchorId??''}:${currentLink?.precision??''}`:null
  useEffect(()=>{
    const {review,onFocusEvidence,onEvidence}=followRef.current,link=review?.value.links[0]??null
    onFocusEvidence?.(followKey?link:null)
    const fromMark=selectionFromMark.current===review?.value.id
    selectionFromMark.current=null
    if(followKey&&link&&!fromMark)onEvidence(link.evidenceAnchorId,undefined,link.precision)
  },[followKey])
  const executionStatus=state?.status
  useEffect(()=>{if(id&&executionStatus)onStatusChange?.(id,executionStatus)},[id,executionStatus,onStatusChange])
  useEffect(()=> {
    if(id&&page)onReviewProgress?.({extractionId:id,snapshotVersion:page.snapshotVersion,feedbackVersion:page.feedbackVersion,
      required:page.reviewCounts.required,toCheck:page.reviewCounts.toCheck,finalized:Boolean(page.finalization)})
  },[id,page,onReviewProgress])
  useEffect(()=>()=>onReviewProgress?.(null),[onReviewProgress])
  const readGenerations=useRef({live:0,snapshot:0})
  const acceptedRead=useRef<Awaited<ReturnType<typeof readDurable>>|null>(null)
  const refresh=useCallback(async(signal?:AbortSignal)=> {
    if(!id) return null
    const generation=++readGenerations.current.live
    let next:Awaited<ReturnType<typeof readDurable>>
    try {next=await readDurable(id,signal,acceptedRead.current)}
    catch(error){if(signal?.aborted||generation!==readGenerations.current.live)return null;throw error}
    let initialPage=next.page
    if(!acceptedRead.current&&linkedCut.current) {
      const cut=linkedCut.current
      initialPage=await readValues(id,{snapshotVersion:cut.snapshotVersion,feedbackVersion:cut.feedbackVersion},signal)
    }
    if(signal?.aborted||generation!==readGenerations.current.live) return null
    const previous=acceptedRead.current
    if(previous && (next.state.controlVersion<previous.state.controlVersion ||
      next.state.controlVersion===previous.state.controlVersion && (next.state.snapshotVersion<previous.state.snapshotVersion ||
        next.state.snapshotVersion===previous.state.snapshotVersion && next.page.feedbackVersion<previous.page.feedbackVersion))) return previous.page
    acceptedRead.current=next
    setLoaded(next);setPage(previous=>pinnedRef.current?previous??initialPage:initialPage);setError(null)
    return next.page
  },[id])
  useEffect(()=> {
    const generations=readGenerations.current
    return()=> {++generations.live;++generations.snapshot}
  },[refresh])
  // Polled at the run's pace only while it changes by itself, as the workspace's own monitor is; a resume asked for
  // while it paused is started by the server, so that is still watched. A settled Extraction changes by a command, a
  // saved decision or edit, or the workspace's read, each of which reads it again here; a decision saved in another
  // session shows when the researcher comes back to the view, or within 30 s while it is visible.
  const live=!state||ACTIVE.has(state.status)||state.pendingResume
  useEffect(()=> {
    if(!live) {
      const reread=()=>void refresh().catch(()=>{})
      const idle=setInterval(()=>{if(!window.document.hidden)reread()},30_000)
      window.addEventListener('focus',reread)
      return()=>{clearInterval(idle);window.removeEventListener('focus',reread)}
    }
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>
    const poll=async()=> {try{await refresh(controller.signal)}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to update saved results.')}
      if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),1500)}
    void poll();return()=> {controller.abort();clearTimeout(timer)}
  },[refresh,live])
  // The run button follows the workspace's own status reads; one that sees a change first (Pausing → Paused) is read
  // here at once, not at the next poll, so the status line agrees with the button.
  const workspaceStatus=attempt?.executionStatus
  useEffect(()=> {
    const shown=acceptedRead.current?.state.status
    if(workspaceStatus&&shown&&shown!==workspaceStatus)void refresh().catch(()=>{})
  },[workspaceStatus,refresh])
  if(!loaded||!page||!attempt||!id||!model||!state) return <><p role={error?'alert':'status'} className="p-3 text-secondary">{error??'Loading saved extraction results…'}</p>
    {historySlot&&createPortal(<p className="p-3 text-secondary">{error??'Loading…'}</p>,historySlot)}</>
  const terminal=state.status==='STOPPED'||state.status==='STOPPING'
  const active=ACTIVE.has(state.status)
  const idle=['PAUSED','FAILED','COMPLETED'].includes(state.status)
  const command=async(action:string)=> {
    setBusy(true);setError(null)
    try {await durableRequest(`${durableRoot(id)}/control`,{id:crypto.randomUUID(),expectedVersion:state.controlVersion,action});await refresh();return true}
    catch(e){setError(e instanceof Error?e.message:'Unable to save control.');return false}
    finally{setBusy(false)}
  }
  const selectPage=async(query:Record<string,number>)=> {
    pin(true)
    ++selectedGeneration.current
    const generation=++readGenerations.current.snapshot
    try {const next=await readValues(id,query);if(generation===readGenerations.current.snapshot){setPage(next);return next}
      return null}
    catch(error){if(generation===readGenerations.current.snapshot)setError(error instanceof Error?error.message:'Unable to load the saved snapshot.');return null}
  }
  const showLatest=()=>{pin(false);++readGenerations.current.snapshot;++selectedGeneration.current;setPage(loaded.page)}
  // A saved decision moves one-by-one to the next value at once (§4.3); the saved results and counts follow.
  const saved=()=> {
    const next=focus?nextToCheck(queue,review?.value.id??null):null
    setReview(null);setEditing(false)
    if(pinnedRef.current)void selectPage({snapshotVersion:page.snapshotVersion})
    void refresh()
    if(next)selectValue(next)
  }
  const closeReview=()=>{++selectedGeneration.current;setReview(null);setFocus(false)}
  const openNext=()=> {const next=nextToCheck(queue,review?.value.id??null);if(next)selectValue(next);else setReview(null)}
  const finalize=()=>void durableRequest(`${durableRoot(id)}/finalize`,{snapshotVersion:page.snapshotVersion,feedbackVersion:page.feedbackVersion}).then(async()=>{
    await selectPage({snapshotVersion:page.snapshotVersion,feedbackVersion:page.feedbackVersion})
    setError(null);setNotice('Review saved.')
    onReviewFinalized?.()
  }).catch(error=>setError(error.message))
  // The ordinary research table of the cut shown: built from the values already read, so a long run's saved history
  // is never downloaded for it (History stays one tab away for audit).
  const exportSaved=async(format:ExportFormat,choices:ExportChoices)=> {
    if(exportRequest.current)return
    const controller=new AbortController()
    exportRequest.current=controller
    setExportState({status:'pending',format})
    try {
      const module=await import('./durableExport')
      const sourceName=sourceDocumentName??document?.document.source.original_filename??`extraction-${id}`
      await module.downloadDurableExport({state,page},format,choices,sourceName,controller.signal)
      if(!controller.signal.aborted)setExportState({status:'started'})
    } catch(error) {
      if(!controller.signal.aborted)setExportState({status:'failed',message:error instanceof TypeError
        ? 'Could not export: the connection was interrupted. Check your connection and try again.'
        : `Could not export: ${error instanceof Error?error.message:'Unable to prepare the saved values.'} Try again.`})
    } finally {exportRequest.current=null}
  }
  const counts={...model.counts,...page.reviewCounts}
  const canSave=!readOnly&&!active&&!page.finalization&&page.total>0&&page.reviewCounts.toCheck===0
  const latest=loaded.page.snapshotVersion===page.snapshotVersion&&loaded.page.feedbackVersion===page.feedbackVersion
  const recordOf=(key:string)=>model.records.find(record=>record.rows.some(row=>row.key===key))?.label??'Document'
  // The open review stays in its row while newer results arrive (moving it would lose an open edit); only a value the
  // results shown do not hold opens above the list.
  const shownVersion=review?page.values.find(value=>value.id===review.value.id):undefined
  const inline=Boolean(shownVersion)
  const valueReview=review&&<ValueReview key={`${id}:${review.value.id}:${review.version}:${review.feedbackVersion}`} id={id} projectId={state.projectId} sourceDocumentId={attempt.sourceDocumentId} article={article} value={review.value} snapshotVersion={review.version} document={document}
    recordLabel={recordOf(review.value.id)} newer={Boolean(shownVersion)&&!sameValue(review.value,shownVersion!)} onSaved={saved} onClose={closeReview} focus={focus} onFocus={()=>setFocus(true)} onNext={openNext} onPrevious={()=>selectValue(previousInRecord(queue,review.value.id))} onGo={selectValue} queue={queue} keyboardRoot={keyboardRoot}
    menuOpen={menuOpen} detailsOpen={detailsOpen} exportOpen={exportOpen} onCloseOverlay={overlay=>overlay==='dialog'?setExportOpen(false):overlay==='menu'?setMenuOpen(false):setDetailsOpen(false)} readOnly={readOnly}/>
  const isOpen=(record:RailRecord)=>toggledRecords.get(record.key!)??(Boolean(opening?.live)||record.key===opening?.first||record.key===reviewedRecord)
  const renderValue=(row:RailRow,pinnedRow:boolean)=>inline&&row.key===review?.value.id?valueReview:<ReviewRow row={row} selected={false} pinned={pinnedRow} onSelect={()=>choose(row.key)} quote={null} canDecide={false} saved={readOnly}
    editing={false} node={null} onDecide={()=>{}} onEdit={()=>{}} onCancelEdit={()=>{}} onUndo={()=>{}}/>
  return <div ref={keyboardRoot} className="relative flex h-full min-h-0 flex-col"
    onKeyDown={event=>{if(event.key==='Escape'&&menuOpen&&!event.defaultPrevented){event.preventDefault();setMenuOpen(false)}}}>
    <ResultsHeader status={statusLine(state,model,article,Boolean(page.finalization))}
      extras={headerExtras} counts={counts} running={active} readOnlyNote={readOnly?'Read-only: a saved review.':undefined}
      actions={{oneByOne:!readOnly&&!focus?{disabled:queue.length===0?(active?'Available once a record is read':'Nothing to review here'):counts.toCheck===0?'Nothing left to check here':null}:null,
        saveReview:canSave?'Save review':null,list:focus}}
      breakdown={`${counts.approved} approved · ${counts.edited} edited · ${counts.rejected} rejected${page.finalization?' · review saved':''}`}
      chips={!focus} filter={filter} onFilter={setFilter} detailsOpen={detailsOpen} menuOpen={menuOpen} menuRef={menuButton}
      onDetails={()=>setDetailsOpen(open=>!open)} onMenu={()=>setMenuOpen(open=>!open)} onSchema={()=>setDetailsOpen(true)} onWhy={()=>setDetailsOpen(true)} onShowDetails={()=>setDetailsOpen(true)}
      onOneByOne={()=>{setFocus(true);openNext()}} onSaveReview={finalize} onList={()=>{++selectedGeneration.current;setFocus(false)}}/>
    {menuOpen&&<ResultsMenu items={[
      {label:'Export…',disabled:exportState?.status==='pending'?'Exporting…':page.total===0?'Nothing saved to export yet':null,onSelect:()=>{setMenuOpen(false);setExportOpen(true)}},
      ...(!readOnly&&!terminal?[{label:'Change inputs',disabled:busy?'Saving…':null,
        onSelect:()=>{setMenuOpen(false);void command('editing').then(accepted=>{if(accepted)setEditing(true)})}}]:[]),
    ]}/>}
    <ExtractionResultExportControl open={exportOpen} schemaNodes={exportFields} returnFocusRef={menuButton} onDismiss={()=>setExportOpen(false)}
      onExport={(format,choices)=>{setExportOpen(false);void exportSaved(format,choices)}}/>
    {exportState&&<div className="shrink-0 border-b border-line p-3 text-secondary">
      {exportState.status==='failed'
        ? <p role="alert" className="m-0 text-danger">{exportState.message}</p>
        : <p role="status" aria-label="Export progress" className="m-0">
          {exportState.status==='pending'?`Preparing ${exportState.format==='xlsx'?'Excel':'CSV'} export of results ${page.snapshotVersion}…`:'Download started. Check your browser’s downloads.'}
        </p>}
    </div>}
    {(detailsOpen||error||notice||state.pendingSelection||editing||!latest||state.sourceRevisionId!==documentRevisionId)&&<div className="shrink-0 space-y-2 border-b border-line p-3">
      {detailsOpen&&<div className="space-y-1 text-secondary">
        <p className="m-0">Inputs version {state.selection.ordinal}{state.selection.ordinal>1?'; earlier values keep the inputs they were read with':''}.</p>
        {state.failure&&<p className="m-0">Processing failure: {state.failure.code}</p>}
        <p className="m-0 text-ink-muted">Saved versions, the model calls and the corrections the model learns from are in the History tab.</p>
      </div>}
      {state.pendingSelection&&<div className="space-y-2 text-secondary"><p>Changes pending — apply or discard, then resume.</p><div className="flex gap-2">
        <Button variant="positive" disabled={!idle||busy||state.pendingSelection.id===state.selection.id} onClick={()=> {setBusy(true);void durableRequest(`${durableRoot(id)}/adopt`,{expectedVersion:state.controlVersion,selectionId:state.pendingSelection.id,reprocessValueIds:[...reprocess]}).then(()=>{setReprocess(new Set());saved()}).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>Apply changes</Button>
        <Button disabled={busy} onClick={()=>void command('discard')}>Discard changes</Button>
      </div><details><summary className="cursor-pointer">Reprocess completed values (optional)</summary><p className="text-compact text-ink-muted">Selected values receive new model versions. Earlier versions and corrections remain saved.</p>
        {page.values.filter(v=>v.processing==='saved').map(v=><label key={v.id} className="flex gap-2"><input type="checkbox" checked={reprocess.has(v.id)} onChange={e=>setReprocess(previous=>{const next=new Set(previous);if(e.target.checked)next.add(v.id);else next.delete(v.id);return next})}/>{v.node.name} · {v.recordId.slice(0,8)}</label>)}
      </details></div>}
      {editing&&<DurableInputs attempt={attempt} state={state} currentSchema={currentSchema} onSaved={saved} onEdited={async()=>{await refresh()}}/>}
      {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
      {notice&&<p role="status" className="text-secondary">{notice}</p>}
      {state.sourceRevisionId!==documentRevisionId&&<p className="text-secondary">Review uses the Source Representation saved with this Extraction.</p>}
      {!latest&&<p role="status" className="m-0 text-secondary">Showing saved results {page.snapshotVersion}{page.finalization?' · a saved review':''}.{' '}
        <button type="button" className={linkClass} onClick={showLatest}>Show the latest results</button></p>}
    </div>}
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-canvas p-2">
      {state.pendingSelection&&unfit>0&&<p className="m-0 text-secondary">{unfit} saved {unfit===1?'correction doesn’t':'corrections don’t'} fit the pending schema and won’t be shown to the model.{' '}
        {onShowHistory&&<button type="button" className={linkClass} onClick={onShowHistory}>See corrections</button>}</p>}
      {historySlot&&createPortal(<div className="space-y-3 p-3">
        <ProjectFeedback projectId={state.projectId} target={id} selection={state.pendingSelection?.id} revision={`${state.selection.id}:${loaded.page.feedbackVersion}`} onIncompatible={setUnfit} initiallyOpen/>
        <History key={`${id}:${state.snapshotVersion}:${state.selection.id}:${page.finalization?.id??''}`} id={id} shown={historyShown} onSnapshot={(version,feedback)=>{void selectPage({snapshotVersion:version,...(feedback===undefined?{}:{feedbackVersion:feedback})});onShowResults?.()}}/>
      </div>,historySlot)}
      {page.coverage?.historicalProposals&&Object.keys(page.coverage.historicalProposals).length>0&&<details className="rounded-md border border-line p-3"><summary className="cursor-pointer text-secondary font-semibold">Remaining-source proposals need review</summary><pre className="whitespace-pre-wrap break-words text-compact">{JSON.stringify(page.coverage.historicalProposals,null,2)}</pre></details>}
      {review&&(focus||!inline)&&<div className="space-y-2 border-b border-line pb-3">{valueReview}</div>}
      {focus&&!review&&<p role="status" className="py-4 text-center text-secondary">You’re caught up with the saved values. New ones can be reviewed as they arrive.</p>}
      {!focus&&(article&&page.total===0&&active?<p className="m-0 px-1 py-6 text-center text-secondary text-ink-muted">Reading the document…</p>
        :<ReviewList model={model} article={article} finding={!article&&page.total===0&&active&&!state.records} filter={filter}
          selectedKey={review?.value.id??null} isOpen={isOpen}
          onToggle={record=>setToggledRecords(previous=>new Map(previous).set(record.key!,!isOpen(record)))} renderRow={renderValue}/>)}
    </div>
  </div>
}
