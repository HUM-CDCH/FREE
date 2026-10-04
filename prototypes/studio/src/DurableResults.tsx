import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useMachine } from '@xstate/react'
import type { DurablePage, DurableHistory } from 'extraction/durable-types'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { decodeParsedDocument, type ParsedDocument } from 'extraction/parsed-document'
import { durableRequest, durableRoot, readDurable, readDurableHistory, type PinnedExtractionSource, type DurableReviewProgress } from './durableExtractionApi'
import { durableReviewMachine } from './durableReviewMachine'
import Button from './ui/Button'
import { DurableInputs } from './DurableInputs'
import { ProjectFeedback } from './ProjectFeedback'
import ReviewRow from './ReviewRow'
import ReviewFocus from './ReviewFocus'
import ReviewList from './ReviewList'
import ResultsHeader from './ResultsHeader'
import { durableRailModel, durableRailRow } from './durableRailModel'
import { evidenceQuote } from './evidenceQuote'
import { nextToCheck, previousInRecord, queuePosition, reviewQueue } from './reviewQueue'
import { shownValue, stateLabel, type RailRow, type ValueFilter } from './reviewVocabulary'
import type { EvidenceLink } from '../shared/groundedExtraction'
import type { MarkInfo } from './useEvidenceOverlays'
import {savedCorrectionHref,savedReviewCut} from './durableReviewLinks'
import { keyAction } from './reviewKeys'

