// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, useEffect, useState, type ComponentProps } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import { decodeParsedDocument } from 'extraction/parsed-document'
import rawDocument from './assets/parsed_document.v2.json'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { DurableResults } from './DurableResults'
import { durableRequest, readDurable, readDurableHistory, readDurableHistorySummary, readValues } from './durableExtractionApi'
import { createDurableReader, type DurableReader } from './durableReader'
import { createSelectionChannel, type SelectionChannel } from './selectionChannel'
import { ApiRequestError } from './api'

vi.mock('./durableExtractionApi',()=>({durableRequest:vi.fn(),readDurable:vi.fn(),readDurableHistory:vi.fn(),readDurableHistorySummary:vi.fn(),readValues:vi.fn(),durableRoot:(id:string)=>`/api/extractions/${id}/durable`}))
afterEach(()=>{cleanup();vi.resetAllMocks()})

it('names the producing schema and the current revision without changing saved values',async()=>{
  const old={schemaRevisionId:'schema-old',extractionSchemaId:'schema-family',name:'Research',revisionNumber:9,recordScope:'records' as const}
  const current={schemaRevisionId:'schema-current',revisionNumber:14,recordScope:'document' as const}
  const value={id:'old-value',recordId:'reference',fieldId:'reference_number',path:['records',0,'reference_number'],selectionId:'original',schemaRevisionId:old.schemaRevisionId,
    node:{id:'reference_number',name:'reference_number',type:'string'},modelValue:'Reference 17',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={extractionId:'extraction',snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[value],total:1,next:null,coverage:{},schemaRevisions:[old],schemaRevisionId:old.schemaRevisionId} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{extractionId:'extraction',projectId:'project',status:'COMPLETED',controlVersion:1,snapshotVersion:1,feedbackVersion:0,
    selection:{id:'original',ordinal:1,schemaRevisionId:old.schemaRevisionId},schemaRevisions:[old],pendingSelection:null,counts:{saved:1,inFlight:0}},page} as never)
  const onSchema=vi.fn()
  render(<Results attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt} document={null} currentSchema={current} onSchema={onSchema} onEvidence={()=>{}}/>)
  expect(await screen.findByText(/These results use schema revision 9 \(Catalog\)/)).toBeVisible()
  expect(screen.getByText(/The current schema is revision 14 \(Article\)/)).toBeVisible()
  expect(screen.getByText('Reference 17')).toBeVisible()
  fireEvent.click(screen.getByRole('button',{name:'Open Schema'}))
  expect(onSchema).toHaveBeenCalledOnce()
  expect(durableRequest).not.toHaveBeenCalled()
})

it('shows every saved table row and absent cell in list and one-by-one review',async()=>{
  const node={id:'remains',name:'remains',type:'object',children:[
    {id:'summary',name:'summary',type:'string'},
    {id:'parts',name:'parts',type:'array',children:[
      {id:'number',name:'number',type:'string'},
      {id:'description',name:'description',type:'string'},
      {id:'notes',name:'notes',type:'string'},
    ]},
  ]}
  const value={id:'value',recordId:'first',fieldId:node.id,path:['records',0,node.name],selectionId:'original',schemaRevisionId:'schema',node,
    modelValue:{summary:'Fragments survived.',parts:[
      {number:'A-1',description:'Tooth',notes:null},
      {number:'A-2',description:null,notes:'Recovered while cleaning'},
      {number:'A-3',description:'Bone fragments',notes:null},
    ]},evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'COMPLETED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:1,inFlight:0}},page} as never)
  render(<Results attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:/To check remains/}))
  const checkTable=()=>{
    const table=screen.getByRole('table',{name:'parts'})
    expect(within(table).getAllByRole('columnheader').map(cell=>cell.textContent)).toEqual(['number','description','notes'])
    expect(within(table).getAllByRole('row')).toHaveLength(4)
    for(const text of ['A-1','Tooth','A-2','Recovered while cleaning','A-3','Bone fragments'])expect(within(table).getByText(text)).toBeVisible()
    expect(within(table).getAllByText('No value')).toHaveLength(3)
  }
  checkTable()
  fireEvent.click(screen.getByRole('button',{name:'Review from here'}))
  await screen.findByRole('table',{name:'parts'})
  checkTable()
})

