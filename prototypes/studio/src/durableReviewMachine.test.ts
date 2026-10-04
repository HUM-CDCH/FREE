import { createActor,waitFor } from 'xstate'
import { describe,it,expect,vi,afterEach } from 'vitest'
import { durableReviewMachine } from './durableReviewMachine'
import type { DurablePage } from 'extraction/durable-types'

vi.mock('./auth/authenticatedFetch',()=>({authenticatedFetch:(...args:unknown[])=>fetch(...args as Parameters<typeof fetch>)}))
afterEach(()=>vi.unstubAllGlobals())
describe('retained value review',()=> {
  it('reopens the saved correction, Evidence and inclusion without resetting the researcher decision',()=> {
    const value={modelValue:'original',correction:{decision:{action:'EDITED',value:'corrected',included:false,evidence:[{anchorId:'own-anchor',occurrenceIds:['own-occurrence']}]}}} as DurablePage['values'][number]
    const actor=createActor(durableReviewMachine,{input:{extractionId:'extraction',value,snapshotVersion:7}}).start()
    expect(actor.getSnapshot().context.draft).toEqual({value:'corrected',included:false,evidence:[{anchorId:'own-anchor',occurrenceIds:['own-occurrence']}]})
    actor.stop()
  })
  it('retains a typed draft after conflict and reloads the saved version before an explicit retry',async()=> {
    const value={id:'value',recordId:'document',fieldId:'flag',path:['records',0,'flag'],selectionId:'selection',schemaRevisionId:'schema',node:{id:'flag',name:'flag',type:'boolean'},modelValue:false,evidence:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null,correctionCompatibility:'compatible'} as DurablePage['values'][number]
    const requests:unknown[]=[]
    vi.stubGlobal('fetch',vi.fn(async(_url:string,options?:RequestInit)=> {
      if(!options?.body)return Response.json({values:[{...value,correction:{revision:1,decision:{action:'EDITED',value:false}}}]})
      const body=JSON.parse(String(options.body));requests.push(body)
      return body.expectedRevision===0?Response.json({error:{message:'Another view saved a newer correction.'}},{status:409}):Response.json({revision:2})
    }))
    const actor=createActor(durableReviewMachine,{input:{extractionId:'extraction',value,snapshotVersion:7}}).start()
    actor.send({type:'edit',draft:{value:true,included:true,evidence:[]}})
    actor.send({type:'save',action:'EDITED'})
    await waitFor(actor,s=>s.matches('editing')&&s.context.error!==null)
    expect(actor.getSnapshot().context.draft.value).toBe(true)
    actor.send({type:'refresh'})
    await waitFor(actor,s=>s.matches('editing')&&s.context.value.correction?.revision===1)
    expect(actor.getSnapshot().context.draft.value).toBe(true)
    actor.send({type:'save',action:'EDITED'})
    await waitFor(actor,s=>s.matches('saved'))
    expect(requests).toEqual([{expectedRevision:0,snapshotVersion:7,action:'EDITED',value:true,included:true,evidence:[]},{expectedRevision:1,snapshotVersion:7,action:'EDITED',value:true,included:true,evidence:[]}])
    actor.stop()
  })
})
