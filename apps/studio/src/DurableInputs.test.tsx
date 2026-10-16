// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import type {DurableRead} from 'extraction/durable-types'
import {REFERENCE_ARTICLE} from 'extraction/extraction-method'
import type {ExtractionAttempt} from '../shared/extraction.contract'
import {DurableInputs} from './DurableInputs'
import {readExtractionModels} from './api'
import {durableRequest} from './durableExtractionApi'

vi.mock('./api',()=>({readExtractionModels:vi.fn()}))
vi.mock('./durableExtractionApi',()=>({durableRequest:vi.fn(),durableRoot:(id:string)=>`/api/extractions/${id}/durable`}))
afterEach(()=>{cleanup();vi.resetAllMocks()})

it.each([
  {strategy:'ARTICLE',settings:{article:null},recipe:null},
  {strategy:'CATALOG',settings:{generic:null},recipe:null},
  {strategy:'CATALOG',settings:{recipe:null},recipe:'numbered-catalogue-de@1'},
  {strategy:'CATALOG',settings:{unified:{defaults:1}},recipe:null},
  {strategy:'ARTICLE',settings:{article:{...REFERENCE_ARTICLE,context:'bounded',context_tokens:8192}},recipe:null},
  {strategy:'ARTICLE',settings:{article:{...REFERENCE_ARTICLE,context:'bounded',identity:'conservative',identity_fields:['Species'],prompt:'schema',selection:'supported',grounding:'spans',grounding_schedule:'unresolved',grounding_routing:'origin_lexical'}},recipe:null},
  {strategy:'CATALOG',settings:{generic:{discovery_chars:8000,record_chars:4000}},recipe:null},
  {strategy:'CATALOG',settings:{recipe:{input_tokens:4096,output_tokens:512,factors:{overlap:false}}},recipe:'numbered-catalogue-de@1'},
  {strategy:'CATALOG',settings:{unified:{defaults:1,input_tokens:8192,output_tokens:1024,overlap:0,headings:false,verification:false}},recipe:null},
])('can save unchanged $strategy inputs with pinned settings $settings',async({strategy,settings,recipe})=>{
  vi.mocked(readExtractionModels).mockResolvedValue({defaults:{fields:'instruct',reasoning:'instruct'},models:[]} as never)
  const state={controlVersion:3,selection:{id:'selection',schemaRevisionId:'schema',method:{models:null,settings},resolved:{catalogRecipe:recipe}},pendingSelection:null} as unknown as DurableRead
  vi.mocked(durableRequest).mockResolvedValue(state)
  const onSaved=vi.fn()
  render(<DurableInputs attempt={{extractionId:'extraction',strategy} as ExtractionAttempt} state={state} acknowledged={3} currentSchema='schema' onSaved={onSaved} onEdited={async()=>{}}/>)
  const save=await screen.findByRole('button',{name:'Save pending inputs'})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(save).toBeEnabled()
  expect(screen.getByRole('radio',{name:strategy==='ARTICLE'?'Article':'Catalog'})).toBeChecked()
  // A unified Extraction's editor shows the defaults version it runs under, not the latest.
  if('unified' in settings&&settings.unified&&!('input_tokens' in settings.unified))expect(screen.getByText('Service defaults, version 1')).toBeInTheDocument()
  fireEvent.click(save)
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/selection',{
    expectedVersion:3,schemaRevisionId:'schema',method:{models:null,settings},
  }))
  expect(onSaved).toHaveBeenCalledOnce()
})