it('publishes every source segment of a table value continued onto another page',async()=>{
  const document=decodeParsedDocument(rawDocument)
  const original=document.evidence_index.anchors[0]
  document.evidence_index.anchors=[...document.evidence_index.anchors,
    {...original,anchor_id:'a_p1_s0'}, {...original,anchor_id:'a_p2_s0'}]
  const link={resultPath:['records',0,'description'],evidenceAnchorId:'a_p1_s0',precision:'segment',grounding:{
    linkedBy:'verification',support:'literal',precision:'segment',raw:'Fragments, probably tibia',itemSpans:null,
    textSpans:[{segment:'p1_s0',start:0,end:10},{segment:'p2_s0',start:0,end:15}],
    alternatives:[[{segment:'p3_s0',start:0,end:15}]],
  }}
  const value={id:'value',recordId:'first',fieldId:'description',path:['records',0,'description'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'description',name:'description',type:'string'},modelValue:'Fragments, probably tibia',evidence:[],links:[link],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'COMPLETED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:1,inFlight:0}},page} as never)
  const selection=createSelectionChannel()
  render(<Results attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt} document={document} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  await screen.findByRole('button',{name:/To check description/})
  await waitFor(()=>expect(selection.snapshot().marks?.savedLinks?.map(saved=>saved.link.evidenceAnchorId)).toEqual(['a_p1_s0','a_p2_s0']))
})
/** The rail's History tab body, which Results renders guidance and saved versions into. */
const historySlot=()=>document.body.appendChild(document.createElement('div'))
const openDetails=(summary:HTMLElement)=>{const details=summary.closest('details')!;details.open=true;fireEvent(details,new Event('toggle'));return details}
/** Results with the workspace's reader of its attempt (the real reader over the mocked reads) and its selection
 *  channel, kept across renders; `reader` and `selection` pass ones the test drives. */
function Results({reader:given,selection:givenSelection,...props}:Omit<ComponentProps<typeof DurableResults>,'reader'|'selection'>&{reader?:DurableReader;selection?:SelectionChannel}) {
  const [reader]=useState(()=>given??createDurableReader(props.attempt!))
  const [selection]=useState(()=>givenSelection??createSelectionChannel())
  useEffect(()=>()=>reader.dispose(),[reader])
  return <DurableResults {...props} reader={reader} selection={selection}/>
}

it('follows the latest saved results while the run reads its records, and keeps an open edit',async()=>{
  const value={id:'value',recordId:'first',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Completed title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const empty={snapshotVersion:0,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const completed={...empty,snapshotVersion:1,reviewCounts:{...empty.reviewCounts,required:1,toCheck:1},values:[value],total:1}
  const state={extractionId:'extraction',projectId:'project',status:'RUNNING',controlVersion:0,snapshotVersion:0,feedbackVersion:0,
    selection:{id:'original',ordinal:1,schemaTree:{schemaNodes:[{id:'title',name:'title',type:'string'}]},resolved:{startPage:null}},pendingSelection:null,
    counts:{saved:0,inFlight:1},records:null,reading:[]}
  vi.mocked(readDurable).mockResolvedValue({state,page:empty} as never)
  vi.useFakeTimers()
  try {
    await act(async()=>{render(<Results attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)})
    expect(screen.getByText('Starting')).toBeVisible()
    expect(screen.getByText('Finding the records in the source…')).toBeVisible()
    const found={...state,records:[{ordinal:0,page:1},{ordinal:1,page:2}],recordsFinal:true,reading:[0]}
    vi.mocked(readDurable).mockResolvedValue({state:found,page:empty} as never)
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
    expect(screen.getByText('Reading records')).toBeVisible()
    expect(screen.getByText('· 0 of 2')).toBeVisible()
    expect(screen.getByRole('region',{name:'Record 1, Reading…'})).toHaveTextContent('title')
    expect(screen.getByRole('region',{name:'Record 2, Queued'})).toBeVisible()
    vi.mocked(readDurable).mockResolvedValue({state:{...found,snapshotVersion:1,reading:[1]},page:completed} as never)
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
    expect(screen.getByText('Completed title')).toBeVisible()
    expect(screen.getByText('· 1 of 2')).toBeVisible()
    expect(screen.getByRole('region',{name:'Record 2, Reading…'})).toBeVisible()
    fireEvent.click(screen.getByRole('button',{name:/To check title/}))
    fireEvent.click(screen.getByRole('button',{name:'Edit'}))
    fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'My unsaved correction'}})
    const newer={...completed,snapshotVersion:2,values:[{...value,modelValue:'Newer title'}]}
    vi.mocked(readDurable).mockResolvedValue({state:{...found,status:'COMPLETED',snapshotVersion:2,reading:[]},page:newer} as never)
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
    expect(screen.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('My unsaved correction')
    expect(screen.getByText(/A newer version of this value was saved/)).toBeVisible()
    expect(screen.getByText('Completed')).toBeVisible()
    expect(screen.queryByText(/Show the latest results/)).toBeNull()
  } finally {vi.useRealTimers()}
})

it('shows the record starts discovery has found on the source while it still looks for the records',async()=>{
  const empty={snapshotVersion:0,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'RUNNING',controlVersion:0,snapshotVersion:0,feedbackVersion:0,
    selection:{id:'original',ordinal:1,schemaTree:{schemaNodes:[]},resolved:{startPage:null}},pendingSelection:null,counts:{saved:1,inFlight:1},records:null,reading:[],
    discovery:{found:[{segment:'p1_s0',label:'1'},{segment:'p1_s2',label:null}]}}
  vi.mocked(readDurable).mockResolvedValue({state,page:empty} as never)
  const selection=createSelectionChannel()
  render(<Results attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  expect(await screen.findByText('Finding records')).toBeVisible()
  expect(screen.getByText('· 2 found so far')).toBeVisible()
  expect(screen.getByText('Finding the records in the source…')).toBeVisible()
  await waitFor(()=>expect(selection.snapshot().marks?.savedLinks?.map(saved=>saved.link.evidenceAnchorId)).toEqual(['a_p1_s0','a_p1_s2']))
  // Starts are never values: their marks select nothing.
  expect(selection.snapshot().marks!.describe.size).toBe(0)
})

it('lists the records found so far, with no total, while a pipelined run reads them and discovery still looks',async()=>{
  const value={id:'value',recordId:'first',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Early title',evidence:[],links:[],grounding:'provisional',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'RUNNING',controlVersion:0,snapshotVersion:1,feedbackVersion:0,
    selection:{id:'original',ordinal:1,schemaTree:{schemaNodes:[{id:'title',name:'title',type:'string'}]},resolved:{startPage:null}},pendingSelection:null,
    counts:{saved:3,inFlight:2},records:[{ordinal:0,page:1},{ordinal:1,page:1},{ordinal:2,page:2}],recordsFinal:false,reading:[1],
    discovery:{found:[{segment:'p1_s0',label:'1'},{segment:'p1_s1',label:'2'},{segment:'p2_s0',label:'3'},{segment:'p3_s0',label:'4'}]}}
  vi.mocked(readDurable).mockResolvedValue({state,page} as never)
  const selection=createSelectionChannel()
  render(<Results attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  expect(await screen.findByText('Finding records')).toBeVisible()
  expect(screen.getByText('· 4 found so far · 1 read')).toBeVisible()
  expect(screen.getByText('Early title')).toBeVisible()
  expect(screen.getByRole('region',{name:'Record 2, Reading…'})).toBeVisible()
  expect(screen.getByRole('region',{name:'Record 3, Queued'})).toBeVisible()
  await waitFor(()=>expect(selection.snapshot().marks?.savedLinks?.filter(saved=>saved.key.startsWith('found:'))).toHaveLength(4))
})

it('follows the reader from Pausing to Paused, then no longer at the run\'s pace, and names a record of missing values',async()=>{
  const absent={id:'value',recordId:'first',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:null,evidence:[],links:[],grounding:'provisional',processing:'absent',lineage:[],correction:null,historicalCorrection:null}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[absent],total:1,next:null,coverage:{}} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'PAUSING',controlVersion:1,snapshotVersion:1,feedbackVersion:0,
    selection:{id:'original',ordinal:1,schemaTree:{schemaNodes:[{id:'title',name:'title',type:'string'}]},resolved:{startPage:null}},pendingSelection:null,
    counts:{saved:1,inFlight:1},records:[{ordinal:0,page:1},{ordinal:1,page:2}],recordsFinal:true,reading:[]}
  vi.mocked(readDurable).mockResolvedValue({state,page} as never)
  const attempt={extractionId:'extraction',strategy:'CATALOG',executionStatus:'PAUSING'} as ExtractionAttempt
  vi.useFakeTimers()
  try {
    await act(async()=>{render(<Results attempt={attempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)})
    expect(screen.getByText('Pausing')).toBeVisible()
    // Only a decision checks a value: the record's one value is missing, so nothing in it was checked.
    expect(screen.getByRole('region',{name:'Record 1, no values'})).toBeVisible()
    expect(screen.queryByText('all checked')).toBeNull()
    vi.mocked(readDurable).mockResolvedValue({state:{...state,status:'PAUSED',counts:{saved:1,inFlight:0}},page} as never)
    // The status line and the run button follow the same reader, read again at the run's pace.
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
    expect(screen.getByText('Paused')).toBeVisible()
    expect(readDurable).toHaveBeenCalledTimes(2)
    // Settled, it is no longer read at the run's pace.
    await act(async()=>{await vi.advanceTimersByTimeAsync(4500)})
    expect(readDurable).toHaveBeenCalledTimes(2)
  } finally {vi.useRealTimers()}
})

it('shows requested and effective methods with their producing selections, and names unresolved effective methods',async()=>{
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'pending',ordinal:3},pendingSelection:null,counts:{saved:0,inFlight:0}},page} as never)
  const provider=(key:string,model:string)=>({key,model,adapter:'gliformer',adapterVersion:1,
    nativeInfo:{protocol:3,model,identity:'native-model-v2',max_input_tokens:8192}})
  const history={
    selections:[
      {id:'first',ordinal:1,schemaRevisionId:'schema-first',schemaTree:{},method:{models:{fields:'requested-first'},settings:{article:{context:'bounded'}}},resolved:{}},
      {id:'second',ordinal:2,schemaRevisionId:'schema-second',schemaTree:{},method:{models:{fields:'requested-second'},settings:{article:{context:'full'}}},resolved:{}},
      {id:'pending',ordinal:3,schemaRevisionId:'schema-pending',schemaTree:{},method:{models:null,settings:{article:null}},resolved:{}},
    ],
    effective:[
      {id:'second',configuration:{models:{fields:provider('resolved-second','served-second'),reasoning:provider('reasoning-second','reasoner-second')},options:{article:{context:'full'}},planner:1,protocols:{calls:1,source:'document'}}},
      {id:'first',configuration:{models:{fields:provider('resolved-first','served-first'),reasoning:provider('reasoning-first','reasoner-first')},options:{article:{context:'bounded',context_tokens:8192}},planner:1,protocols:{calls:1,source:'document'}}},
    ],snapshots:[],finalizations:[],captures:[],
  }
  vi.mocked(readDurableHistorySummary).mockResolvedValue(history as never)
  vi.mocked(readDurableHistory).mockResolvedValue(history as never)
  vi.mocked(durableRequest).mockResolvedValue([])
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()} historyShown/>)
  openDetails(await screen.findByText('Saved versions'))
  expect(await screen.findByText(/model served-second · schema changed/)).toBeVisible()
  expect(screen.getByText(/model not recorded yet · schema changed/)).toBeVisible()
  expect(screen.getByRole('region',{name:'Inputs'})).not.toHaveTextContent(/schema-|resolved-/)
  // The full history, with every call's request, is read only for audit.
  expect(readDurableHistory).not.toHaveBeenCalled()
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
  const view=render(<><button>Outside</button><div data-testid="results"><Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/></div></>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
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
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
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
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  const overlay=screen.getByRole('button',{name});overlay.focus();fireEvent.click(overlay)
  expect(overlay).toHaveAttribute('aria-expanded','true')
  const target=name==='More result actions'?screen.getByRole('menuitem',{name:'Export…'}):overlay
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
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  fireEvent.keyDown(screen.getByRole('heading',{name:'Saved title'}),{key:'a'})
  await screen.findByText('Saving your decision…')
  fireEvent.keyDown(screen.getByRole('heading',{name:'Saved title'}),{key:'r'})
  const menu=screen.getByRole('button',{name:'More result actions'});fireEvent.click(menu)
  const target=screen.getByRole('menuitem',{name:'Export…'});target.focus()
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
  const onEvidence=vi.fn(),replacement=vi.fn(),selection=createSelectionChannel()
  const props={attempt:{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt,document:decodeParsedDocument(rawDocument),currentSchema:null,selection}
  const view=render(<Results {...props} onEvidence={onEvidence}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith('anchor',undefined,'segment')
  expect(new Set(selection.snapshot().marks!.describe.keys())).toEqual(new Set(['value','other']))
  view.rerender(<Results {...props} onEvidence={replacement}/>)
  expect(replacement).not.toHaveBeenCalled()
  // A mark's request reveals the list without moving the source.
  act(()=>{selection.select('other',false,'extraction')})
  expect(screen.getByRole('region',{name:'Review other'})).toBeVisible()
  expect(replacement).not.toHaveBeenCalled()
  expect(screen.queryByRole('button',{name:'Leave one-by-one review, back to the list'})).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button',{name:/To check title First title/}))
  expect(replacement).toHaveBeenCalledExactlyOnceWith('anchor',undefined,'segment')
})

it('starts no read of the latest values while the rail is collapsed, and catches up once it opens',async()=>{
  const page=(snapshotVersion:number)=>({snapshotVersion,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}})
  let state={projectId:'project',status:'RUNNING',controlVersion:1,snapshotVersion:1,feedbackVersion:0,selection:{id:'original',ordinal:1},
    pendingSelection:null,counts:{saved:0,inFlight:1},records:null,reading:[]}
  // As the real read: without pages it keeps the values it was given.
  vi.mocked(readDurable).mockImplementation(async(_id,_signal,previous,pages)=>({state,page:pages?page(state.snapshotVersion):previous}) as never)
  const onReviewProgress=vi.fn(),pages=()=>vi.mocked(readDurable).mock.calls.map(call=>call[3])
  const props={attempt:{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt,document:null,currentSchema:null,onEvidence:()=>{},onReviewProgress}
  vi.useFakeTimers()
  try {
    let view!:ReturnType<typeof render>
    await act(async()=>{view=render(<Results {...props}/>)})
    expect(pages()).toEqual([true])
    view.rerender(<Results {...props} railOpen={false}/>)
    state={...state,snapshotVersion:2}
    await act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
    expect(pages()).toEqual([true,false])
    // The ring keeps its last progress.
    expect(onReviewProgress).toHaveBeenLastCalledWith(expect.objectContaining({snapshotVersion:1}))
    view.rerender(<Results {...props}/>)
    await act(async()=>{await vi.advanceTimersByTimeAsync(0)})
    expect(pages()).toEqual([true,false,true])
    expect(onReviewProgress).toHaveBeenLastCalledWith(expect.objectContaining({snapshotVersion:2}))
  } finally {vi.useRealTimers()}
})

it('follows nothing on the document while the rail is collapsed, and the one-by-one value once it opens',async()=>{
  const document=decodeParsedDocument(rawDocument),first=document.evidence_index.anchors[0]!.anchor_id,second='second-anchor'
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'First title',evidence:[],links:[{evidenceAnchorId:first,resultPath:['records',0,'title'],precision:'segment'}],grounding:'grounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const next={...value,id:'next',modelValue:'Next title',links:[{evidenceAnchorId:second,resultPath:['records',0,'title'],precision:'segment'}]}
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:2,toCheck:2,approved:0,edited:0,rejected:0},values:[value,next],total:2,next:null,coverage:{}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:2,inFlight:0}},page} as never)
  const onEvidence=vi.fn(),selection=createSelectionChannel()
  const props={attempt:{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt,document,currentSchema:null,onEvidence,selection}
  const view=render(<Results {...props}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith(first,undefined,'segment')
  expect(selection.snapshot().dim).toEqual(value.links[0])
  view.rerender(<Results {...props} railOpen={false}/>)
  expect(selection.snapshot().dim).toBeNull()
  // One-by-one moves on while collapsed, as when a decision saved before the collapse lands.
  fireEvent.keyDown(screen.getByRole('heading',{name:'First title'}),{key:'j'})
  expect(screen.getByRole('heading',{name:'Next title'})).toBeVisible()
  expect(onEvidence).toHaveBeenCalledOnce()
  expect(selection.snapshot().dim).toBeNull()
  view.rerender(<Results {...props}/>)
  expect(onEvidence).toHaveBeenCalledTimes(2)
  expect(onEvidence).toHaveBeenLastCalledWith(second,undefined,'segment')
  expect(selection.snapshot().dim).toEqual(next.links[0])
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
  const view=render(<Results {...props} onEvidence={onEvidence}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  expect(onEvidence).not.toHaveBeenCalled()
  await act(async()=>source.resolve({sourceRevisionId:'pinned',document,markdown:'# Saved source'}))
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith(anchor,undefined,'segment')
  view.rerender(<Results {...props} onEvidence={replacement}/>)
  expect(replacement).not.toHaveBeenCalled()
})

it('keeps an open draft during snapshot changes and starts a new editor for an explicitly selected model version',async()=>{
  const base={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema-one',
    node:{id:'title',name:'title',type:'string'},modelValue:'Original title',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const oldPage={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},status:'PAUSED',values:[base],total:1,next:null,coverage:{}} as unknown as DurablePage
  const newPage={...oldPage,snapshotVersion:2,values:[{...base,selectionId:'numeric',schemaRevisionId:'schema-two',node:{...base.node,type:'number'},modelValue:42}]} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:{extractionId:'extraction',projectId:'project',status:'PAUSED',controlVersion:1,
    snapshotVersion:2,selection:{id:'numeric',ordinal:2},pendingSelection:null,counts:{saved:2,inFlight:0}},page:newPage} as never)
  vi.mocked(readDurableHistorySummary).mockResolvedValue({selections:[],finalizations:[],snapshots:[{id:'one',version:1,valueCount:1},{id:'two',version:2,valueCount:1}]} as never)
  vi.mocked(durableRequest).mockImplementation(async(url,body)=>body?{revision:1}:url.includes('feedback')?[]:newPage)
  vi.mocked(readValues).mockImplementation(async(_id,query)=>query.snapshotVersion===1?oldPage:newPage)
  const view=render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE',catalogRecipe:null} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()} historyShown/>)
  openDetails(await screen.findByText('Saved versions'))
  fireEvent.click(await screen.findByRole('button',{name:'Open results 1'}))
  await screen.findByText('Original title')
  fireEvent.click(screen.getByRole('button',{name:/To check title/}))
  fireEvent.click(screen.getByRole('button',{name:'Edit'}))
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'Unsaved historical draft'}})
  fireEvent.click(screen.getByRole('button',{name:'Open results 2'}))
  await screen.findByText(/A newer version of this value was saved/)
  expect(screen.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('Unsaved historical draft')
  fireEvent.click(screen.getByRole('button',{name:/To check title Original title/}))
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
  render(<Results attempt={{extractionId:'extraction'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('Saved results are unavailable.')
})

it('shows a stopped reader and its Reconnect before an earlier values error',async()=> {
  const reader=createDurableReader({extractionId:'extraction',executionStatus:'PAUSED'} as ExtractionAttempt)
  vi.mocked(readDurable).mockResolvedValueOnce({state:pausedState,page:null,pageError:new Error('Request failed (HTTP 502).')} as never)
  render(<Results reader={reader} attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('Request failed (HTTP 502).')
  vi.mocked(readDurable).mockRejectedValue(new ApiRequestError('Not found.',404,'not_found'))
  await act(async()=>{await reader.refresh()})
  expect(await screen.findByRole('button',{name:'Reconnect'})).toBeVisible()
  expect(screen.getByRole('alert')).not.toHaveTextContent('HTTP 502')
  reader.dispose()
})

it('offers Reconnect once its reader stops, and reads again when asked',async()=> {
  vi.mocked(readDurable).mockRejectedValue(new Error('Saved results are unavailable.'))
  render(<Results attempt={{extractionId:'extraction'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}}/>)
  await screen.findByRole('alert')
  const reads=vi.mocked(readDurable).mock.calls.length
  fireEvent.click(screen.getByRole('button',{name:'Reconnect'}))
  await waitFor(()=>expect(vi.mocked(readDurable).mock.calls.length).toBeGreaterThan(reads))
})

it('opens a linked historical correction at its exact result and decision cuts',async()=>{
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'Original',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],
    correction:{revision:2,decision:{action:'EDITED',value:'Historical text correction',included:true,evidence:[]}},historicalCorrection:null}
  const historical={snapshotVersion:1,feedbackVersion:2,reviewCounts:{required:1,toCheck:0,approved:0,edited:1,rejected:0},values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  const current={...historical,snapshotVersion:3,feedbackVersion:4,values:[{...value,node:{...value.node,type:'number'},modelValue:42,correction:null,historicalCorrection:{extractionId:'extraction',valueId:'value',revision:2,snapshotVersion:1,feedbackVersion:2}}]}
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:3,selection:{id:'numeric',ordinal:2},counts:{saved:1,inFlight:0}},page:current} as never)
  vi.mocked(readValues).mockResolvedValue(historical)
  // The document route parses the saved-correction link's cut and passes it as the explicit initial cut; its value is
  // the workspace's request.
  const selection=createSelectionChannel()
  selection.select('value',true,'extraction')
  render(<Results attempt={{extractionId:'extraction',sourceDocumentId:'source',strategy:'ARTICLE'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}} initialCut={{snapshotVersion:1,feedbackVersion:2}} selection={selection}/>)
  await screen.findByRole('region',{name:'Review title'})
  expect(screen.getAllByText('Historical text correction').length).toBeGreaterThan(0)
  expect(readValues).toHaveBeenCalledWith('extraction',{snapshotVersion:1,feedbackVersion:2},expect.any(AbortSignal))
  expect(screen.getByText(/Showing saved results 1/)).toBeVisible()
  expect(screen.queryByText('42')).toBeNull()
})

