// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import { decodeParsedDocument } from 'extraction/parsed-document'
import rawDocument from './assets/parsed_document.v2.json'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { DurableResults } from './DurableResults'
import { durableRequest, readDurable, readDurableHistory } from './durableExtractionApi'

vi.mock('./durableExtractionApi',()=>({durableRequest:vi.fn(),readDurable:vi.fn(),readDurableHistory:vi.fn(),durableRoot:(id:string)=>`/api/extractions/${id}/durable`}))
afterEach(()=>{cleanup();vi.resetAllMocks();window.history.replaceState(null,'','/')})
/** The rail's History tab body, which Results renders guidance and saved versions into. */
const historySlot=()=>document.body.appendChild(document.createElement('div'))
const openDetails=(summary:HTMLElement)=>{const details=summary.closest('details')!;details.open=true;fireEvent(details,new Event('toggle'));return details}

it('follows saved results from an empty admission snapshot until a value is inspected',async()=>{
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Completed title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const empty={snapshotVersion:0,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const completed={...empty,snapshotVersion:1,reviewCounts:{...empty.reviewCounts,required:1,toCheck:1},values:[value],total:1}
  const state={extractionId:'extraction',projectId:'project',status:'RUNNING',controlVersion:0,snapshotVersion:0,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:0,inFlight:1}}
  vi.mocked(readDurable).mockResolvedValue({state,page:empty} as never)
  vi.useFakeTimers()
  try {
    await act(async()=>{render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)})
    expect(screen.getByText(/Selected results 0 · decisions 0/)).toBeVisible()
    vi.mocked(readDurable).mockResolvedValue({state:{...state,status:'COMPLETED',snapshotVersion:1,counts:{saved:1,inFlight:0}},page:completed} as never)
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
    expect(screen.getByText('Completed title')).toBeVisible()
    expect(screen.getByText(/Selected results 1 · decisions 0 · 1 retained values/)).toBeVisible()
    fireEvent.click(screen.getByRole('button',{name:/To check title/}))
    fireEvent.click(screen.getByRole('button',{name:'Edit'}))
    fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'My unsaved correction'}})
    vi.mocked(readDurable).mockResolvedValue({state:{...state,status:'COMPLETED',snapshotVersion:2,counts:{saved:2,inFlight:0}},page:{...completed,snapshotVersion:2,values:[{...value,modelValue:'Newer title'}]}} as never)
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
    expect(screen.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('My unsaved correction')
    expect(screen.getByText(/Selected results 1 · decisions 0/)).toBeVisible()
    expect(screen.getByText(/Newer saved results 2 exist/)).toBeVisible()
  } finally {vi.useRealTimers()}
})

