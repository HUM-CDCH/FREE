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

describe('document history',()=> {
  const project='00000000-0000-4000-8000-000000000002', document='00000000-0000-4000-8000-000000000003'
  const historyRequest=(path=`${project}/source-documents/${document}`)=>new Request(`https://localhost/api/project-contexts/${path}/history`)
  const listed={truncated:false,extractions:[{extractionId:id,createdAt:'2026-10-28T10:00:00.000Z',status:'COMPLETED',strategy:'ARTICLE',
    batchExtractionId:null,sourceRevisionNumber:1,currentSource:true,schemaRevisions:[{schemaRevisionId:project,revisionNumber:2}],
    pendingSchemaRevision:null,finalizations:[{snapshotVersion:1,feedbackVersion:0,createdAt:'2026-10-28T11:00:00.000Z'}]}]}
  it('reads the owned document\'s Extractions uncached',async()=> {
    const documentHistory=vi.fn().mockResolvedValue(listed)
    vi.mocked(createDurableRepository).mockReturnValue({documentHistory} as never)
    const response=await createResearcherApiHandlers(store).GET(historyRequest())
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await response.json()).toEqual(listed)
    expect(documentHistory).toHaveBeenCalledWith(project,document)
  })
  it('refuses malformed identities before reading, and conceals a document outside the owned Project',async()=> {
    const documentHistory=vi.fn().mockRejectedValue(new DurableNotFound('That Source Document was not found in this Project.'))
    vi.mocked(createDurableRepository).mockReturnValue({documentHistory} as never)
    expect((await createResearcherApiHandlers(store).GET(historyRequest(`${project}/source-documents/NOT-A-UUID`))).status).toBe(422)
    expect((await createResearcherApiHandlers(store).GET(historyRequest(`00000000-0000-4000-8000-00000000000A/source-documents/${document}`))).status).toBe(422)
    expect(documentHistory).not.toHaveBeenCalled()
    const response=await createResearcherApiHandlers(store).GET(historyRequest())
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({error:{code:'not_found'}})
  })
  const valueRequest=(query:string)=>new Request(`https://localhost/api/project-contexts/${project}/source-documents/${document}/history/value?${query}`)
  const traced={truncated:false,untraceableRevisions:1,unmatched:2,readings:[{extractionId:id,createdAt:'2026-10-28T10:00:00.000Z',status:'COMPLETED',
    snapshotVersion:3,schemaRevision:{schemaRevisionId:project,revisionNumber:2},node:{id:'title-node',name:'title',type:'string'},processing:'saved',
    modelValue:'Old title',disagreement:null,decision:{action:'EDITED',value:'New title'},decisionIncompatible:false}]}
  it('reads one value\'s history from an owned Extraction of the document uncached',async()=> {
    const valueHistory=vi.fn().mockResolvedValue(traced)
    vi.mocked(createDurableRepository).mockReturnValue({valueHistory} as never)
    const response=await createResearcherApiHandlers(store).GET(valueRequest(`extractionId=${id}&valueId=v%3Atitle`))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    expect(await response.json()).toEqual(traced)
    expect(valueHistory).toHaveBeenCalledWith(project,document,id,'v:title')
  })
  it('refuses a missing or malformed Extraction or value before reading, and conceals one outside the document',async()=> {
    const valueHistory=vi.fn().mockRejectedValue(new DurableNotFound('That Extraction was not found for this Source Document.'))
    vi.mocked(createDurableRepository).mockReturnValue({valueHistory} as never)
    for(const query of ['valueId=title',`extractionId=${id}`,`extractionId=${id}&valueId=`,'extractionId=NOT-A-UUID&valueId=title',`extractionId=${id}&valueId=${'x'.repeat(513)}`])
      expect((await createResearcherApiHandlers(store).GET(valueRequest(query))).status).toBe(422)
    expect(valueHistory).not.toHaveBeenCalled()
    expect((await createResearcherApiHandlers(store).GET(valueRequest(`extractionId=${id}&valueId=title`))).status).toBe(404)
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
  it.each([['a Catalog whose records are all listed',{strategy:'CATALOG',records:[{ordinal:0,page:1}],recordsFinal:true}],['an Article',{strategy:'ARTICLE',records:null,recordsFinal:false}]])('adds no discovery to %s',async(_name,read)=> {
    const state={status:'RUNNING',...read,attempt}
    vi.mocked(createDurableRepository).mockReturnValue({read:vi.fn().mockResolvedValue(state)} as never)
    expect(await (await createResearcherApiHandlers(store).GET(request())).json()).toEqual(state)
  })
  it('adds discovery to a Catalog that lists only the records found so far',async()=> {
    const state={status:'RUNNING',strategy:'CATALOG',records:[{ordinal:0,page:1}],recordsFinal:false,attempt:null}
    vi.mocked(createDurableRepository).mockReturnValue({read:vi.fn().mockResolvedValue(state)} as never)
    expect(await (await createResearcherApiHandlers(store).GET(request())).json()).toEqual({...state,discovery:null})
  })
})