it('keeps saying an opened cut could not be read once the latest state arrives',async()=>{
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,snapshotVersion:3},page:reviewPage(3,4)} as never)
  vi.mocked(readValues).mockRejectedValue(new Error('Choose a committed result and review snapshot.'))
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} initialCut={{snapshotVersion:1,feedbackVersion:2}}
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  expect(await screen.findByRole('alert')).toHaveTextContent('Choose a committed result and review snapshot.')
  await waitFor(()=>expect(readDurable).toHaveBeenCalled())
  await act(async()=>{await vi.mocked(readDurable).mock.results[0]!.value})
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a committed result and review snapshot.')
  expect(readValues).toHaveBeenCalledOnce()
})

// Skipped while ProjectFeedback ("Corrections the model learns from") is hidden in DurableResults; restore with it.
it.skip('keeps the producing call guidance and budget omissions inspectable after exclusion',async()=>{
  const page={snapshotVersion:1,feedbackVersion:2,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const row={id:'consumed',extractionId:'extraction',sourceDocumentId:'source',valueId:'value',snapshotVersion:1,feedbackVersion:2,revision:2,
    included:true,active:true,selectionId:'selection',targetCompatibility:'compatible',candidate:{value:'Captured example',sourceContext:'own-source',grounded:false},decision:{action:'EDITED'}}
  let excluded=false
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,selection:{id:'selection',ordinal:1},counts:{saved:0,inFlight:0}},page} as never)
  vi.mocked(durableRequest).mockImplementation(async(url,body)=>{if(body){excluded=true;return {}};return url.includes('feedback')?[{...row,included:!excluded}]:page})
  vi.mocked(readDurableHistorySummary).mockResolvedValue({selections:[],snapshots:[],finalizations:[]} as never)
  vi.mocked(readDurableHistory).mockResolvedValue({selections:[{id:'selection',ordinal:1,schemaRevisionId:'schema',schemaTree:{},method:{},resolved:{}}],snapshots:[],finalizations:[],captures:[{
    id:'capture',selectionId:'selection',feedbackVersion:1,invoked:true,descriptor:{stage:'article'},inputDigest:'input',outputDigest:'output',output:{parsed:{title:'Result'}},candidates:[],
    request:{examples:[{id:'consumed',value:'Captured example'}],omissions:[{id:'oversized',reason:'budget'}],budget:{counted:200,context:256,reserve:56}},
  }]} as never)
  const view=render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()} historyShown/>)
  openDetails(await screen.findByText('Saved versions'))
  openDetails(await screen.findByText('Technical details (for audit)'))
  const call=(await screen.findByText('Call · article · input selection 1 · decisions 1')).closest('details')!
  call.open=true;fireEvent(call,new Event('toggle'))
  const guidance=screen.getByText('Consumed guidance and omitted candidates').closest('details')!
  guidance.open=true;fireEvent(guidance,new Event('toggle'))
  const captured=guidance.querySelector('pre')!
  expect(captured).toHaveTextContent('Captured example')
  expect(captured).toHaveTextContent('"reason": "budget"')
  fireEvent.click(await screen.findByRole('button',{name:'Stop using'}))
  await screen.findByRole('button',{name:'Use'})
  expect(captured).toHaveTextContent('Captured example')
  expect(captured).toHaveTextContent('"reason": "budget"')
  view.unmount()
})