it('shows requested and effective methods with their producing selections, and names unresolved effective methods',async()=>{
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'pending',ordinal:3},pendingSelection:null,counts:{saved:0,inFlight:0}},page} as never)
  const provider=(key:string,model:string)=>({key,model,adapter:'gliformer',adapterVersion:1,
    nativeInfo:{protocol:3,model,identity:'native-model-v2',max_input_tokens:8192}})
  vi.mocked(readDurableHistory).mockResolvedValue({
    selections:[
      {id:'first',ordinal:1,schemaRevisionId:'schema-first',schemaTree:{},method:{models:{fields:'requested-first'},settings:{article:{context:'bounded'}}},resolved:{}},
      {id:'second',ordinal:2,schemaRevisionId:'schema-second',schemaTree:{},method:{models:{fields:'requested-second'},settings:{article:{context:'full'}}},resolved:{}},
      {id:'pending',ordinal:3,schemaRevisionId:'schema-pending',schemaTree:{},method:{models:null,settings:{article:null}},resolved:{}},
    ],
    effective:[
      {id:'second',configuration:{models:{fields:provider('resolved-second','served-second'),reasoning:provider('reasoning-second','reasoner-second')},options:{article:{context:'full'}},planner:1,protocols:{calls:1,source:'document'}}},
      {id:'first',configuration:{models:{fields:provider('resolved-first','served-first'),reasoning:provider('reasoning-first','reasoner-first')},options:{article:{context:'bounded',context_tokens:8192}},planner:1,protocols:{calls:1,source:'document'}}},
    ],snapshots:[],finalizations:[],captures:[],
  } as never)
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()}/>)
  openDetails(await screen.findByText('Saved versions'))
  expect(await screen.findByText(/model served-second · schema changed/)).toBeVisible()
  expect(screen.getByText(/model not recorded yet · schema changed/)).toBeVisible()
  expect(screen.getByRole('region',{name:'Inputs'})).not.toHaveTextContent(/schema-|resolved-/)
  openDetails(screen.getByText('Technical details (for audit)'))
  await screen.findByText('Input selection 1 · schema schema-f')
  for (const ordinal of [1,2,3]) {
    const selection=screen.getByText(new RegExp(`^Input selection ${ordinal} · schema `)).closest('details')!
    selection.open=true;fireEvent(selection,new Event('toggle'))
  }
  const first=within(screen.getByRole('region',{name:'Method used for input selection 1'}))
  expect(first.getByText(/served-first · model key resolved-first · gliformer adapter version 1/)).toBeVisible()
  expect(first.getByText(/reasoner-first · model key reasoning-first/)).toBeVisible()
  expect(first.getByText(/Planner version 1 · call protocol version 1 · source scope document/)).toBeVisible()
  expect(first.getByText('Effective method settings').nextElementSibling).toHaveTextContent('"context_tokens": 8192')
  expect(first.getByText(/"requested-first"/)).toBeVisible()
  expect(first.queryByText(/served-second/)).toBeNull()
  const native=first.getAllByText('Native model protocol and identity')[0]!.closest('details')!
  native.open=true;fireEvent(native,new Event('toggle'))
  expect(within(native).getByText(/"protocol": 3/)).toBeVisible()
  const second=within(screen.getByRole('region',{name:'Method used for input selection 2'}))
  expect(second.getByText(/served-second · model key resolved-second/)).toBeVisible()
  expect(second.getByText(/"requested-second"/)).toBeVisible()
  const pending=within(screen.getByRole('region',{name:'Method used for input selection 3'}))
  expect(pending.getByText('Effective method: Not recorded')).toBeVisible()
  expect(pending.queryByText('Effective model choices')).toBeNull()
})

it('ignores review keys outside Results, while hidden, and on repeat',async()=>{
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Saved title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:1,inFlight:0}},page} as never)
  vi.mocked(durableRequest).mockImplementation(async(_url,body)=>body?{revision:1}:page)
  const view=render(<><button>Outside</button><div data-testid="results"><DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/></div></>)
  fireEvent.click(await screen.findByRole('button',{name:'One by one'}))
  const approve=screen.getByRole('button',{name:'Approve and next'})
  fireEvent.keyDown(screen.getByRole('button',{name:'Outside'}),{key:'a'})
  fireEvent.keyDown(approve,{key:'a',repeat:true})
  fireEvent.keyDown(approve,{key:'z'})
  const panel=screen.getByTestId('results');panel.hidden=true
  fireEvent.keyDown(approve,{key:'r'})
  expect(durableRequest).not.toHaveBeenCalled()
  panel.hidden=false
  fireEvent.keyDown(approve,{key:'a'})
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values/value',expect.objectContaining({action:'APPROVED'})))
  view.unmount()
})

