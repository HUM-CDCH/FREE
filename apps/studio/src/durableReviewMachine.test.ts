import { createActor,waitFor } from 'xstate'
import { describe,it,expect,vi,afterEach } from 'vitest'
import { durableReviewMachine } from './durableReviewMachine'
import type { DurablePage } from 'extraction/durable-types'

vi.mock('./auth/authenticatedFetch',()=>({authenticatedFetch:(...args:unknown[])=>fetch(...args as Parameters<typeof fetch>)}))
afterEach(()=>vi.unstubAllGlobals())
describe('retained value review',()=> {
  it.each([false,true])('appends the prior whole decision on Undo and guards concurrent writes (conflict=%s)',async conflict=>{
    const prior={revision:1,feedbackVersion:1,decision:{action:'EDITED',value:{a:10,b:2},included:false,evidence:[{anchorId:'own',occurrenceIds:['one']}]}}
    const value={id:'value',modelValue:{a:1,b:2},correction:{revision:2,decision:{action:'REJECTED',included:false,evidence:[]}},historicalCorrection:null} as DurablePage['values'][number]
    const requests:unknown[]=[]
    vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=> {
      if(url.endsWith('/history'))return Response.json({corrections:[{...prior,valueId:'value'}]})
      if(!options?.body)return Response.json({values:[{...value,correction:prior}]})
      requests.push(JSON.parse(String(options.body)))
      return conflict?Response.json({error:{message:'Another view saved a newer correction.'}},{status:409}):Response.json({revision:3})
    }))
    const actor=createActor(durableReviewMachine,{input:{extractionId:'extraction',value,snapshotVersion:7}}).start()
    actor.send({type:'undo'})
    await waitFor(actor,s=>conflict?s.matches('editing')&&s.context.error!==null:s.matches('saved'))
    expect(requests).toEqual([{expectedRevision:2,snapshotVersion:7,action:'EDITED',value:{a:10,b:2},included:false,evidence:[{anchorId:'own',occurrenceIds:['one']}]}])
    if(conflict) {
      expect(actor.getSnapshot().context.draft.value).toEqual({a:10,b:2})
      expect(actor.getSnapshot().context.error).toContain('newer correction')
    }
    actor.stop()
  })

  it('uses PENDING only when Undo has no previous saved decision',async()=>{
    const value={id:'value',modelValue:false,correction:{revision:1,decision:{action:'EDITED',value:true,included:true,evidence:[]}}} as DurablePage['values'][number]
    const fetcher=vi.fn(async(url:string,options?:RequestInit)=>url.endsWith('/history')?Response.json({corrections:[]}):Response.json(JSON.parse(String(options?.body))))
    vi.stubGlobal('fetch',fetcher)
    const actor=createActor(durableReviewMachine,{input:{extractionId:'extraction',value,snapshotVersion:7}}).start()
    actor.send({type:'undo'});await waitFor(actor,s=>s.matches('saved'))
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]!.body))).toEqual({expectedRevision:1,snapshotVersion:7,action:'PENDING',value:false,included:false,evidence:[]})
    actor.stop()
  })

  it('keeps incompatible previous decisions in history without saving them on Undo',async()=>{
    const value={id:'value',modelValue:42,correction:{revision:2,decision:{action:'EDITED',value:43,included:true,evidence:[]}}} as DurablePage['values'][number]
    const fetcher=vi.fn(async(url:string)=>url.endsWith('/history')?Response.json({corrections:[{valueId:'value',revision:1,feedbackVersion:1}]}):Response.json({values:[{...value,correction:null,historicalCorrection:{revision:1}}]}))
    vi.stubGlobal('fetch',fetcher)
    const actor=createActor(durableReviewMachine,{input:{extractionId:'extraction',value,snapshotVersion:7}}).start()
    actor.send({type:'undo'});await waitFor(actor,s=>s.matches('editing')&&s.context.error!==null)
    expect(actor.getSnapshot().context.error).toContain('does not fit this model version')
    expect(fetcher.mock.calls.length).toBe(2)
    actor.stop()
  })

  it('reopens the saved correction, Evidence and inclusion without resetting the researcher decision',()=> {
    const value={modelValue:'original',correction:{decision:{action:'EDITED',value:'corrected',included:false,evidence:[{anchorId:'own-anchor',occurrenceIds:['own-occurrence']}]}}} as DurablePage['values'][number]
    const actor=createActor(durableReviewMachine,{input:{extractionId:'extraction',value,snapshotVersion:7}}).start()
    expect(actor.getSnapshot().context.draft).toEqual({value:'corrected',included:false,evidence:[{anchorId:'own-anchor',occurrenceIds:['own-occurrence']}]})
    actor.stop()
  })
  it('retains a typed draft after conflict and reloads the saved version before an explicit retry',async()=> {
    const value={id:'value',recordId:'document',fieldId:'flag',path:['records',0,'flag'],selectionId:'selection',schemaRevisionId:'schema',node:{id:'flag',name:'flag',type:'boolean'},modelValue:false,evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],correction:null,historicalCorrection:null,correctionCompatibility:'compatible'} as DurablePage['values'][number]
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