// Skipped while ProjectFeedback ("Corrections the model learns from") is hidden in DurableResults; restore with it.
it.skip('warns in Results when pending inputs leave a saved correction unfit, and opens History',async()=>{
  const page={snapshotVersion:1,feedbackVersion:1,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const row={id:'unfit',extractionId:'extraction',sourceDocumentId:'source',valueId:'value',snapshotVersion:1,feedbackVersion:1,revision:1,
    included:true,active:true,selectionId:'selection',targetCompatibility:'incompatible',candidate:{value:'Saved',sourceContext:'source',grounded:false,node:{name:'title'}},decision:{action:'EDITED'}}
  vi.mocked(readDurable).mockResolvedValue({state:{projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:1,selection:{id:'selection',ordinal:1},pendingSelection:{id:'pending',ordinal:2},counts:{saved:0,inFlight:0}},page} as never)
  vi.mocked(durableRequest).mockImplementation(async url=>url.includes('feedback')?[row]:page)
  const onShowHistory=vi.fn(),slot=historySlot()
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} historySlot={slot} onShowHistory={onShowHistory}/>)
  expect(await screen.findByText(/1 saved correction doesn’t fit the pending schema/)).toBeVisible()
  expect(within(slot).getByText('title:')).toBeVisible()
  fireEvent.click(screen.getByRole('button',{name:'See corrections'}))
  expect(onShowHistory).toHaveBeenCalledOnce()
  // History is read only once its tab is shown.
  expect(readDurableHistorySummary).not.toHaveBeenCalled()
  expect(readDurableHistory).not.toHaveBeenCalled()
})

it('acknowledges editing once per inputs edit session and saves the draft under that acknowledgement',async()=>{
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:0,toCheck:0,approved:0,edited:0,rejected:0},values:[],total:0,next:null,coverage:{}} as unknown as DurablePage
  const selection={id:'selection',ordinal:1,schemaRevisionId:'schema',method:{models:null,settings:{article:null}},resolved:{catalogRecipe:null}}
  const state={projectId:'project',status:'PAUSED',controlVersion:4,snapshotVersion:1,selection,pendingSelection:null,counts:{saved:0,inFlight:0}}
  vi.mocked(readDurable).mockResolvedValue({state,page} as never)
  vi.mocked(durableRequest).mockImplementation(async url=>url.endsWith('/control')?{controlVersion:5}:{})
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={{schemaRevisionId:'newer',revisionNumber:2}} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'More result actions'}))
  vi.mocked(readDurable).mockResolvedValue({state:{...state,controlVersion:5,pendingSelection:selection},page} as never)
  fireEvent.click(screen.getByRole('menuitem',{name:'Change inputs'}))
  const schema=await screen.findByRole('combobox',{name:/Schema to use next/})
  for(const value of ['newer','schema','newer'])fireEvent.change(schema,{target:{value}})
  fireEvent.click(screen.getByRole('button',{name:'More result actions'}))
  expect(screen.queryByRole('menuitem',{name:'Change inputs'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'Save pending inputs'}))
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/selection',
    {expectedVersion:5,schemaRevisionId:'newer',method:{models:null,settings:{article:null}}}))
  expect(vi.mocked(durableRequest).mock.calls.filter(([url])=>url.endsWith('/control'))).toEqual([
    ['/api/extractions/extraction/durable/control',{id:expect.any(String),expectedVersion:4,action:'editing'}]])
})