it('cancels editing before leaving one-by-one and restores heading keyboard focus',async()=>{
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'First title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:2,toCheck:2,approved:0,edited:0,rejected:0},values:[value,{...value,id:'next',modelValue:'Next title'}],total:2,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:2,inFlight:0}},page} as never)
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'One by one'}))
  const heading=screen.getByRole('heading',{name:'First title'})
  expect(heading).toHaveFocus()
  fireEvent.keyDown(heading,{key:'e'})
  fireEvent.keyDown(screen.getByRole('textbox',{name:'Reviewed value'}),{key:'Escape'})
  expect(screen.queryByRole('textbox',{name:'Reviewed value'})).toBeNull()
  expect(screen.getByRole('heading',{name:'First title'})).toHaveFocus()
  fireEvent.keyDown(screen.getByRole('heading',{name:'First title'}),{key:'e'})
  const save=screen.getByRole('button',{name:'Save edit and next'});save.focus()
  fireEvent.keyDown(save,{key:'j'})
  expect(screen.getByRole('textbox',{name:'Reviewed value'})).toBeVisible()
  fireEvent.keyDown(save,{key:'Escape'})
  expect(screen.queryByRole('textbox',{name:'Reviewed value'})).toBeNull()
  const restored=screen.getByRole('heading',{name:'First title'})
  expect(restored).toHaveFocus()
  fireEvent.keyDown(restored,{key:'j'})
  expect(screen.getByRole('heading',{name:'Next title'})).toHaveFocus()
  expect(durableRequest).not.toHaveBeenCalled()
})

it.each(['More result actions','Run details'])('gives %s keyboard ownership before the native review',async(name)=>{
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'First title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:2,toCheck:2,approved:0,edited:0,rejected:0},values:[value,{...value,id:'next',modelValue:'Next title'}],total:2,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:2,inFlight:0}},page} as never)
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'One by one'}))
  const overlay=screen.getByRole('button',{name});overlay.focus();fireEvent.click(overlay)
  expect(overlay).toHaveAttribute('aria-expanded','true')
  const target=name==='More result actions'?screen.getByRole('menuitem',{name:'Export XLSX'}):overlay
  target.focus()
  for(const key of ['a','r','e','j','k','z'])fireEvent.keyDown(target,{key})
  expect(durableRequest).not.toHaveBeenCalled()
  expect(screen.queryByRole('textbox',{name:'Reviewed value'})).toBeNull()
  expect(screen.getByRole('heading',{name:'First title'})).toBeVisible()
  fireEvent.keyDown(target,{key:'Escape'})
  expect(overlay).toHaveAttribute('aria-expanded','false')
  const heading=screen.getByRole('heading',{name:'First title'})
  expect(heading).toHaveFocus()
  fireEvent.keyDown(heading,{key:'j'})
  expect(screen.getByRole('heading',{name:'Next title'})).toHaveFocus()
})

it('keeps menu Escape available while a correction save is pending and suspends decisions',async()=>{
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Saved title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:1,inFlight:0}},page} as never)
  vi.mocked(durableRequest).mockReturnValue(new Promise(()=>{}))
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'One by one'}))
  fireEvent.keyDown(screen.getByRole('heading',{name:'Saved title'}),{key:'a'})
  await screen.findByText('Saving your decision…')
  fireEvent.keyDown(screen.getByRole('heading',{name:'Saved title'}),{key:'r'})
  const menu=screen.getByRole('button',{name:'More result actions'});fireEvent.click(menu)
  const target=screen.getByRole('menuitem',{name:'Export XLSX'});target.focus()
  fireEvent.keyDown(target,{key:'a'});fireEvent.keyDown(target,{key:'Escape'})
  expect(menu).toHaveAttribute('aria-expanded','false')
  expect(screen.getByRole('heading',{name:'Saved title'})).toHaveFocus()
  expect(durableRequest).toHaveBeenCalledTimes(1)
})

