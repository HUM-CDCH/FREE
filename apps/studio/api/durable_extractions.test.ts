import type { ResearcherProjectStore } from 'db'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDurableRepository, DurableNotFound } from 'extraction/durable'
import { createResearcherApiHandlers, discoveryProgress } from './durable_extractions'

vi.mock('extraction/durable', async importOriginal => ({
  ...await importOriginal<typeof import('extraction/durable')>(),
  createDurableRepository: vi.fn(),
}))
vi.mock('../server/durable-extraction-workflow.js', () => ({requestDurableReconciliation:vi.fn()}))
afterEach(()=>vi.clearAllMocks())
const id='00000000-0000-4000-8000-000000000001'
const request=()=>new Request(`https://localhost/api/extractions/${id}/durable`)
const store={researcherAccountId:'owner'} as ResearcherProjectStore

describe('durable extraction reads require an owned runtime head',()=> {
  it('returns 404 when no owned durable Extraction exists',async()=> {
    vi.mocked(createDurableRepository).mockReturnValue({read:vi.fn().mockRejectedValue(new DurableNotFound('That Extraction was not found.'))} as never)
    const response=await createResearcherApiHandlers(store).GET(request())
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({error:{code:'not_found'}})
  })
  it('keeps a missing coordination schema unavailable',async()=> {
    vi.mocked(createDurableRepository).mockReturnValue({read:vi.fn().mockRejectedValue(Object.assign(new Error('Unavailable'),{code:'42P01'}))} as never)
    const response=await createResearcherApiHandlers(store).GET(request())
    expect(response.status).toBe(503)
    expect(await response.json()).not.toHaveProperty('protocol')
  })
})

describe('discovery progress',()=> {
  const attempt={id:'attempt',workflowId:'kei-durable:extraction:attempt'}
  it('lists the record starts of the windows read and those each window being read has generated so far, by its own lines',async()=> {
    const places:Record<string,unknown[][]>={'kei-call:attempt:call':[['L2','record','2'],['L1','other',null],['L9','record',null]],
      'kei-call:attempt:other':[['L1','record','3']]}
    const getEvent=vi.fn(async(workflow:string,key:string)=>workflow===attempt.workflowId&&key==='discovery'
      ?{found:[{segment:'p1_s0',label:'1'}],windows:[{capture:'call',lines:[{segment:'p2_s0'},{segment:'p2_s1'}]},
        {capture:'other',lines:[{segment:'p3_s0'}]}]}
      :key==='places'?places[workflow]??null:null)
    expect(await discoveryProgress(attempt,{getEvent} as never)).toEqual({found:[{segment:'p1_s0',label:'1'},{segment:'p2_s1',label:'2'},{segment:'p3_s0',label:'3'}]})
  })
  it('reads as none without an attempt, before the first event, or when the events cannot be read',async()=> {
    expect(await discoveryProgress(null,{getEvent:vi.fn()} as never)).toBeNull()
    expect(await discoveryProgress(attempt,{getEvent:vi.fn().mockResolvedValue(null)} as never)).toBeNull()
    expect(await discoveryProgress(attempt,{getEvent:vi.fn().mockRejectedValue(new Error('offline'))} as never)).toBeNull()
    // An event an earlier worker wrote (one `lines` for every capture) reads as none, never a wrong line.
    expect(await discoveryProgress(attempt,{getEvent:vi.fn(async(_workflow:string,key:string)=>key==='discovery'
      ?{found:[{segment:'p1_s0',label:'1'}],lines:[{segment:'p2_s0'}],captures:['call']}:[['L1','record','2']])} as never)).toBeNull()
  })
  it.each([['a Catalog whose records are listed',{strategy:'CATALOG',records:[{ordinal:0,page:1}]}],['an Article',{strategy:'ARTICLE',records:null}]])('adds no discovery to %s',async(_name,read)=> {
    const state={status:'RUNNING',...read,attempt}
    vi.mocked(createDurableRepository).mockReturnValue({read:vi.fn().mockResolvedValue(state)} as never)
    expect(await (await createResearcherApiHandlers(store).GET(request())).json()).toEqual(state)
  })
})