it('keeps the last explicitly selected snapshot when an older selection finishes late',async()=> {
  const value={id:'value',recordId:'document',fieldId:'title',path:['records',0,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue:'New version',evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const latest={snapshotVersion:2,feedbackVersion:0,reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0},status:'PAUSED',values:[value],total:1,next:null,coverage:{}} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'PAUSED',controlVersion:1,snapshotVersion:2,
    selection:{id:'original',ordinal:1},pendingSelection:null,counts:{saved:1,inFlight:0}}
  let finishOld!:(page:DurablePage)=>void
  vi.mocked(readDurable).mockResolvedValue({state,page:latest} as never)
  vi.mocked(readDurableHistorySummary).mockResolvedValue({selections:[],finalizations:[],snapshots:[{id:'one',version:1,valueCount:1},{id:'two',version:2,valueCount:1}]} as never)
  vi.mocked(durableRequest).mockImplementation(async url=>url.includes('feedback')?[]:latest)
  vi.mocked(readValues).mockImplementation(async(_id,query)=>query.snapshotVersion===1?new Promise(resolve=>{finishOld=resolve}):latest)
  render(<Results attempt={{extractionId:'extraction'} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={()=>{}} historySlot={historySlot()} historyShown/>)
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

it.each(['ARTICLE', 'CATALOG'] as const)('reviews ungrounded true and false values before explicitly saving the %s review (#161)', async strategy => {
  const bool = (id: string, modelValue: boolean): DurablePage['values'][number] => ({...reviewValue(id, ''),
    node: {id, name: id, type: 'boolean'}, modelValue, grounding: 'ungrounded', processing: 'saved', correctionCompatibility: 'compatible'})
  const painted = bool('painted', true), leather = bool('leather_material', false)
  let page: DurablePage = {...reviewPage(), values: [painted, leather], total: 2,
    reviewCounts: {required: 2, toCheck: 2, approved: 0, edited: 0, rejected: 0}}
  const state = {...pausedState, status: 'COMPLETED'}
  vi.mocked(readDurable).mockImplementation(async () => ({state, page}) as never)
  vi.mocked(durableRequest).mockResolvedValue({revision: 1})
  render(<Results attempt={{extractionId: 'extraction', strategy} as ExtractionAttempt} document={null}
    currentSchema={null} onEvidence={() => {}} />)
  expect(await screen.findByRole('button', {name: /To check leather_material false/})).toBeVisible()
  expect(screen.getByRole('button', {name: /To check painted true/})).toBeVisible()
  expect(screen.queryByRole('button', {name: 'Save review'})).toBeNull()
  fireEvent.click(screen.getByRole('button', {name: /To check leather_material/}))
  expect(within(screen.getByRole('region', {name: 'Review leather_material'})).getByText('No Evidence linked')).toBeVisible()
  fireEvent.click(screen.getByRole('button', {name: 'Edit'}))
  expect(screen.getByRole('combobox', {name: 'Reviewed value'})).toHaveValue('false')
  fireEvent.change(screen.getByRole('combobox', {name: 'Reviewed value'}), {target: {value: 'true'}})
  page = {...page, feedbackVersion: 1, values: [painted, {...leather, correction: {revision: 1,
    decision: {action: 'EDITED', value: true, included: true, evidence: []}}}],
    reviewCounts: {required: 2, toCheck: 1, approved: 0, edited: 1, rejected: 0}}
  fireEvent.click(screen.getByRole('button', {name: 'Save edit'}))
  await waitFor(() => expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values/leather_material',
    {expectedRevision: 0, snapshotVersion: 1, action: 'EDITED', value: true, included: true, evidence: []}))
  expect(await screen.findByRole('button', {name: /Edited leather_material true/})).toBeVisible()
  expect(screen.queryByRole('button', {name: 'Save review'})).toBeNull()
  fireEvent.click(screen.getByRole('button', {name: /To check painted/}))
  page = {...page, feedbackVersion: 2, values: [{...painted, correction: {revision: 1,
    decision: {action: 'APPROVED', value: true, included: false, evidence: []}}}, page.values[1]!],
    reviewCounts: {required: 2, toCheck: 0, approved: 1, edited: 1, rejected: 0}}
  fireEvent.click(screen.getByRole('button', {name: 'Approve'}))
  expect(await screen.findByRole('button', {name: 'Save review'})).toBeEnabled()
  expect(durableRequest).not.toHaveBeenCalledWith(expect.stringMatching(/finalize$/), expect.anything())
  vi.mocked(readValues).mockResolvedValue({...page, finalization: {id: 'saved', snapshotVersion: 1, feedbackVersion: 2}} as never)
  fireEvent.click(screen.getByRole('button', {name: 'Save review'}))
  await waitFor(() => expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/finalize', {snapshotVersion: 1, feedbackVersion: 2}))
  expect(await screen.findByText('Review saved.')).toBeVisible()
})

it.each(['ARTICLE','CATALOG'] as const)('keeps the only unchecked value reachable when entering one-by-one from an open %s row',async(strategy)=>{
  const page={...reviewPage(),values:[reviewValue('title','Article title')],total:1,
    reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  render(<Results attempt={{extractionId:'extraction',strategy} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:/To check title/}))
  fireEvent.click(screen.getByRole('button',{name:'Review one by one'}))
  expect(screen.getByRole('img',{name:/1 to check/})).toBeVisible()
  expect(screen.queryByText(/You’re caught up with the saved values/)).toBeNull()
  expect(screen.getByRole('region',{name:'Review title'})).toBeVisible()
  expect(screen.getByRole('button',{name:/Approve and next/})).toBeEnabled()
})

it('offers the unchecked list after saving and undoing an edit, then cancelling an invalid edit',async()=>{
  const samples={...reviewValue('samples',''),node:{id:'samples',name:'samples',type:'array',children:[
    {id:'specimen',name:'specimen',type:'string'},
    {id:'strength',name:'tensile_strength_mpa',type:'number'},
    {id:'density',name:'density_g_cm3',type:'number'},
  ]},modelValue:[{specimen:'Redwood',tensile_strength_mpa:10,density_g_cm3:2},{specimen:'Willow',tensile_strength_mpa:20,density_g_cm3:3}]}
  const title={...reviewValue('title','Article title'),correction:{revision:1,decision:{action:'APPROVED',value:'Article title',evidence:[]}}}
  const page={...reviewPage(),values:[title,samples],total:2,reviewCounts:{required:2,toCheck:1,approved:1,edited:0,rejected:0}} as unknown as DurablePage
  const state={...pausedState,status:'COMPLETED'}
  vi.mocked(readDurable).mockResolvedValue({state,page} as never)
  vi.mocked(durableRequest).mockResolvedValue({revision:1})
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:/To check samples/}))
  fireEvent.click(screen.getByRole('button',{name:'Edit'}))
  const edited=samples.modelValue.map((value,index)=>index===0?{...value,tensile_strength_mpa:11}:value)
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:JSON.stringify(edited)}})
  const saved={...page,feedbackVersion:1,values:[title,{...samples,correction:{revision:1,decision:{action:'EDITED',value:edited,evidence:[]}}}],
    reviewCounts:{required:2,toCheck:0,approved:1,edited:1,rejected:0}} as unknown as DurablePage
  vi.mocked(readDurable).mockResolvedValue({state,page:saved} as never)
  fireEvent.click(screen.getByRole('button',{name:'Save edit'}))
  fireEvent.click(await screen.findByRole('button',{name:/Edited samples/}))
  vi.mocked(durableRequest).mockImplementation((async(path:string)=>path.endsWith('/history')?{corrections:[]}:{revision:2}) as never)
  vi.mocked(readDurable).mockResolvedValue({state,page:{...page,feedbackVersion:2}} as never)
  fireEvent.click(screen.getByRole('button',{name:'Undo'}))
  fireEvent.click(await screen.findByRole('button',{name:/To check samples/}))
  fireEvent.click(screen.getByRole('button',{name:'Edit'}))
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:JSON.stringify([{...samples.modelValue[0],tensile_strength_mpa:'invalid'},samples.modelValue[1]])}})
  fireEvent.click(screen.getByRole('button',{name:'Save edit'}))
  expect(screen.getByRole('alert')).toHaveTextContent('The value does not fit its producing field.')
  fireEvent.click(screen.getByRole('button',{name:'Cancel'}))
  fireEvent.click(screen.getByRole('button',{name:'Review one by one'}))
  expect(screen.getByRole('img',{name:/1 approved, 0 edited, 0 rejected, 1 to check/})).toBeVisible()
  expect(screen.queryByText(/You’re caught up with the saved values/)).toBeNull()
  expect(screen.getByRole('region',{name:'Review samples'})).toBeVisible()
  expect(screen.getByRole('button',{name:/Approve and next/})).toBeEnabled()
  expect(screen.getByText('10')).toBeVisible()
})

it('reveals and scrolls shared Evidence in a collapsed record through a filter, without moving the source or scrolling on refresh',async()=>{
  const page=reviewPage(),parsedDocument=decodeParsedDocument(rawDocument),anchor=parsedDocument.evidence_index.anchors[0]!.anchor_id
  page.values=page.values.map((value,index)=>({...value,recordId:index===0?'first':'second',path:['records',index===0?0:1,value.id],
    links:index===0?[]:[{evidenceAnchorId:anchor,resultPath:['records',1,value.id],precision:'segment'}]})) as never
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  const selection=createSelectionChannel(),onEvidence=vi.fn()
  const reader=createDurableReader({extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt)
  const view=render(<Results reader={reader} attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt}
    document={parsedDocument} currentSchema={null} onEvidence={onEvidence} selection={selection}/>)
  const record=await screen.findByRole('button',{name:/Record 2/})
  expect(record).toHaveAttribute('aria-expanded','false')
  fireEvent.change(screen.getByRole('combobox',{name:'Show'}),{target:{value:'approved'}})
  const container=view.container.querySelector<HTMLElement>('.overflow-y-auto')!
  container.scrollTo=vi.fn()
  const original=HTMLElement.prototype.getBoundingClientRect
  const geometry=vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockImplementation(function(this:HTMLElement){
    if(this===container)return new DOMRect(800,60,330,580)
    if(this.dataset.resultKey==='b')return new DOMRect(810,1500,310,200)
    return original.call(this)
  })
  try {
    const linkedKeys=['b','c']
    act(()=>{selection.select('b',false,'extraction',linkedKeys)})
    expect(record).toHaveAttribute('aria-expanded','true')
    expect(screen.getByRole('region',{name:'Review b'})).toBeVisible()
    expect(screen.getByRole('button',{name:/To check c Third title/})).toBeVisible()
    expect(view.container.querySelectorAll('[data-evidence-linked]')).toHaveLength(2)
    expect(container.scrollTo).toHaveBeenCalledExactlyOnceWith({top:1250,left:0,behavior:'auto'})
    expect(screen.getByRole('button',{name:/To check b Second title/})).toHaveFocus()
    expect(onEvidence).not.toHaveBeenCalled()
    await act(async()=>reader.refresh())
    expect(container.scrollTo).toHaveBeenCalledOnce()
    act(()=>{selection.select('b',false,'extraction',linkedKeys)})
    expect(container.scrollTo).toHaveBeenCalledTimes(2)
    fireEvent.click(record)
    expect(record).toHaveAttribute('aria-expanded','false')
  } finally {geometry.mockRestore()}
})

it('lights the rows of values hovered on the page, a collapsed record\'s header for its own, and says which row is under the pointer',async()=>{
  const page=reviewPage()
  page.values=page.values.map((value,index)=>({...value,recordId:index===0?'first':'second',path:['records',index===0?0:1,value.id]})) as never
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  const selection=createSelectionChannel()
  const view=render(<Results attempt={{extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt}
    document={null} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  const record=await screen.findByRole('button',{name:/Record 2/})
  expect(record).toHaveAttribute('aria-expanded','false')
  const row=screen.getByRole('button',{name:/To check a First title/})
  act(()=>selection.hover(['b']))
  expect(record).toHaveAttribute('data-evidence-hovered')
  expect(view.container.querySelectorAll('[data-evidence-hovered]')).toHaveLength(1)
  act(()=>selection.hover(['a']))
  expect(row.closest('[data-result-key]')).toHaveAttribute('data-evidence-hovered')
  expect(record).not.toHaveAttribute('data-evidence-hovered')
  act(()=>selection.hover(null))
  fireEvent.mouseOver(row)
  expect(selection.snapshot().hover).toEqual(['a'])
  fireEvent.mouseOver(record)
  expect(selection.snapshot().hover).toBeNull()
  fireEvent.mouseOver(row)
  view.unmount()
  expect(selection.snapshot().hover).toBeNull()
})

it('polls a paused run only while the server is to resume it, then reads it on return or every 30 s, and polls once it resumes',async()=> {
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,pendingResume:true},page:reviewPage()} as never)
  const attempt={extractionId:'extraction',strategy:'ARTICLE',executionStatus:'PAUSED'} as ExtractionAttempt,reader=createDurableReader(attempt)
  const tick=()=>act(async()=>{await vi.advanceTimersByTimeAsync(1500)})
  vi.useFakeTimers()
  try {
    await act(async()=>{render(<Results reader={reader} attempt={attempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)})
    await tick()
    expect(readDurable).toHaveBeenCalledTimes(2)
    vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,pendingResume:false},page:reviewPage()} as never)
    await tick();await tick();await tick()
    expect(readDurable).toHaveBeenCalledTimes(3)
    await act(async()=>{fireEvent.focus(window)})
    expect(readDurable).toHaveBeenCalledTimes(4)
    await act(async()=>{await vi.advanceTimersByTimeAsync(30_000)})
    expect(readDurable).toHaveBeenCalledTimes(5)
    vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,status:'RUNNING',pendingResume:false},page:reviewPage()} as never)
    // Resume's answer reads it again at once.
    await act(async()=>{await reader.refresh()})
    const resumed=vi.mocked(readDurable).mock.calls.length
    await tick()
    expect(readDurable).toHaveBeenCalledTimes(resumed+1)
  } finally {vi.useRealTimers()}
})

