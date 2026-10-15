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