it('keeps native document navigation tied to rail selection and preserves mark selection intent',async()=>{
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'First title',evidence:[],links:[{evidenceAnchorId:'anchor',resultPath:['records',0,'title'],precision:'segment'}],grounding:'grounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const other={...value,id:'other',fieldId:'other',path:['records',0,'other'],node:{id:'other',name:'other',type:'string'},modelValue:'Second title',
    links:[{evidenceAnchorId:'second-anchor',resultPath:['records',0,'other'],precision:'input'}]}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:2,toCheck:2,approved:0,edited:0,rejected:0},values:[value,other],total:2,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:2,inFlight:0}},page} as never)
  const onEvidence=vi.fn(),replacement=vi.fn(),onMarksChange=vi.fn(),selectValueRef={current:null as ((key:string)=>void)|null}
  const props={attempt:{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt,document:decodeParsedDocument(rawDocument),currentSchema:null,onMarksChange,selectValueRef}
  const view=render(<DurableResults {...props} onEvidence={onEvidence}/>)
  fireEvent.click(await screen.findByRole('button',{name:'One by one'}))
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith('anchor',undefined,'segment')
  expect(onMarksChange.mock.calls.at(-1)![0].selectableKeys).toEqual(new Set(['value','other']))
  view.rerender(<DurableResults {...props} onEvidence={replacement}/>)
  expect(replacement).not.toHaveBeenCalled()
  act(()=>selectValueRef.current?.('other'))
  expect(screen.getByRole('heading',{name:'Second title'})).toBeVisible()
  expect(replacement).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'Model Evidence · other · whole page'}))
  expect(replacement).toHaveBeenCalledExactlyOnceWith('second-anchor',undefined,'input')
})

it('defers native Evidence navigation until its pinned source arrives and follows once',async()=>{
  const document=decodeParsedDocument(rawDocument),anchor=document.evidence_index.anchors[0]!.anchor_id
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Saved title',evidence:[],links:[{evidenceAnchorId:anchor,resultPath:['records',0,'title'],precision:'segment'}],grounding:'grounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,sourceRevisionId:'pinned',
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:1,inFlight:0}},page} as never)
  const source=Promise.withResolvers<unknown>()
  vi.mocked(durableRequest).mockReturnValue(source.promise)
  const onEvidence=vi.fn(),replacement=vi.fn(),props={attempt:{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt,
    document,documentRevisionId:'newer',currentSchema:null}
  const view=render(<DurableResults {...props} onEvidence={onEvidence}/>)
  fireEvent.click(await screen.findByRole('button',{name:'One by one'}))
  expect(onEvidence).not.toHaveBeenCalled()
  await act(async()=>source.resolve({sourceRevisionId:'pinned',document,markdown:'# Saved source'}))
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith(anchor,undefined,'segment')
  view.rerender(<DurableResults {...props} onEvidence={replacement}/>)
  expect(replacement).not.toHaveBeenCalled()
})

it('keeps an open draft during snapshot changes and starts a new editor for an explicitly selected model version',async()=>{
  const base={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema-one',
    node:{id:'title',name:'title',type:'string'},modelValue:'Original title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const oldPage={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},status:'PAUSED',values:[base],total:1,next:null,coverage:{}} as unknown as DurablePage
  const newPage={...oldPage,snapshotVersion:2,values:[{...base,selectionId:'numeric',schemaRevisionId:'schema-two',node:{...base.node,type:'number'},modelValue:42}]} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{extractionId:'extraction',projectId:'project',status:'PAUSED',controlVersion:1,
    snapshotVersion:2,selection:{id:'numeric',ordinal:2},pendingSelection:null,counts:{saved:2,inFlight:0}},page:newPage} as never)
  vi.mocked(readDurableHistory).mockResolvedValue({selections:[],finalizations:[],snapshots:[{id:'one',version:1,values:oldPage.values},{id:'two',version:2,values:newPage.values}]} as never)
  vi.mocked(durableRequest).mockImplementation(async(url,body)=>body?{revision:1}:url.includes('snapshotVersion=1')?oldPage:newPage)
  const view=render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE',catalogRecipe:null} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()}/>)
  openDetails(await screen.findByText('Saved versions'))
  fireEvent.click(await screen.findByRole('button',{name:'Open results 1'}))
  await screen.findByText('Original title')
  fireEvent.click(screen.getByRole('button',{name:/To check title/}))
  fireEvent.click(screen.getByRole('button',{name:'Edit'}))
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'Unsaved historical draft'}})
  fireEvent.click(screen.getByRole('button',{name:'Open results 2'}))
  await screen.findByText('42')
  expect(screen.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('Unsaved historical draft')
  fireEvent.click(screen.getByRole('button',{name:/To check title 42/}))
  fireEvent.click(screen.getByRole('button',{name:'Edit'}))
  expect(screen.getByRole('spinbutton',{name:'Reviewed value'})).toHaveValue(42)
  fireEvent.change(screen.getByRole('spinbutton',{name:'Reviewed value'}),{target:{value:'43'}})
  fireEvent.click(screen.getByRole('button',{name:'Save edit'}))
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values/value',expect.objectContaining({snapshotVersion:2,value:43,action:'EDITED'})))
  view.unmount()
})

