import {expect,it,vi} from 'vitest'
import {discoveryProgress} from './durable_extractions'

it('one malformed streamed item preserves previously found and healthy live starts',async()=>{
  const getEvent=vi.fn(async(_workflow:string,key:string)=>key==='discovery'
    ?{found:[{segment:'p1_s0',label:'1'}],windows:[{capture:'call',lines:[{segment:'p2_s0'}]}]}
    :[['L1','record','2'],null])
  expect(await discoveryProgress({id:'attempt',workflowId:'workflow'},{getEvent} as never))
    .toEqual({found:[{segment:'p1_s0',label:'1'},{segment:'p2_s0',label:'2'}]})
})

it.each([
  null, 42, 'broken', {}, [], ['L1'], ['L1','record'], ['X1','record','bad'],
  ['L0','record','bad'], ['L01','record','bad'], ['L1.0','record','bad'],
  ['L1','record',42], ['L1','record',null,42], ['L1','record',null,'quote','extra'],
].map(bad=>[bad]))('skips a malformed place (%j) without hiding healthy places',async bad=>{
  const getEvent=vi.fn(async(_workflow:string,key:string)=>key==='discovery'
    ?{found:[{segment:'p1_s0',label:'1'}],windows:[{capture:'call',lines:[{segment:'p2_s0'},{segment:'p2_s1'}]}]}
    :[['L1','record','2'],bad,['L2','record',null]])
  expect(await discoveryProgress({id:'attempt',workflowId:'workflow'},{getEvent} as never))
    .toEqual({found:[{segment:'p1_s0',label:'1'},{segment:'p2_s0',label:'2'},{segment:'p2_s1',label:null}]})
})

it.each(['unreadable','malformed'])('isolates an %s window from previously found and other streamed starts',async failure=>{
  const getEvent=vi.fn(async(workflow:string,key:string)=>{
    if(key==='discovery')return {found:[{segment:'p1_s0',label:'1'}],windows:[
      {capture:'broken',lines:[{segment:'p2_s0'}]},{capture:'healthy',lines:[{segment:'p3_s0'}]}]}
    if(workflow.endsWith(':healthy'))return [['L1','record','3']]
    if(failure==='unreadable')throw new Error('window unavailable')
    return {places:[['L1','record','2']]}
  })
  expect(await discoveryProgress({id:'attempt',workflowId:'workflow'},{getEvent} as never))
    .toEqual({found:[{segment:'p1_s0',label:'1'},{segment:'p3_s0',label:'3'}]})
})

const line=(segment:string,start:number,end:number)=>({segment,start,end})
it('keeps the text each found record owns, its consecutive lines in a segment as one range',async()=>{
  const getEvent=vi.fn(async(_workflow:string,key:string)=>key==='discovery'
    ?{found:[{segment:'p1_s0',label:'1',ranges:[line('p1_s0',0,10),line('p1_s0',11,20),line('p1_s1',0,5)]},
      // Ranges that are not ranges leave the start alone.
      {segment:'p1_s2',label:null,ranges:[line('p1_s2',0,4),{segment:'p1_s2'}]}],windows:[]}:null)
  expect(await discoveryProgress({id:'attempt',workflowId:'workflow'},{getEvent} as never)).toEqual({found:[
    {segment:'p1_s0',label:'1',ranges:[line('p1_s0',0,20),line('p1_s1',0,5)]},{segment:'p1_s2',label:null}]})
})

it('previews a streamed record from its line to the line before the next place, the last place by its start line alone',async()=>{
  const lines=[line('p2_s0',0,8),line('p2_s0',9,20),line('p2_s1',0,6),line('p2_s2',0,7),line('p2_s2',8,15),line('p2_s3',0,3)]
  const getEvent=vi.fn(async(_workflow:string,key:string)=>key==='discovery'?{found:[],windows:[{capture:'call',lines}]}
    :[['L1','record','7'],['L4','other',null],null,['L5','record',null,'quote'],['L6','context',null],['L6','record','9']])
  expect(await discoveryProgress({id:'attempt',workflowId:'workflow'},{getEvent} as never)).toEqual({found:[
    {segment:'p2_s0',label:'7',ranges:[line('p2_s0',0,20),line('p2_s1',0,6)]},
    {segment:'p2_s2',label:null,ranges:[line('p2_s2',8,15)]},
    // The place still being generated has its start line alone.
    {segment:'p2_s3',label:'9',ranges:[line('p2_s3',0,3)]}]})
})