type Value=DurablePage['values'][number]
const inputClass='w-full rounded-md border border-line bg-surface px-3 py-2 text-secondary text-ink focus-visible:outline-accent'
function ValueReview({id,projectId,sourceDocumentId,article,value,snapshotVersion,document,onSaved,onClose,onEvidence,focus,onNext,onPrevious,onGo,onFocus,queue,keyboardRoot,menuOpen,detailsOpen,onCloseOverlay,readOnly=false}:{
  id:string;value:Value;snapshotVersion:number;document:ParsedDocument|null;onSaved:()=>void;onClose:()=>void;
  onEvidence:(id:string,occurrenceIds?:readonly string[])=>void;focus:boolean;onNext:()=>void;onPrevious:()=>void;onGo:(key:string)=>void;
  queue:ReturnType<typeof reviewQueue>;readOnly?:boolean;
  onFocus:()=>void;
  keyboardRoot:RefObject<HTMLDivElement|null>;
  menuOpen:boolean;detailsOpen:boolean;onCloseOverlay:(overlay:'menu'|'drawer')=>void;
  projectId:string;sourceDocumentId:string;article:boolean;
}) {
  const [state,send]=useMachine(durableReviewMachine,{input:{extractionId:id,value,snapshotVersion}})
  const [editing,setEditing]=useState(false)
  const headingRef=useRef<HTMLHeadingElement>(null)
  useEffect(()=>{if(focus&&!editing&&!menuOpen&&!detailsOpen)headingRef.current?.focus({preventScroll:true})},[focus,editing,menuOpen,detailsOpen])
  useEffect(()=> {if(state.matches('saved')) onSaved()},[state,onSaved])
  const row=durableRailRow(state.context.value,document)
  const busy=state.matches('saving')||state.matches('reloading')||state.matches('undoing')
  const quote=row.link&&document?evidenceQuote(document,row.link.evidenceAnchorId,row.link.grounding?.raw??null,value.modelValue):null
  const position=queuePosition(queue,value.id)
  const decide=(action:'APPROVED'|'EDITED'|'REJECTED'|'PENDING',edited?:unknown)=> {
    if(action==='EDITED')send({type:'edit',draft:{...state.context.draft,value:edited}})
    send({type:'save',action})
  }
  const common={quote,last:false,editing,node:value.node,onDecide:decide,onEdit:()=>setEditing(true),
    onCancelEdit:()=>setEditing(false),onUndo:()=>send({type:'undo'}),onTypedEdit:(edited:unknown)=>decide('EDITED',edited)}
  useEffect(()=> {
    const root=keyboardRoot.current
    if(!focus||busy||readOnly||!root)return
    const keys=(event:KeyboardEvent)=> {
      if(event.defaultPrevented||root.closest('[hidden]')||event.target instanceof HTMLElement&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return
      const action=keyAction(event,{readable:true,saving:busy,editing,dialog:false,drawer:detailsOpen,menu:menuOpen,
        oneByOne:focus,canUndo:row.kind!=='to-check',current:row.kind==='to-check'?'open':'decided'})
      if(!action)return
      event.preventDefault();event.stopPropagation()
      if(action==='cancel-edit')setEditing(false)
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
        recordLabel={`Record ${position?.record??1}`} label={`Snapshot ${snapshotVersion}`} upNext={queue.filter(item=>item.key!==value.id&&item.row.kind==='to-check').slice(0,3)}
        end={null} headingRef={headingRef} onNext={onNext} onPrevious={onPrevious} onGo={onGo} onContinue={()=>onNext()} onBack={onClose}/>
        :<ReviewRow {...common} row={row} selected pinned={false} onSelect={onClose} canDecide={!busy&&!readOnly&&Boolean(row.retained?.reviewable)}
          saved={readOnly} onReviewFromHere={onFocus}/>}
      {!readOnly&&<div className="space-y-2 border-t border-line px-3 pt-2">
        {value.correction&&value.correction.decision.action!=='PENDING'&&<Button onClick={()=>decide('PENDING')}>Mark pending</Button>}
        <label className="flex gap-2 text-secondary"><input type="checkbox" checked={state.context.draft.included}
          onChange={event=>send({type:'edit',draft:{...state.context.draft,included:event.target.checked}})}/>Use an edited correction as Project guidance</label>
        <p className="text-compact text-ink-muted">Guidance teaches a pattern; it does not supply another document’s facts. Evidence is optional.</p>
        <label className="block text-secondary">Link correction Evidence from this source
          <select className={`${inputClass} mt-1`} value={state.context.draft.evidence[0]?JSON.stringify([state.context.draft.evidence[0].anchorId,state.context.draft.evidence[0].occurrenceIds[0]]):''} onChange={event=> {
            const selected=event.target.value?JSON.parse(event.target.value) as [string,string]:null
            send({type:'edit',draft:{...state.context.draft,evidence:selected?[{anchorId:selected[0],occurrenceIds:[selected[1]]}]:[]}})
          }}><option value="">No correction Evidence linked</option>{document?.evidence_index.anchors.flatMap(anchor=>anchor.producer_observations.map(occurrence=><option key={`${anchor.anchor_id}:${occurrence.occurrence_id}`} value={JSON.stringify([anchor.anchor_id,occurrence.occurrence_id])}>Page {occurrence.page_number} · {anchor.anchor_id} · {occurrence.occurrence_id}</option>))}</select>
        </label>
      </div>}
    </fieldset>
    {value.links.map((link,index)=><Button key={`${link.evidenceAnchorId}:${index}`} onClick={()=>onEvidence(link.evidenceAnchorId)}>
      Model Evidence · {link.resultPath.slice(2).join(' › ')}{link.precision==='input'?' · whole page':''}</Button>)}
    {value.correction?.decision.evidence.map((evidence:{anchorId:string;occurrenceIds:string[]})=><Button key={evidence.anchorId} onClick={()=>onEvidence(evidence.anchorId,evidence.occurrenceIds)}>Correction Evidence</Button>)}
    {value.historicalCorrection&&<p className="text-secondary">An incompatible correction remains saved. <a className="text-accent underline" href={savedCorrectionHref(projectId,sourceDocumentId,value.historicalCorrection)}>Open historical correction and review · revision {value.historicalCorrection.revision}</a></p>}
    {state.context.error&&<div className="space-y-2"><p role="alert" className="text-secondary text-danger">{state.context.error}</p><Button disabled={busy} onClick={()=>send({type:'refresh'})}>Reload saved decision · keep my draft</Button></div>}
    {(state.context.error||state.context.comparing)&&<section aria-label="Compare saved value and draft" className="space-y-2 rounded-md border border-line p-3 text-secondary">
      <p className="text-compact text-ink-muted">Save replaces the whole field. Compare the saved value with your draft before retrying. Reinspect reordered arrays and changed shapes.</p>
      <dl className="space-y-1"><dt className="font-semibold">Saved value in this view</dt><dd className="m-0 break-words">{JSON.stringify(row.value)}</dd>
        <dt className="font-semibold">Your whole-value draft</dt><dd className="m-0 break-words">{JSON.stringify(state.context.draft.value)}</dd></dl>
    </section>}
    {busy&&<p role="status" className="text-secondary">Saving your decision…</p>}
    <Button onClick={onClose}>Close value</Button>
  </section>
}

function History({id,onSnapshot}:{id:string;onSnapshot:(version:number,feedbackVersion?:number)=>void}) {
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
      {history.captures?.map(capture=><details key={capture.id} className="text-secondary">
        <summary className="cursor-pointer">Call · {capture.descriptor.stage} · input selection {history.selections.find(selection=>selection.id===capture.selectionId)?.ordinal??capture.selectionId.slice(0,8)} · decisions {capture.feedbackVersion}</summary>
        <p className="text-compact text-ink-muted">This call keeps its captured guidance even when a correction is later excluded or superseded.</p>
        <p className="text-compact text-ink-muted">{capture.outputDigest?'Saved output':'No saved output'} · capture {capture.id}</p>
        <details><summary className="cursor-pointer">{capture.invoked?'Consumed guidance and omitted candidates':'Captured guidance and omitted candidates'}</summary>
          <p className="text-compact text-ink-muted">Omissions are evaluated for this call’s target and budget.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify({examples:capture.request?.examples??[],omissions:capture.request?.omissions??[],budget:capture.request?.budget??null,candidates:capture.candidates},null,2)}</pre>
        </details>
        <details><summary className="cursor-pointer">Exact producing request and output</summary><pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify({descriptor:capture.descriptor,inputDigest:capture.inputDigest,request:capture.request,outputDigest:capture.outputDigest,output:capture.output},null,2)}</pre></details>
      </details>)}
      {history.snapshots.map(snapshot=><details key={snapshot.id} className="text-secondary">
        <summary className="cursor-pointer">Saved result snapshot {snapshot.version} · {snapshot.values.length} values</summary>
        <Button onClick={()=>onSnapshot(snapshot.version)}>Open snapshot {snapshot.version}</Button>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-compact">{JSON.stringify(snapshot.values.map((v:Value)=>({field:v.node.name,schema:v.schemaRevisionId,selection:v.selectionId,modelValue:v.modelValue,lineage:v.lineage})),null,2)}</pre>
      </details>)}
      {history.finalizations.map(finalization=><Button key={finalization.id} onClick={()=>onSnapshot(finalization.snapshotVersion,finalization.feedbackVersion)}>
        Open finalized review · results {finalization.snapshotVersion} · decisions {finalization.feedbackVersion}
      </Button>)}
    </div>}
  </details>
}