it('moves to the next value once a decision is saved, and a late read never replaces a newer selection or its draft',async()=> {
  const page=reviewPage(),reload=Promise.withResolvers<{state:typeof pausedState;page:DurablePage}>()
  const parsedDocument=decodeParsedDocument(rawDocument),anchor=parsedDocument.evidence_index.anchors[0]!.anchor_id
  // C is linked, so the document marks name it: a mark selects it through the channel.
  page.values[2]={...page.values[2],links:[{evidenceAnchorId:anchor,resultPath:['records',0,'c'],precision:'segment'}]} as never
  vi.mocked(readDurable).mockResolvedValueOnce({state:pausedState,page} as never).mockReturnValue(reload.promise as never)
  vi.mocked(durableRequest).mockResolvedValue({revision:1})
  const selection=createSelectionChannel()
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={parsedDocument} currentSchema={null}
    onEvidence={()=>{}} selection={selection}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  fireEvent.keyDown(screen.getByRole('heading',{name:'First title'}),{key:'a'})
  expect(await screen.findByRole('heading',{name:'Second title'})).toBeVisible()
  act(()=>{selection.select('c',false,'extraction')})
  fireEvent.click(screen.getByRole('button',{name:/^Edit/}))
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'Keep this unsaved draft'}})
  const saved={...reviewPage(1,1),values:page.values.map((value,index)=>index===0?{...value,correction:{revision:1,decision:{action:'APPROVED'}}}:value)} as never as DurablePage
  saved.reviewCounts={required:3,toCheck:2,approved:1,edited:0,rejected:0}
  await act(async()=>reload.resolve({state:pausedState,page:saved}))
  expect(screen.getByRole('region',{name:'Review c'})).toBeVisible()
  expect(screen.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('Keep this unsaved draft')
  expect(screen.queryByRole('heading',{name:'Second title'})).toBeNull()
})

it('saves the review of the latest results once nothing is left to check',async()=> {
  const page={...reviewPage(1,1),reviewCounts:{required:3,toCheck:0,approved:3,edited:0,rejected:0}} as DurablePage
  page.values=page.values.map(value=>({...value,correction:{revision:1,feedbackVersion:1,decision:{action:'APPROVED'}}} as never))
  const latest={...page,feedbackVersion:2,reviewCounts:{required:3,toCheck:0,approved:2,edited:1,rejected:0},
    values:page.values.map((value,index)=>index===1?{...value,correction:{revision:2,feedbackVersion:2,decision:{action:'EDITED',value:'Correction from another session'}}}:value)} as never as DurablePage
  vi.mocked(readDurable).mockResolvedValueOnce({state:pausedState,page} as never).mockResolvedValue({state:{...pausedState,feedbackVersion:2},page:latest} as never)
  vi.mocked(durableRequest).mockResolvedValue({})
  vi.mocked(readValues).mockResolvedValue({...latest,finalization:{id:'final',snapshotVersion:1,feedbackVersion:2}} as never)
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  expect(await screen.findByRole('button',{name:'Save review'})).toBeVisible()
  // A settled view is read again when the researcher comes back to it: another session's correction shows, and saving
  // names the decisions shown.
  await waitFor(()=>{fireEvent.focus(window);expect(readDurable).toHaveBeenCalledTimes(2)})
  expect(await screen.findByText('Correction from another session')).toBeVisible()
  fireEvent.click(screen.getByRole('button',{name:'Save review'}))
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/finalize',{snapshotVersion:1,feedbackVersion:2}))
  expect(await screen.findByText('Review saved.')).toBeVisible()
  expect(screen.getByText(/rejected · review saved/)).toBeVisible()
  expect(screen.queryByRole('button',{name:'Save review'})).toBeNull()
})

it('keeps a cut the researcher opens while the review is being saved',async()=> {
  const page={...reviewPage(2,1),reviewCounts:{required:3,toCheck:0,approved:3,edited:0,rejected:0}} as DurablePage
  const finalized=Promise.withResolvers<unknown>(),onReviewFinalized=vi.fn()
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,snapshotVersion:2},page} as never)
  vi.mocked(readDurableHistorySummary).mockResolvedValue({selections:[],finalizations:[],snapshots:[{id:'one',version:1,valueCount:3},{id:'two',version:2,valueCount:3}]} as never)
  vi.mocked(durableRequest).mockImplementation((async(url:string)=>url.endsWith('/finalize')?finalized.promise:[]) as never)
  vi.mocked(readValues).mockImplementation(async(_id,query)=>query.snapshotVersion===1?reviewPage(1,1):{...page,finalization:{id:'final',snapshotVersion:2,feedbackVersion:1}} as never)
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}
    onReviewFinalized={onReviewFinalized} historySlot={historySlot()} historyShown/>)
  fireEvent.click(await screen.findByRole('button',{name:'Save review'}))
  openDetails(await screen.findByText('Saved versions'))
  fireEvent.click(await screen.findByRole('button',{name:'Open results 1'}))
  expect(await screen.findByText(/Showing saved results 1/)).toBeVisible()
  const reads=vi.mocked(readDurable).mock.calls.length
  await act(async()=>finalized.resolve({}))
  expect(await screen.findByText('Review saved.')).toBeVisible()
  expect(onReviewFinalized).toHaveBeenCalledOnce()
  expect(screen.getByText(/Showing saved results 1/)).toBeVisible()
  expect(readValues).toHaveBeenCalledOnce()
  // The finalized latest is read again, so "Save review" doesn't come back with it.
  await waitFor(()=>expect(vi.mocked(readDurable).mock.calls.length).toBeGreaterThan(reads))
})

it('opens an explicit finalized cut and names the later live work beside it',async()=> {
  const current={...reviewPage(3,4)},historical={...reviewPage(1,2),finalization:{id:'final',snapshotVersion:1,feedbackVersion:2,createdAt:'2026-10-05T09:00:00.000Z'}}
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,snapshotVersion:3},page:current} as never)
  vi.mocked(readValues).mockResolvedValue(historical)
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} initialCut={{snapshotVersion:1,feedbackVersion:2}}
    document={null} currentSchema={null} onEvidence={()=>{}} readOnly/>)
  expect(await screen.findByText(/rejected · review saved/)).toBeVisible()
  expect(readValues).toHaveBeenCalledWith('extraction',{snapshotVersion:1,feedbackVersion:2},expect.any(AbortSignal))
  expect(screen.getByText(/Showing saved results 1 · a saved review/)).toBeVisible()
  fireEvent.click(screen.getByRole('button',{name:'Show the latest results'}))
  expect(screen.queryByText(/Showing saved results/)).toBeNull()
})

it('opens the live cut when no explicit cut is named',async()=> {
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,snapshotVersion:3},page:reviewPage(3,4)} as never)
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}} readOnly/>)
  expect(await screen.findByText('First title')).toBeVisible()
  expect(screen.queryByText(/Showing saved results/)).toBeNull()
  expect(readValues).not.toHaveBeenCalled()
})

