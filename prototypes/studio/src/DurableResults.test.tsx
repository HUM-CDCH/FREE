// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import type { ExtractionAttempt } from '../shared/extraction.contract'
import { DurableResults } from './DurableResults'
import { durableRequest, readDurable, readDurableHistory } from './durableExtractionApi'

vi.mock('./durableExtractionApi',()=>({durableRequest:vi.fn(),readDurable:vi.fn(),readDurableHistory:vi.fn(),durableRoot:(id:string)=>`/api/extractions/${id}/durable`}))
afterEach(()=>{cleanup();vi.resetAllMocks()})

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
    document={null} currentSchema={null} onEvidence={()=>{}}/>)
  const summary=await screen.findByText('Saved history and producing inputs')
  const details=summary.closest('details')!;details.open=true;fireEvent(details,new Event('toggle'))
  fireEvent.click(await screen.findByRole('button',{name:'Open snapshot 1'}))
  await screen.findByText('Original title')
  fireEvent.click(screen.getByRole('button',{name:/To check title/}))
  fireEvent.click(screen.getByRole('button',{name:'Edit'}))
  fireEvent.change(screen.getByRole('textbox',{name:'Reviewed value'}),{target:{value:'Unsaved historical draft'}})
  fireEvent.click(screen.getByRole('button',{name:'Open snapshot 2'}))
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
    currentSchema={null} onEvidence={()=>{}}/>)
  const summary=await screen.findByText('Saved history and producing inputs'),details=summary.closest('details')!
  details.open=true;fireEvent(details,new Event('toggle'))
  fireEvent.click(await screen.findByRole('button',{name:'Open snapshot 1'}))
  fireEvent.click(screen.getByRole('button',{name:'Open snapshot 2'}))
  await act(async()=>finishOld({...latest,snapshotVersion:1,values:[{...latest.values[0],modelValue:'Old version'}]}))
  expect(screen.getByText('New version')).toBeVisible()
  expect(screen.queryByText('Old version')).toBeNull()
})