const article={...REFERENCE_ARTICLE,context:'bounded',context_tokens:8192}
const inputs=(id:string,context_tokens:number)=>({id,schemaRevisionId:'schema',method:{models:null,settings:{article:{...article,context_tokens}}},resolved:{catalogRecipe:null}})
const active=inputs('active',8192)
const read=(controlVersion:number,pendingSelection:unknown,selection:unknown=active)=>({controlVersion,selection,pendingSelection}) as unknown as DurableRead
/** The editor as "Change inputs" opens it: under the editing acknowledgement `state` was read at. It returns a poll. */
const open=(state:DurableRead,{onSaved=vi.fn(),onEdited=vi.fn(async()=>{})}={})=> {
  vi.mocked(readExtractionModels).mockResolvedValue({defaults:{fields:'instruct',reasoning:'instruct'},models:[]} as never)
  const props={attempt:{extractionId:'extraction',strategy:'ARTICLE'} as ExtractionAttempt,acknowledged:state.controlVersion,currentSchema:'schema',onSaved,onEdited}
  const view=render(<DurableInputs {...props} state={state}/>)
  return (next:DurableRead)=>view.rerender(<DurableInputs {...props} state={next}/>)
}
const ceiling=()=>screen.getByLabelText('Context ceiling')
const save=()=>screen.getByRole('button',{name:'Save pending inputs'})
const selected=(expectedVersion:number,context_tokens:number)=>({expectedVersion,schemaRevisionId:'schema',method:{models:null,settings:{article:{...article,context_tokens}}}})

it('keeps every change local to the edit session and saves the draft under its editing acknowledgement',async()=>{
  open(read(4,active))
  for(const text of ['9','90','900','9000'])fireEvent.change(ceiling(),{target:{value:text}})
  fireEvent.click(save())
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledOnce())
  expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/selection',selected(4,9000))
})

it.each([
  {change:'adopts',next:read(5,null,inputs('pending',10000))},
  {change:'discards',next:read(5,null)},
  {change:'replaces',next:read(5,inputs('other',12288))},
])('keeps the draft and offers Reload draft instead of Save once another view $change the pending inputs',({next})=>{
  const poll=open(read(4,inputs('pending',10000)))
  fireEvent.change(ceiling(),{target:{value:'9000'}})
  poll(next)
  expect(ceiling()).toHaveValue('9000')
  expect(screen.getByRole('button',{name:'Reload draft'})).toBeEnabled()
  expect(save()).toBeDisabled()
  expect(durableRequest).not.toHaveBeenCalled()
})

it('reloads the saved inputs under a new editing acknowledgement once the pending inputs are gone',async()=>{
  const onEdited=vi.fn(async()=>{})
  const poll=open(read(4,inputs('pending',10000)),{onEdited})
  fireEvent.change(ceiling(),{target:{value:'9000'}})
  const discarded=read(5,null)
  poll(discarded)
  vi.mocked(durableRequest).mockResolvedValueOnce(discarded).mockResolvedValueOnce({controlVersion:6})
  fireEvent.click(screen.getByRole('button',{name:'Reload draft'}))
  await waitFor(()=>expect(ceiling()).toHaveValue('8192'))
  expect(durableRequest).toHaveBeenLastCalledWith('/api/extractions/extraction/durable/control',{id:expect.any(String),expectedVersion:5,action:'editing'})
  await waitFor(()=>expect(onEdited).toHaveBeenCalledOnce())
  poll(read(6,active))
  expect(screen.queryByRole('button',{name:'Reload draft'})).toBeNull()
  fireEvent.click(save())
  await waitFor(()=>expect(durableRequest).toHaveBeenLastCalledWith('/api/extractions/extraction/durable/selection',selected(6,8192)))
})

it('reloads replaced pending inputs as they are, without acknowledging editing again',async()=>{
  const poll=open(read(4,inputs('pending',10000)))
  fireEvent.change(ceiling(),{target:{value:'9000'}})
  poll(read(5,inputs('other',12288)))
  fireEvent.click(screen.getByRole('button',{name:'Reload draft'}))
  await waitFor(()=>expect(ceiling()).toHaveValue('12288'))
  fireEvent.click(save())
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledOnce())
  expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/selection',selected(5,12288))
})

it('keeps the draft and shows the server’s message when Save conflicts',async()=>{
  const onSaved=vi.fn()
  open(read(4,active),{onSaved})
  fireEvent.change(ceiling(),{target:{value:'9000'}})
  vi.mocked(durableRequest).mockRejectedValueOnce(new Error('The Extraction changed. Reload to review the saved state.'))
  fireEvent.click(save())
  expect(await screen.findByRole('alert')).toHaveTextContent('The Extraction changed. Reload to review the saved state.')
  expect(ceiling()).toHaveValue('9000')
  expect(onSaved).not.toHaveBeenCalled()
})