/** Durable live review in the existing results rail. All lifecycle states
 * share the same retained snapshot and independent researcher decisions. */
export function DurableResults({attempt,document:currentDocument,documentRevisionId,currentSchema,onEvidence,readOnly=false,onResultPathChange,onFocusEvidence,onMarksChange,selectValueRef,headerExtras,onStatusChange,onPinnedDocument,onReviewProgress}:{attempt:ExtractionAttempt|null;document:ParsedDocument|null;documentRevisionId?:string;currentSchema:string|null;onEvidence:(id:string,occurrenceIds?:readonly string[])=>void;readOnly?:boolean;
  onResultPathChange?:(path:string[]|null)=>void;onFocusEvidence?:(link:EvidenceLink|null)=>void;
  onMarksChange?:(marks:{describe:ReadonlyMap<string,MarkInfo>;selected:string|null;savedLinks:{key:string;link:EvidenceLink;occurrenceIds?:string[]}[]}|null)=>void;
  selectValueRef?:RefObject<((key:string)=>void)|null>;headerExtras?:React.ReactNode;
  onStatusChange?:(id:string,status:ExtractionAttempt['executionStatus'])=>void;
  onPinnedDocument?:(id:string,source:PinnedExtractionSource|null)=>void;
  onReviewProgress?:(progress:DurableReviewProgress|null)=>void;
}) {
  const id=attempt?.extractionId
  const keyboardRoot=useRef<HTMLDivElement>(null)
  const [loaded,setLoaded]=useState<Awaited<ReturnType<typeof readDurable>>|null>(null)
  const [page,setPage]=useState<DurablePage|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false)
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
  const [filter,setFilter]=useState<ValueFilter>('check')
  const [focus,setFocus]=useState(false),[detailsOpen,setDetailsOpen]=useState(false),[menuOpen,setMenuOpen]=useState(false)
  const [closedRecords,setClosedRecords]=useState<Set<string>>(()=>new Set())
  const selectedGeneration=useRef(0),linkedValue=useRef(new URLSearchParams(window.location.search).get('value'))
  const linkedCut=useRef(savedReviewCut(window.location.search))
  const model=useMemo(()=>page?durableRailModel(page,document):null,[page,document])
  const queue=useMemo(()=>model?[...model.document.filter(row=>row.retained?.reviewable).map(row=>({key:row.key,record:-1,row})),...reviewQueue(model)]:[],[model])
  const selectValue=useCallback((key:string)=> {
    const generation=++selectedGeneration.current
    const value=page?.values.find(each=>each.id===key)
    if(value&&page)setReview(previous=>previous?.value.id===key&&previous.version===page.snapshotVersion&&previous.feedbackVersion===page.feedbackVersion?previous:{value,version:page.snapshotVersion,feedbackVersion:page.feedbackVersion})
    else if(page&&id)void durableRequest<DurablePage>(`${durableRoot(id)}/values/${encodeURIComponent(key)}?snapshotVersion=${page.snapshotVersion}&feedbackVersion=${page.feedbackVersion}`).then(result=> {
      if(generation!==selectedGeneration.current)return
      if(result.values[0])setReview({value:result.values[0],version:result.snapshotVersion,feedbackVersion:result.feedbackVersion})
      else setError('That value is not saved in this snapshot.')
    }).catch(error=>{if(generation===selectedGeneration.current)setError(error.message)})
  },[page,id])
  useEffect(()=>{if(page&&linkedValue.current){const key=linkedValue.current;linkedValue.current=null;selectValue(key)}},[page,selectValue])
  useEffect(()=>()=>{++selectedGeneration.current},[])
  useEffect(()=>{if(selectValueRef)selectValueRef.current=selectValue;return()=>{if(selectValueRef)selectValueRef.current=null}},[selectValueRef,selectValue])
  useEffect(()=> {
    if(!model||!page)return
    const rows=[...model.document,...model.records.flatMap(record=>record.rows)]
    if(review){const row=durableRailRow(review.value,document),index=rows.findIndex(each=>each.key===row.key);if(index<0)rows.push(row);else rows[index]=row}
    const describe=new Map(rows.map(row=>[row.key,{name:row.name,value:shownValue(row.value),word:row.kind==='to-check'?null:stateLabel(row),style:row.chip?.style??'neutral',anchorId:row.link?.evidenceAnchorId??''}]))
    const displayed=review?[...page.values.filter(value=>value.id!==review.value.id),review.value]:page.values
    const savedLinks=displayed.flatMap(value=>[
      ...value.links.map(link=>({key:value.id,link})),
      ...(value.correction?.decision.evidence??[]).map((evidence:{anchorId:string;occurrenceIds:string[]})=>({key:value.id,link:{resultPath:value.path,evidenceAnchorId:evidence.anchorId},occurrenceIds:evidence.occurrenceIds})),
    ])
    onMarksChange?.({describe,selected:review?.value.id??null,savedLinks})
  },[model,page,onMarksChange,review,document])
  useEffect(()=>()=>{onMarksChange?.(null);onFocusEvidence?.(null);onResultPathChange?.(null)},[onMarksChange,onFocusEvidence,onResultPathChange])
  useEffect(()=> {
    const link=review?.value.links[0]??null
    onFocusEvidence?.(focus?link:null)
    onResultPathChange?.(review?review.value.path.map(String):[])
    if(focus&&link)onEvidence(link.evidenceAnchorId)
  },[focus,review,onFocusEvidence,onResultPathChange,onEvidence])
  const executionStatus=loaded?.state.status
  useEffect(()=>{if(id&&executionStatus)onStatusChange?.(id,executionStatus)},[id,executionStatus,onStatusChange])
  useEffect(()=> {
    if(id&&page)onReviewProgress?.({extractionId:id,snapshotVersion:page.snapshotVersion,feedbackVersion:page.feedbackVersion,
      required:page.reviewCounts.required,toCheck:page.reviewCounts.toCheck,finalized:Boolean(page.finalization)})
  },[id,page,onReviewProgress])
  useEffect(()=>()=>onReviewProgress?.(null),[onReviewProgress])
  const readGenerations=useRef({live:0,snapshot:0})
  const acceptedRead=useRef<Awaited<ReturnType<typeof readDurable>>|null>(null)
  const refresh=useCallback(async(signal?:AbortSignal)=> {
    if(!id) return
    const generation=++readGenerations.current.live
    let next:Awaited<ReturnType<typeof readDurable>>
    try {next=await readDurable(id,signal)}
    catch(error){if(signal?.aborted||generation!==readGenerations.current.live)return;throw error}
    let initialPage=next.page
    if(!acceptedRead.current&&linkedCut.current) {
      const cut=linkedCut.current
      initialPage=await durableRequest<DurablePage>(`${durableRoot(id)}/values?snapshotVersion=${cut.snapshotVersion}&feedbackVersion=${cut.feedbackVersion}`,undefined,signal)
    }
    if(signal?.aborted||generation!==readGenerations.current.live) return
    const previous=acceptedRead.current
    if(previous && (next.state.controlVersion<previous.state.controlVersion ||
      next.state.controlVersion===previous.state.controlVersion && (next.state.snapshotVersion<previous.state.snapshotVersion ||
        next.state.snapshotVersion===previous.state.snapshotVersion && next.page.feedbackVersion<previous.page.feedbackVersion))) return
    acceptedRead.current=next
    setLoaded(next);setPage(previous=>previous??initialPage);setError(null)
  },[id])
  useEffect(()=> {
    const generations=readGenerations.current
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>
    const poll=async()=> {try{await refresh(controller.signal)}catch(e){if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Unable to update saved results.')}
      if(!controller.signal.aborted)timer=setTimeout(()=>void poll(),1500)}
    void poll();return()=> {++generations.live;++generations.snapshot;controller.abort();clearTimeout(timer)}
  },[refresh])
  if(!loaded||!page||!attempt||!id||!model) return <p role={error?'alert':'status'} className="p-3 text-secondary">{error??'Loading saved extraction results…'}</p>
  const state=loaded.state,terminal=state.status==='STOPPED'||state.status==='STOPPING'
  const idle=['PAUSED','FAILED','COMPLETED'].includes(state.status)
  const command=async(action:string)=> {
    setBusy(true);setError(null)
    try {await durableRequest(`${durableRoot(id)}/control`,{id:crypto.randomUUID(),expectedVersion:state.controlVersion,action});await refresh();return true}
    catch(e){setError(e instanceof Error?e.message:'Unable to save control.');return false}
    finally{setBusy(false)}
  }
  const selectPage=async(url:string)=> {
    ++selectedGeneration.current
    const generation=++readGenerations.current.snapshot
    try {const next=await durableRequest<DurablePage>(url);if(generation===readGenerations.current.snapshot){setPage(next);return next}
      return null}
    catch(error){if(generation===readGenerations.current.snapshot)setError(error instanceof Error?error.message:'Unable to load the saved snapshot.');return null}
  }
  const saved=()=> {
    const next=focus?nextToCheck(queue,review?.value.id??null):null
    setReview(null);setEditing(false)
    void selectPage(`${durableRoot(id)}/values?snapshotVersion=${page.snapshotVersion}`).then(nextPage=> {const value=nextPage?.values.find(value=>value.id===next);if(value&&nextPage)setReview({value,version:nextPage.snapshotVersion,feedbackVersion:nextPage.feedbackVersion})})
    void refresh()
  }
  const openNext=()=> {const next=nextToCheck(queue,review?.value.id??null);if(next)selectValue(next);else setReview(null)}
  const finalize=()=>void durableRequest(`${durableRoot(id)}/finalize`,{snapshotVersion:page.snapshotVersion,feedbackVersion:page.feedbackVersion}).then(async()=>{
    await selectPage(`${durableRoot(id)}/values?snapshotVersion=${page.snapshotVersion}&feedbackVersion=${page.feedbackVersion}`)
    setError(null);setNotice('This saved review snapshot is finalized.')
  }).catch(error=>setError(error.message))
  const exportSaved=(format:'xlsx'|'csv')=>void readDurableHistory(id).then(history=>import('./durableExport').then(module=>module.downloadDurableExport({state,page,history},format))).catch(error=>setError(error.message))
  const renderValue=(row:RailRow,pinned:boolean)=>row.key===review?.value.id&&review.version===page.snapshotVersion&&review.feedbackVersion===page.feedbackVersion?null:<ReviewRow row={row} selected={false} pinned={pinned} onSelect={()=>selectValue(row.key)} quote={null} canDecide={false} saved={readOnly} last={false}
    editing={false} node={null} onDecide={()=>{}} onEdit={()=>{}} onCancelEdit={()=>{}} onUndo={()=>{}}/>
  return <div ref={keyboardRoot} className="flex h-full min-h-0 flex-col">
    <ResultsHeader status={{mark:['QUEUED','RUNNING','PAUSING','STOPPING'].includes(state.status)?'spinner':state.status==='STOPPED'?'stopped':state.status==='FAILED'?'failed':state.status==='COMPLETED'?'completed':'incomplete',
      word:state.status.charAt(0)+state.status.slice(1).toLowerCase(),rest:`· ${state.counts.saved} calls saved · ${state.counts.inFlight} in flight`,
      failure:state.status==='FAILED'?'Processing did not finish. Saved values and decisions remain available; Retry continues failed or unfinished work.':undefined}}
      extras={headerExtras} counts={{...model.counts,...page.reviewCounts}} running={state.status!=='COMPLETED'&&state.status!=='STOPPED'} readOnlyNote={readOnly?'Inspecting saved values':undefined}
      actions={{oneByOne:!readOnly&&!focus?{disabled:queue.length===0?'No saved values to review':null}:null,approveRest:null,
        saveReview:!readOnly&&!page.finalization&&page.total>0&&page.reviewCounts.toCheck===0,list:focus}}
      breakdown={`Snapshot ${page.snapshotVersion} · ${page.total} retained values · ${page.reviewCounts.approved} approved · ${page.reviewCounts.edited} edited · ${page.reviewCounts.rejected} rejected · Recall is unmeasured`}
      chips={!focus} filter={filter} onFilter={setFilter} detailsOpen={detailsOpen} menuOpen={menuOpen}
      onDetails={()=>setDetailsOpen(open=>!open)} onMenu={()=>setMenuOpen(open=>!open)} onSchema={()=>setDetailsOpen(true)} onWhy={()=>setDetailsOpen(true)} onShowDetails={()=>setDetailsOpen(true)}
      onOneByOne={()=>{setFocus(true);openNext()}} onApproveRest={()=>{}} onSaveReview={finalize} onList={()=>setFocus(false)}/>
    <div className="shrink-0 space-y-2 border-b border-line p-3">
      {detailsOpen&&<div className="space-y-2 text-secondary"><p>Saved input selection {state.selection.ordinal}. Earlier values retain their own producing schema and settings. Processing and review completion are separate.</p>
        {state.failure&&<p>Recorded processing failure: {state.failure.code}</p>}</div>}
      {menuOpen&&<div role="menu" className="flex flex-wrap gap-2"><Button role="menuitem" onClick={()=>exportSaved('xlsx')}>Export XLSX</Button><Button role="menuitem" onClick={()=>exportSaved('csv')}>Export CSV bundle</Button></div>}
      {!readOnly&&<div className="flex flex-wrap gap-2">
        {['QUEUED','RUNNING','PAUSING'].includes(state.status)&&<Button disabled={busy||state.status==='PAUSING'} onClick={()=>void command('pause')}>{state.status==='PAUSING'?'Saving in-flight work…':'Pause'}</Button>}
        {['PAUSED','PAUSING','FAILED'].includes(state.status)&&<Button variant="positive" disabled={busy||Boolean(state.pendingSelection)} onClick={()=>void command(state.status==='FAILED'?'retry':'resume')}>{state.pendingResume?'Resume requested':state.status==='FAILED'?'Retry':'Resume'}</Button>}
        {!terminal&&<Button variant="danger" disabled={busy} onClick={()=>void command('stop')}>Stop</Button>}
        {!terminal&&<Button disabled={busy} onClick={()=>void command('editing').then(accepted=>{if(accepted)setEditing(true)})}>Change inputs</Button>}
      </div>}
      {state.pendingSelection&&<div className="space-y-2 text-secondary"><p>Changes pending — apply or discard, then resume.</p><div className="flex gap-2">
        <Button variant="positive" disabled={!idle||busy||state.pendingSelection.id===state.selection.id} onClick={()=> {setBusy(true);void durableRequest(`${durableRoot(id)}/adopt`,{expectedVersion:state.controlVersion,selectionId:state.pendingSelection.id,reprocessValueIds:[...reprocess]}).then(()=>{setReprocess(new Set());saved()}).catch(e=>setError(e.message)).finally(()=>setBusy(false))}}>Apply changes</Button>
        <Button disabled={busy} onClick={()=>void command('discard')}>Discard changes</Button>
      </div><details><summary className="cursor-pointer">Reprocess completed values (optional)</summary><p className="text-compact text-ink-muted">Selected values receive new model versions. Earlier versions and corrections remain saved.</p>
        {page.values.filter(v=>v.processing==='saved').map(v=><label key={v.id} className="flex gap-2"><input type="checkbox" checked={reprocess.has(v.id)} onChange={e=>setReprocess(previous=>{const next=new Set(previous);if(e.target.checked)next.add(v.id);else next.delete(v.id);return next})}/>{v.node.name} · {v.recordId.slice(0,8)}</label>)}
      </details></div>}
      {editing&&<DurableInputs attempt={attempt} state={state} currentSchema={currentSchema} onSaved={saved} onEdited={refresh}/>}
      {error&&<p role="alert" className="text-secondary text-danger">{error}</p>}
      {notice&&<p role="status" className="text-secondary">{notice}</p>}
      {loaded.state.sourceRevisionId!==documentRevisionId&&<p className="text-secondary">Review uses the Source Representation saved with this Extraction.</p>}
      <p className="text-compact text-ink-muted">Snapshot {page.snapshotVersion} · {page.total} retained values · saved input selection {state.selection.ordinal}. Recall is unmeasured.</p>
      {page.finalization&&<p role="status" className="text-secondary">Finalized review · results {page.snapshotVersion} · decisions {page.feedbackVersion}. Later work and decisions remain separate.</p>}
      {(state.snapshotVersion>page.snapshotVersion||loaded.page.feedbackVersion>page.feedbackVersion)&&<Button onClick={()=> {++readGenerations.current.snapshot;++selectedGeneration.current;setPage(loaded.page)}}>Show new saved results</Button>}
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
      <ProjectFeedback projectId={state.projectId} target={id} selection={state.pendingSelection?.id} revision={`${state.selection.id}:${loaded.page.feedbackVersion}`}/>
      <History key={`${id}:${state.snapshotVersion}:${state.selection.id}:${page.finalization?.id??''}`} id={id} onSnapshot={(version,feedback)=>void selectPage(`${durableRoot(id)}/values?snapshotVersion=${version}${feedback===undefined?'':`&feedbackVersion=${feedback}`}`)}/>
      {page.coverage?.historicalProposals&&Object.keys(page.coverage.historicalProposals).length>0&&<details className="rounded-md border border-line p-3"><summary className="cursor-pointer text-secondary font-semibold">Remaining-source proposals need review</summary><pre className="whitespace-pre-wrap break-words text-compact">{JSON.stringify(page.coverage.historicalProposals,null,2)}</pre></details>}
      {review&&<div className="space-y-2 border-b border-line pb-3">
        {(review.version!==page.snapshotVersion||review.feedbackVersion!==page.feedbackVersion)&&<p role="status" className="text-secondary">Your open review stays on results {review.version} and decisions {review.feedbackVersion}. Select a value below to review its displayed version.</p>}
        <ValueReview key={`${id}:${review.value.id}:${review.version}:${review.feedbackVersion}`} id={id} projectId={state.projectId} sourceDocumentId={attempt.sourceDocumentId} article={attempt.strategy==='ARTICLE'} value={review.value} snapshotVersion={review.version} document={document} onSaved={saved}
          onClose={()=>{setReview(null);setFocus(false)}} onEvidence={onEvidence} focus={focus} onFocus={()=>setFocus(true)} onNext={openNext} onPrevious={()=>selectValue(previousInRecord(queue,review.value.id))} onGo={selectValue} queue={queue} keyboardRoot={keyboardRoot}
          menuOpen={menuOpen} detailsOpen={detailsOpen} onCloseOverlay={overlay=>overlay==='menu'?setMenuOpen(false):setDetailsOpen(false)} readOnly={readOnly}/>
      </div>}
      {focus&&!review&&<p role="status" className="py-4 text-center text-secondary">You’re caught up with the saved values on this page. New saved work can be reviewed when it arrives.</p>}
      {!focus&&<ReviewList model={model} article={attempt.strategy==='ARTICLE'} finding={page.total===0&&['QUEUED','RUNNING'].includes(state.status)} filter={filter}
          selectedKey={review?.value.id??null} isOpen={record=>!closedRecords.has(record.key!)}
          onToggle={record=>setClosedRecords(previous=>{const next=new Set(previous);if(next.has(record.key!))next.delete(record.key!);else next.add(record.key!);return next})} renderRow={renderValue}/>}
      {page.next&&<Button onClick={()=>void selectPage(`${durableRoot(id)}/values?${new URLSearchParams(Object.entries(page.next!).map(([k,v])=>[k,String(v)]))}`)}>Next saved page</Button>}
      {!readOnly&&!page.finalization&&page.total>0&&<Button onClick={finalize}>Finalize this snapshot</Button>}
    </div>
  </div>
}