it('shows a durable read failure without rendering a different results implementation',async()=> {
  vi.mocked(readDurable).mockRejectedValue(new Error('Saved results are unavailable.'))
  render(<DurableResults attempt={{extractionId:'extraction'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('Saved results are unavailable.')
})

it('opens a linked historical correction at its exact result and decision cuts',async()=>{
  window.history.replaceState(null,'','/?value=value&snapshotVersion=1&feedbackVersion=2')
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Original',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],
    correction:{revision:2,decision:{action:'EDITED',value:'Historical text correction',included:true,evidence:[]}},historicalCorrection:null}
  const historical={snapshotVersion:1,feedbackVersion:2,reviewCounts:{required:1,toCheck:0,approved:0,edited:1,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  const current={...historical,snapshotVersion:3,feedbackVersion:4,values:[{...value,node:{...value.node,type:'number'},modelValue:42,correction:null,historicalCorrection:{extractionId:'extraction',valueId:'value',revision:2,snapshotVersion:1,feedbackVersion:2}}]}
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:3,selection:{id:'numeric',ordinal:2},counts:{saved:1,inFlight:0}},page:current} as never)
  vi.mocked(durableRequest).mockResolvedValue(historical)
  // The document route parses the saved-correction link's cut and passes it as the explicit initial cut.
  render(<DurableResults attempt={{extractionId:'extraction',sourceDocumentId:'source',strategy:'ARTICLE'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}} initialCut={{snapshotVersion:1,feedbackVersion:2}}/>)
  await screen.findByRole('region',{name:'Review title'})
  expect(screen.getAllByText('Historical text correction').length).toBeGreaterThan(0)
  expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values?snapshotVersion=1&feedbackVersion=2',undefined,expect.any(AbortSignal))
  expect(screen.getByText(/Selected results 1 · decisions 2 · 1 retained values/)).toBeVisible()
  expect(screen.queryByText('42')).toBeNull()
})

it('keeps the producing call guidance and budget omissions inspectable after exclusion',async()=>{
  const page={snapshotVersion:1,feedbackVersion:2,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const row={id:'consumed',extractionId:'extraction',sourceDocumentId:'source',valueId:'value',snapshotVersion:1,feedbackVersion:2,revision:2,
    included:true,active:true,selectionId:'selection',targetCompatibility:'compatible',candidate:{value:'Captured example',sourceContext:'own-source',grounded:false},decision:{action:'EDITED'}}
  let excluded=false
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,selection:{id:'selection',ordinal:1},counts:{saved:0,inFlight:0}},page} as never)
  vi.mocked(durableRequest).mockImplementation(async(url,body)=>{if(body){excluded=true;return {}};return url.includes('feedback')?[{...row,included:!excluded}]:page})
  vi.mocked(readDurableHistory).mockResolvedValue({selections:[{id:'selection',ordinal:1,schemaRevisionId:'schema',schemaTree:{},method:{},resolved:{}}],snapshots:[],finalizations:[],captures:[{
    id:'capture',selectionId:'selection',feedbackVersion:1,invoked:true,descriptor:{stage:'article'},inputDigest:'input',outputDigest:'output',output:{parsed:{title:'Result'}},candidates:[],
    request:{examples:[{id:'consumed',value:'Captured example'}],omissions:[{id:'oversized',reason:'budget'}],budget:{counted:200,context:256,reserve:56}},
  }]} as never)
  const view=render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()}/>)
  openDetails(await screen.findByText('Saved versions'))
  openDetails(await screen.findByText('Technical details (for audit)'))
  const call=(await screen.findByText('Call · article · input selection 1 · decisions 1')).closest('details')!
  call.open=true;fireEvent(call,new Event('toggle'))
  const guidance=screen.getByText('Consumed guidance and omitted candidates').closest('details')!
  guidance.open=true;fireEvent(guidance,new Event('toggle'))
  const captured=guidance.querySelector('pre')!
  expect(captured).toHaveTextContent('Captured example')
  expect(captured).toHaveTextContent('"reason": "budget"')
  openDetails(screen.getByText('Corrections the model learns from'))
  fireEvent.click(await screen.findByRole('button',{name:'Stop using'}))
  await screen.findByRole('button',{name:'Use'})
  expect(captured).toHaveTextContent('Captured example')
  expect(captured).toHaveTextContent('"reason": "budget"')
  view.unmount()
})


