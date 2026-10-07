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
  {strategy:'CATALOG',settings:{generic:{discovery_chars:8000,record_chars:4000}},recipe:null},
  {strategy:'CATALOG',settings:{recipe:{input_tokens:4096,output_tokens:512,factors:{overlap:false}}},recipe:'numbered-catalogue-de@1'},
  {strategy:'CATALOG',settings:{unified:{defaults:1,input_tokens:8192,output_tokens:1024,overlap:0,headings:false,verification:false}},recipe:null},
])('can save unchanged $strategy inputs with pinned settings $settings',async({strategy,settings,recipe})=>{
  vi.mocked(readExtractionModels).mockResolvedValue({defaults:{fields:'instruct',reasoning:'instruct'},models:[]} as never)
  const state={controlVersion:3,selection:{id:'selection',schemaRevisionId:'schema',method:{models:null,settings},resolved:{catalogRecipe:recipe}},pendingSelection:null} as unknown as DurableRead
  vi.mocked(durableRequest).mockResolvedValue(state)
  const onSaved=vi.fn()
  render(<DurableInputs attempt={{extractionId:'extraction',strategy} as ExtractionAttempt} state={state} currentSchema='schema' onSaved={onSaved} onEdited={async()=>{}}/>)
  const save=await screen.findByRole('button',{name:'Save pending inputs'})
  expect(screen.queryByRole('alert')).toBeNull()
  expect(save).toBeEnabled()
  expect(screen.getByRole('radio',{name:strategy==='ARTICLE'?'Article':'Catalog'})).toBeChecked()
  fireEvent.click(save)
  await waitFor(()=>expect(durableRequest).toHaveBeenCalledWith('/api/extractions/extraction/durable/selection',{
    expectedVersion:3,schemaRevisionId:'schema',method:{models:null,settings},
  }))
  expect(onSaved).toHaveBeenCalledOnce()
})