it('opens a settled catalogue at its first record to check and at the linked value, and keeps a toggle',async()=>{
  const value=(record:number,modelValue:string|null)=>({id:`r${record}:title`,recordId:`r${record}`,fieldId:'title',path:['records',record,'title'],selectionId:'original',schemaRevisionId:'schema',
    node:{id:'title',name:'title',type:'string'},modelValue,evidence:[],links:[],grounding:modelValue===null?'provisional':'ungrounded',processing:modelValue===null?'absent':'saved',lineage:[],correction:null,historicalCorrection:null})
  const page={snapshotVersion:1,feedbackVersion:0,reviewCounts:{required:3,toCheck:3,approved:0,edited:0,rejected:0},
    values:[value(0,null),value(1,'Second'),value(2,'Third'),value(3,'Fourth')],total:4,next:null,coverage:{}} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'FAILED',controlVersion:1,snapshotVersion:1,feedbackVersion:0,
    selection:{id:'original',ordinal:1,schemaTree:{schemaNodes:[{id:'title',name:'title',type:'string'}]},resolved:{startPage:null}},pendingSelection:null,
    counts:{saved:4,inFlight:0},records:null,reading:[]}
  vi.mocked(readDurable).mockResolvedValue({state,page} as never)
  const attempt={extractionId:'extraction',strategy:'CATALOG'} as ExtractionAttempt,reader=createDurableReader(attempt),selection=createSelectionChannel()
  selection.select('r3:title',true,'extraction')
  render(<Results reader={reader} attempt={attempt} document={null} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  const header=(record:number)=>within(screen.getByRole('region',{name:new RegExp(`^Record ${record},`)})).getAllByRole('button')[0]!
  await waitFor(()=>expect(header(4)).toHaveAttribute('aria-expanded','true'))
  expect(header(1)).toHaveAttribute('aria-expanded','false')
  expect(header(2)).toHaveAttribute('aria-expanded','true')
  expect(header(3)).toHaveAttribute('aria-expanded','false')
  fireEvent.click(header(3))
  fireEvent.click(header(2))
  expect(header(3)).toHaveAttribute('aria-expanded','true')
  expect(header(2)).toHaveAttribute('aria-expanded','false')
  // Reviewing a value in a record the researcher opened keeps it open after the review moves on.
  fireEvent.click(screen.getByRole('button',{name:/title Third/}))
  fireEvent.click(header(2))
  fireEvent.click(screen.getByRole('button',{name:/title Second/}))
  expect(header(3)).toHaveAttribute('aria-expanded','true')
  // A retried run reads again, so its records open as they are read.
  vi.mocked(readDurable).mockResolvedValue({state:{...state,status:'RUNNING',controlVersion:2},page} as never)
  await act(async()=>{await reader.refresh()})
  await waitFor(()=>expect(header(1)).toHaveAttribute('aria-expanded','true'))
})

const disagreementSelection='11111111-1111-4111-8111-111111111111'
const disagreementAlternatives=['Article title','Cited title'].map(value=>({value,segments:['p3_s0']}))
const disagreementPage=()=>({...reviewPage(),total:1,values:[{...reviewValue('title',''),selectionId:disagreementSelection,modelValue:null,
  disagreement:[{path:[],alternatives:disagreementAlternatives}],correctionCompatibility:'compatible'}],reviewCounts:{required:1,toCheck:1,approved:0,edited:0,rejected:0}} as DurablePage)
it('shows both unselected readings, offers no Approve, ignores A, and saves the chosen reading',async()=> {
  const page=disagreementPage()
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  vi.mocked(durableRequest).mockResolvedValue({revision:1})
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:/To check title Article title or Cited title/}))
  expect(screen.getByText('Readings differ',{exact:true})).toBeVisible()
  expect(screen.getAllByText('read in p. 3 · not checked')).toHaveLength(2)
  expect(screen.queryByRole('button',{name:'Approve'})).toBeNull()
  expect(screen.getByRole('button',{name:'Edit'})).toBeVisible()
  expect(screen.getByRole('button',{name:'Reject'})).toBeVisible()
  expect(screen.getByRole('button',{name:'Use Article title'})).toHaveAttribute('aria-pressed','false')
  fireEvent.click(screen.getByRole('button',{name:'Review from here'}))
  fireEvent.keyDown(screen.getByRole('heading',{name:'Article title or Cited title'}),{key:'a'})
  expect(durableRequest).not.toHaveBeenCalledWith(expect.stringContaining('/values/'),expect.anything())
  fireEvent.click(screen.getByRole('button',{name:'Use Article title'}))
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values/title',expect.objectContaining({action:'APPROVED',choices:[{path:[],value:'Article title'}]})))
})
it('waits for a pick at every nested part and keeps the selected buttons visible',async()=> {
  const page=disagreementPage()
  page.values[0]={...page.values[0],node:{id:'work',name:'work',type:'object',children:[{id:'t',name:'title',type:'string'},{id:'y',name:'year',type:'integer'}]},
    modelValue:{title:null,year:null},disagreement:[{path:['t'],alternatives:disagreementAlternatives},{path:['y'],alternatives:disagreementAlternatives.map((a,i)=>({...a,value:1827+i}))}]}
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  vi.mocked(durableRequest).mockResolvedValue({revision:1})
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:/To check work/}))
  fireEvent.click(screen.getByRole('button',{name:'Use Cited title'}))
  expect(screen.getByRole('button',{name:'Use Cited title'})).toHaveAttribute('aria-pressed','true')
  expect(durableRequest).not.toHaveBeenCalledWith(expect.stringContaining('/values/'),expect.anything())
  fireEvent.click(screen.getByRole('button',{name:'Use 1827'}))
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values/title',expect.objectContaining({action:'APPROVED',choices:[{path:['t'],value:'Cited title'},{path:['y'],value:1827}]})))
})
it('changes a chosen reading only through Undo, which returns the value to To check',async()=> {
  const page=disagreementPage()
  page.values[0]={...page.values[0],correction:{revision:1,decision:{action:'APPROVED',value:'Article title',choices:[{path:[],value:'Article title'}],evidence:[],included:false}}}
  page.reviewCounts={required:1,toCheck:0,approved:1,edited:0,rejected:0}
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  vi.mocked(durableRequest).mockImplementation((async(path:string)=>path.endsWith('/history')?{corrections:[]}:{revision:2}) as never)
  render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:/Approved title Article title/}))
  expect(screen.queryByRole('button',{name:'Use Cited title'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'Undo'}))
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values/title',expect.objectContaining({action:'PENDING',expectedRevision:1})))
})

/** a and b link to their own anchors; c has only its correction's Evidence. */
const linkedPage=()=>{
  const page=reviewPage(),link=(id:string)=>[{evidenceAnchorId:`${id}-anchor`,resultPath:['records',0,id],precision:'segment'}]
  page.values=[{...page.values[0]!,links:link('a')},{...page.values[1]!,links:link('b')},
    {...page.values[2]!,correction:{revision:1,decision:{action:'EDITED',value:'Corrected',included:true,evidence:[{anchorId:'own-anchor',occurrenceIds:['o1']}]}}}] as never
  return page
}
const article={extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt

it('takes a value link once its values are read, never again across a re-key, and leaves another Extraction\'s',async()=>{
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page:reviewPage()} as never)
  const selection=createSelectionChannel()
  selection.select('b',true,'extraction')
  const view=render(<Results key="live" attempt={article} document={null} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  expect(await screen.findByRole('region',{name:'Review b'})).toBeVisible()
  expect(selection.snapshot().request).toBeNull()
  // Another cut of the same Extraction opens nothing: the link was taken.
  view.rerender(<Results key="cut" attempt={article} document={null} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  await screen.findByRole('button',{name:'Review one by one'})
  expect(screen.queryByRole('region',{name:'Review b'})).toBeNull()
  act(()=>{selection.select('a',true,'other')})
  expect(screen.queryByRole('region',{name:'Review a'})).toBeNull()
  expect(selection.snapshot().request).toMatchObject({key:'a',extractionId:'other'})
})

it('keeps the open review and its draft when a value link names the value already open',async()=>{
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page:reviewPage()} as never)
  const selection=createSelectionChannel()
  render(<Results attempt={article} document={null} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  fireEvent.click(await screen.findByRole('button',{name:/To check b Second title/}))
  fireEvent.click(screen.getByRole('button',{name:/^Edit/}))
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'Unsaved draft'}})
  act(()=>{selection.select('b',true,'extraction')})
  expect(screen.getByRole('textbox',{name:'Reviewed value'})).toHaveValue('Unsaved draft')
  expect(selection.snapshot().request).toBeNull()
})

it('scrolls once per value link in one-by-one: the follow for another linked value, choose for the same one or a correction\'s Evidence',async()=>{
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page:linkedPage()} as never)
  const onEvidence=vi.fn(),selection=createSelectionChannel()
  render(<Results attempt={article} document={decodeParsedDocument(rawDocument)} currentSchema={null} onEvidence={onEvidence} selection={selection}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith('a-anchor',undefined,'segment')
  onEvidence.mockClear()
  act(()=>{selection.select('b',true,'extraction')})
  expect(screen.getByRole('heading',{name:'Second title'})).toBeVisible()
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith('b-anchor',undefined,'segment')
  // Nothing the follow follows changes, so choose scrolls.
  act(()=>{selection.select('b',true,'extraction')})
  expect(onEvidence).toHaveBeenCalledTimes(2)
  expect(onEvidence).toHaveBeenLastCalledWith('b-anchor',undefined,'segment')
  // The follow follows model links only.
  act(()=>{selection.select('c',true,'extraction')})
  expect(onEvidence).toHaveBeenCalledTimes(3)
  expect(onEvidence).toHaveBeenLastCalledWith('own-anchor',['o1'])
})