it('warns in Results when pending inputs leave a saved correction unfit, and opens History',async()=>{
  const page={snapshotVersion:1,feedbackVersion:1,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const row={id:'unfit',extractionId:'extraction',sourceDocumentId:'source',valueId:'value',snapshotVersion:1,feedbackVersion:1,revision:1,
    included:true,active:true,selectionId:'selection',targetCompatibility:'incompatible',candidate:{value:'Saved',sourceContext:'source',grounded:false,node:{name:'title'}},decision:{action:'EDITED'}}
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,selection:{id:'selection',ordinal:1},pendingSelection:{id:'pending',ordinal:2},counts:{saved:0,inFlight:0}},page} as never)
  vi.mocked(durableRequest).mockImplementation(async url=>url.includes('feedback')?[row]:page)
  const onShowHistory=vi.fn(),slot=historySlot()
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} historySlot={slot} onShowHistory={onShowHistory}/>)
  expect(await screen.findByText(/1 saved correction doesn’t fit the pending schema/)).toBeVisible()
  expect(within(slot).getByText('title:')).toBeVisible()
  fireEvent.click(screen.getByRole('button',{name:'See corrections'}))
  expect(onShowHistory).toHaveBeenCalledOnce()
})

it('keeps a newer control acknowledgement when a pre-command poll arrives late',async()=> {
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'RUNNING',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:0,inFlight:1}}
  let finishPoll!:(read:Awaited<ReturnType<typeof readDurable>>)=>void
  vi.mocked(readDurable).mockResolvedValueOnce({state,page} as never)
    .mockImplementationOnce(()=>new Promise(resolve=>{finishPoll=resolve}))
    .mockResolvedValue({...{state:{...state,status:'PAUSING',controlVersion:2},page}} as never)
  vi.mocked(durableRequest).mockResolvedValue({controlVersion:2})
  const view=render(<DurableResults attempt={{extractionId:'extraction'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}}/>)
  await screen.findByRole('button',{name:'Pause'})
  await waitFor(()=>expect(readDurable).toHaveBeenCalledTimes(2),{timeout:3000})
  fireEvent.click(screen.getByRole('button',{name:'Pause'}))
  await screen.findByRole('button',{name:'Saving in-flight work…'})
  await act(async()=>finishPoll({state,page} as never))
  expect(screen.getByRole('button',{name:'Saving in-flight work…'})).toBeDisabled()
  view.unmount()
})

it('keeps the last explicitly selected snapshot when an older selection finishes late',async()=> {
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'New version',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const latest={snapshotVersion:2,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},status:'PAUSED',values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:2,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:1,inFlight:0}}
  let finishOld!:(page:DurablePage)=>void
  vi.mocked(readDurable).mockResolvedValue({state,page:latest} as never)
  vi.mocked(readDurableHistory).mockResolvedValue({selections:[],finalizations:[],snapshots:[{id:'one',version:1,values:[value]},{id:'two',version:2,values:[value]}]} as never)
  vi.mocked(durableRequest).mockImplementation(async url=>url.includes('snapshotVersion=1')?new Promise(resolve=>{finishOld=resolve}):latest)
  render(<DurableResults attempt={{extractionId:'extraction'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()}/>)
  openDetails(await screen.findByText('Saved versions'))
  fireEvent.click(await screen.findByRole('button',{name:'Open results 1'}))
  fireEvent.click(screen.getByRole('button',{name:'Open results 2'}))
  await act(async()=>finishOld({...latest,snapshotVersion:1,values:[{...latest.values[0],modelValue:'Old version'}]}))
  expect(screen.getByText('New version')).toBeVisible()
  expect(screen.queryByText('Old version')).toBeNull()
})

const reviewValue=(id:string,title:string)=>({id,recordId:'record',fieldId:id,path:['records',0,id],selectionId:'selection',schemaRevisionId:'schema',
  node:{id,name:id,type:'string'},modelValue:title,evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null})
const reviewPage=(snapshotVersion=1,feedbackVersion=0)=>({extractionId:'extraction',snapshotVersion,feedbackVersion,status:'PAUSED',finalization:null,
  reviewCounts:{required:3,toCheck:3,approved:0,edited:0,rejected:0},values:[reviewValue('a','First title'),reviewValue('b','Second title'),reviewValue('c','Third title')],
  total:3,next:null,coverage:{}} as unknown as DurablePage)
const pausedState={extractionId:'extraction',projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
  selection:{id:'selection',ordinal:1},pendingSelection:null,counts:{saved:3,inFlight:0}}

/** Approves A in one-by-one review and holds the page read that the save starts; resolves it with A approved. */
async function approveFirstAndHoldTheRefresh() {
  const page=reviewPage(),reload=Promise.withResolvers<DurablePage>()
  const parsedDocument=decodeParsedDocument(rawDocument),anchor=parsedDocument.evidence_index.anchors[0]!.anchor_id
  // C is linked, so the document marks name it: the production mark selection goes through selectValueRef.
  page.values[2]={...page.values[2],links:[{evidenceAnchorId:anchor,resultPath:['records',0,'c'],precision:'segment'}]} as never
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  vi.mocked(durableRequest).mockImplementation(async(_url,body)=>body?{revision:1}:reload.promise)
  const selectValueRef={current:null as ((id:string)=>void)|null}
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={parsedDocument} currentSchema={null}
    onEvidence={()=>{}} selectValueRef={selectValueRef}/>)
  fireEvent.click(await screen.findByRole('button',{name:'One by one'}))
  fireEvent.keyDown(screen.getByRole('heading',{name:'First title'}),{key:'a'})
  await screen.findByText(/You’re caught up/)
  const saved={...reviewPage(1,1),values:page.values.map((value,index)=>index===0?{...value,correction:{revision:1,decision:{action:'APPROVED'}}}:value)} as never as DurablePage
  saved.reviewCounts={required:3,toCheck:2,approved:1,edited:0,rejected:0}
  return {selectValueRef,finishRefresh:()=>act(async()=>reload.resolve(saved))}
}

it('keeps a newer mark selection and its unsaved draft when the post-save page read finishes late',async()=> {
  const {selectValueRef,finishRefresh}=await approveFirstAndHoldTheRefresh()
  act(()=>selectValueRef.current?.('c'))
  fireEvent.click(screen.getByRole('button',{name:/^Edit$/}))
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'Keep this unsaved draft'}})
  await finishRefresh()
  // The save's automatic advancement to B was superseded by the explicit selection of C.
  expect(screen.getByRole('region',{name:'Review c'})).toBeVisible()
  expect(screen.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('Keep this unsaved draft')
  expect(screen.queryByRole('region',{name:'Review b'})).toBeNull()
  expect(screen.queryByRole('heading',{name:'Second title'})).toBeNull()
})