it('scrolls a value link in one-by-one once, when the pinned source it waits for arrives',async()=>{
  const document=decodeParsedDocument(rawDocument)
  vi.mocked(readDurable).mockResolvedValue({state:{...pausedState,sourceRevisionId:'pinned'},page:linkedPage()} as never)
  const source=Promise.withResolvers<unknown>()
  vi.mocked(durableRequest).mockReturnValue(source.promise as never)
  const onEvidence=vi.fn(),selection=createSelectionChannel()
  render(<Results attempt={article} document={document} documentRevisionId="newer" currentSchema={null} onEvidence={onEvidence} selection={selection}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  act(()=>{selection.select('b',true,'extraction')})
  expect(screen.getByRole('heading',{name:'Second title'})).toBeVisible()
  expect(onEvidence).not.toHaveBeenCalled()
  await act(async()=>source.resolve({sourceRevisionId:'pinned',document,markdown:'# Saved source'}))
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith('b-anchor',undefined,'segment')
})

it('reads a value its page lacks on its own, and one-by-one follows it once it arrives',async()=>{
  const page=linkedPage()
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  const lookup=Promise.withResolvers<unknown>()
  vi.mocked(durableRequest).mockReturnValue(lookup.promise as never)
  const onEvidence=vi.fn(),selection=createSelectionChannel()
  render(<Results attempt={article} document={decodeParsedDocument(rawDocument)} currentSchema={null} onEvidence={onEvidence} selection={selection}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  onEvidence.mockClear()
  act(()=>{selection.select('z',true,'extraction')})
  expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/values/z?snapshotVersion=1&feedbackVersion=0')
  expect(onEvidence).not.toHaveBeenCalled()
  const z={...reviewValue('z','Off-page title'),links:[{evidenceAnchorId:'z-anchor',resultPath:['records',0,'z'],precision:'segment'}]}
  await act(async()=>lookup.resolve({...page,values:[z]}))
  expect(screen.getByRole('heading',{name:'Off-page title'})).toBeVisible()
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith('z-anchor',undefined,'segment')
  // The same link again: the open review holds the value, so choose scrolls to it once.
  act(()=>{selection.select('z',true,'extraction')})
  await act(async()=>{})
  expect(onEvidence).toHaveBeenCalledTimes(2)
  expect(onEvidence).toHaveBeenLastCalledWith('z-anchor',undefined,'segment')
})

it('holds a value link that arrives while the rail is collapsed, and scrolls to it once on expand',async()=>{
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page:linkedPage()} as never)
  const onEvidence=vi.fn(),selection=createSelectionChannel()
  const props={attempt:article,document:decodeParsedDocument(rawDocument),currentSchema:null,onEvidence,selection}
  const view=render(<Results {...props}/>)
  fireEvent.click(await screen.findByRole('button',{name:'Review one by one'}))
  onEvidence.mockClear()
  view.rerender(<Results {...props} railOpen={false}/>)
  act(()=>{selection.select('b',true,'extraction')})
  expect(screen.getByRole('heading',{name:'First title'})).toBeVisible()
  expect(selection.snapshot().request).toMatchObject({key:'b'})
  view.rerender(<Results {...props}/>)
  // One scroll, to the value asked for: none back to the one shown before.
  expect(screen.getByRole('heading',{name:'Second title'})).toBeVisible()
  expect(onEvidence).toHaveBeenCalledExactlyOnceWith('b-anchor',undefined,'segment')
  // In the list, expanding chooses the value, as a click does.
  fireEvent.click(screen.getByRole('button',{name:'Leave one-by-one review, back to the list'}))
  view.rerender(<Results {...props} railOpen={false}/>)
  act(()=>{selection.select('a',true,'extraction')})
  expect(onEvidence).toHaveBeenCalledOnce()
  view.rerender(<Results {...props}/>)
  expect(onEvidence).toHaveBeenCalledTimes(2)
  expect(onEvidence).toHaveBeenLastCalledWith('a-anchor',undefined,'segment')
})

it.each(['on','off'] as const)('takes a pending value link %s its page once under StrictMode when the values are already read',async(where)=>{
  const page=linkedPage()
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page} as never)
  const z={...reviewValue('z','Off-page title'),links:[{evidenceAnchorId:'z-anchor',resultPath:['records',0,'z'],precision:'segment'}]}
  vi.mocked(durableRequest).mockResolvedValue({...page,values:[z]})
  const reader=createDurableReader(article),selection=createSelectionChannel(),onEvidence=vi.fn()
  // A reader that already holds the values, as when Results mounts again for another cut of its Extraction.
  const release=reader.wantPages()
  await waitFor(()=>expect(reader.snapshot().latestPage).not.toBeNull())
  selection.select(where==='on'?'b':'z',true,'extraction')
  render(<StrictMode><DurableResults reader={reader} attempt={article} document={null} currentSchema={null} onEvidence={onEvidence} selection={selection}/></StrictMode>)
  expect(await screen.findByRole('region',{name:where==='on'?'Review b':'Review z'})).toBeVisible()
  if(where==='on')expect(onEvidence).toHaveBeenCalledExactlyOnceWith('b-anchor',undefined,'segment')
  else expect(durableRequest).toHaveBeenCalledOnce()
  release();reader.dispose()
})

it('publishes its marks with its Extraction, and clears them and the dim when it goes',async()=>{
  vi.mocked(readDurable).mockResolvedValue({state:pausedState,page:linkedPage()} as never)
  const selection=createSelectionChannel()
  const view=render(<Results attempt={article} document={decodeParsedDocument(rawDocument)} currentSchema={null} onEvidence={()=>{}} selection={selection}/>)
  await waitFor(()=>expect(selection.snapshot().marks?.extractionId).toBe('extraction'))
  fireEvent.click(screen.getByRole('button',{name:'Review one by one'}))
  expect(selection.snapshot().dim).toMatchObject({evidenceAnchorId:'a-anchor'})
  view.unmount()
  expect(selection.snapshot()).toMatchObject({marks:null,dim:null})
})

it('shows the run diagnostics of the results shown at their occurrences, and none from an earlier snapshot',async()=>{
  const node={id:'fees',name:'fees',type:'array',itemType:'number'},titleNode={id:'title',name:'title',type:'string'}
  const value={id:'fees',recordId:'document',fieldId:'fees',path:['records',0,'fees'],selectionId:'original',schemaRevisionId:'schema',
    node,modelValue:[10,10],evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null}
  const title={...value,id:'title',fieldId:'title',path:['records',0,'title'],node:titleNode,modelValue:'Own title'}
  const issue=(code:string,field:string,detail:object)=>({code,detail:JSON.stringify({path:[field],...detail}),record:0,path:['records',0,field]})
  const coverage={sourceGeneration:'g1',finalizedAttempt:{attemptId:'0a1b2c3d-0000-4000-8000-000000000001',generation:1,selectionId:'original',complete:true},diagnostics:{issues:[
    issue('uncertain_items','fees',{items:[{index:1,of:'',label:'UNSURE'}]}),
    issue('dropped_items','fees',{dropped:[10],of:['Smith 2001']}),
    issue('resolved_value','title',{chosen:'Own title',alternatives:['Own title','Cited title']}),
    issue('resolution_not_applied','fees',{reason:'invalid_list_reply'}),
    {code:'resolution_failed',detail:'the resolution reply failed; assembled values are retained',record:0,path:null},
    {code:'resolution_exceeds_budget',detail:'the resolution request does not fit; assembled values are retained',record:0,path:null}]}}
  const page={snapshotVersion:3,feedbackVersion:0,reviewCounts:{required:2,toCheck:2,approved:0,edited:0,rejected:0},values:[value,title],total:2,next:null,coverage} as unknown as DurablePage
  const state={extractionId:'extraction',projectId:'project',status:'COMPLETED',controlVersion:0,snapshotVersion:3,feedbackVersion:0,
    selection:{id:'original',ordinal:1,schemaTree:{schemaNodes:[node,titleNode]},resolved:{startPage:null}},pendingSelection:null,counts:{saved:2,inFlight:0},records:null,reading:[]}
  vi.mocked(readDurable).mockResolvedValue({state,page} as never)
  vi.useFakeTimers()
  try {
    await act(async()=>{render(<Results attempt={{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt} document={null} currentSchema={null} onEvidence={()=>{}}/>)})
    const diagnostics=screen.getByRole('region',{name:'Run diagnostics'})
    expect(diagnostics).toHaveTextContent('From saved results 3 · source generation g1 · attempt 0a1b2c3d, generation 1')
    const entries=within(diagnostics).getAllByRole('listitem')
    expect(entries.map(entry=>[entry.textContent,entry.dataset.diagnosticPath])).toEqual([
      ['fees · item 2: 10 · kept, not settled (UNSURE)','["records",0,"fees",1]'],
      ['fees · left out: 10, given to “Smith 2001”','["records",0,"fees"]'],
      ['title · picked Own title among Own title / Cited title','["records",0,"title"]'],
      ['fees · assembled values retained; resolution not applied (invalid list reply)','["records",0,"fees"]'],
      ['assembled values retained; resolution not applied (resolution reply failed)','[]'],
      ['assembled values retained; resolution not applied (request exceeds budget)','[]']])
    // The first of the two equal items is not the uncertain one.
    expect(within(diagnostics).queryByText(/item 1/)).toBeNull()
    // Reprocessing publishes a newer snapshot whose run named nothing: the earlier snapshot's diagnostics stay with it.
    const newer={...page,snapshotVersion:4,coverage:{sourceGeneration:'g1',finalizedAttempt:{attemptId:'9f8e7d6c-0000-4000-8000-000000000002',generation:2,selectionId:'original',complete:true}}}
    vi.mocked(readDurable).mockResolvedValue({state:{...state,snapshotVersion:4},page:newer} as never)
    await act(async()=>{await vi.advanceTimersByTimeAsync(31_000)})
    expect(screen.queryByRole('region',{name:'Run diagnostics'})).toBeNull()
  } finally {vi.useRealTimers()}
})