it('opens nothing when the researcher closed their newer selection before the post-save read finished',async()=> {
  const {selectValueRef,finishRefresh}=await approveFirstAndHoldTheRefresh()
  act(()=>selectValueRef.current?.('c'))
  fireEvent.click(screen.getByRole('button',{name:'Close value'}))
  await finishRefresh()
  expect(screen.queryByRole('region',{name:/^Review /})).toBeNull()
  expect(screen.queryByRole('heading',{name:'Second title'})).toBeNull()
})

it('still advances to the next value when nothing newer was selected',async()=> {
  const {finishRefresh}=await approveFirstAndHoldTheRefresh()
  await finishRefresh()
  expect(await screen.findByRole('heading',{name:'Second title'})).toBeVisible()
})

it('names the selected decisions and the newer saved decisions before an older pair is finalized',async()=> {
  const page={...reviewPage(1,1),reviewCounts:{required:3,toCheck:0,approved:3,edited:0,rejected:0}} as DurablePage
  page.values=page.values.map(value=>({...value,correction:{revision:1,feedbackVersion:1,decision:{action:'APPROVED'}}} as never))
  const latest={...page,feedbackVersion:2,reviewCounts:{required:3,toCheck:0,approved:2,edited:1,rejected:0},
    values:page.values.map((value,index)=>index===1?{...value,correction:{revision:2,feedbackVersion:2,decision:{action:'EDITED',value:'Correction from another session'}}}:value)} as never as DurablePage
  vi.mocked(readDurable).mockResolvedValueOnce({state:pausedState,page} as never).mockResolvedValue({state:pausedState,page:latest} as never)
  vi.mocked(durableRequest).mockImplementation(async(_url,body)=>body?{}:page)
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  expect(await screen.findByText(/Selected results 1 · decisions 1/)).toBeVisible()
  // The live poll observes another session's correction; the result snapshot stays the same.
  expect(await screen.findByText('Newer saved decisions 2 exist. This view and its finalization stay on results 1 · decisions 1.',undefined,{timeout:3500})).toBeVisible()
  expect(screen.queryByText(/Newer saved results/)).toBeNull()
  expect(screen.getByRole('button',{name:'Show results 1 · decisions 2'})).toBeVisible()
  const finalize=screen.getAllByRole('button',{name:'Finalize results 1 · decisions 1'})
  expect(finalize.length).toBeGreaterThan(0)
  // Deliberately finalizing the older, clearly named pair stays valid.
  fireEvent.click(finalize.at(-1)!)
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/finalize',{snapshotVersion:1,feedbackVersion:1}))
})

it('opens an explicit finalized cut and names the later live work beside it',async()=> {
  const current={...reviewPage(3,4)},historical={...reviewPage(1,2),finalization:{id:'final',snapshotVersion:1,feedbackVersion:2,createdAt:'2026-10-05T09:00:00.000Z'}}
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,snapshotVersion:3},page:current} as never)
  vi.mocked(durableRequest).mockResolvedValue(historical)
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} initialCut={{snapshotVersion:1,feedbackVersion:2}}
    document={null} currentSchema={null} onEvidence={()=>{}} readOnly/>)
  expect(await screen.findByText(/Selected results 1 · decisions 2 · 3 retained values/)).toBeVisible()
  expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values?snapshotVersion=1&feedbackVersion=2',undefined,expect.any(AbortSignal))
  expect(screen.getByText('Finalized review · results 1 · decisions 2. Later work and decisions remain separate.')).toBeVisible()
  expect(screen.getByText(/Newer saved results 3 and decisions 4 exist/)).toBeVisible()
})

it('opens the live cut when no explicit cut is named',async()=> {
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,snapshotVersion:3},page:reviewPage(3,4)} as never)
  render(<DurableResults attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} readOnly/>)
  expect(await screen.findByText(/Selected results 3 · decisions 4/)).toBeVisible()
  expect(durableRequest).not.toHaveBeenCalled()
})
