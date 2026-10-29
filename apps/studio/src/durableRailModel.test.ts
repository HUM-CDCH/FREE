import { rowText } from './reviewVocabulary'
import { expect, it } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import { durableRailModel, durableRailRow, markValueId, ownsMark, partKey, valueParts, type RetainedValue } from './durableRailModel'

const value=(overrides:Partial<RetainedValue>={}):RetainedValue=>({
  id:'saved-value',recordId:'source-bound-record',fieldId:'flag',path:['records',0,'flag'],
  selectionId:'producing-selection',schemaRevisionId:'producing-schema',node:{id:'flag',name:'flag',type:'boolean'},
  modelValue:false,evidence:[],links:[],grounding:'ungrounded',processing:'saved',lineage:[],
  correction:null,historicalCorrection:null,correctionCompatibility:'compatible',...overrides,
})

it('keeps unrelated records and corrections distinct when their display positions coincide',()=> {
  const values=[value(),value({id:'new-value',recordId:'new-record',selectionId:'new-selection',modelValue:true})]
  const model=durableRailModel({values} as DurablePage,null)
  expect(model.records.map(record=>record.key)).toEqual(['source-bound-record','new-record'])
  expect(model.records.flatMap(record=>record.rows.map(row=>row.key))).toEqual(['saved-value','new-value'])
  expect(model.counts.toCheck).toBe(2)
})

it('reviews saved ungrounded and provisional whole typed values without inventing child decisions',()=> {
  const original={title:'Book',selected:false}
  const node={id:'work',name:'work',type:'object' as const,children:[{id:'title',name:'title',type:'string' as const},{id:'selected',name:'selected',type:'boolean' as const}]}
  const saved=value({fieldId:'work',node,modelValue:original,grounding:'provisional'})
  const row=durableRailRow(saved,null)
  expect(row.kind).toBe('to-check')
  expect(row.retained?.reviewable).toBe(true)
  expect(row.value).toEqual(original)
  expect(row.retained?.source).toBe('Evidence is still being checked')
  expect(durableRailModel({values:[saved]} as DurablePage,null).records[0].rows).toHaveLength(1)
  expect(durableRailRow(value({processing:'unprocessed'}),null).retained?.reviewable).toBe(false)
})

it('keeps a rule link factual and a researcher correction independent of model Evidence',()=> {
  const saved=value({links:[{resultPath:['records',0,'flag'],evidenceAnchorId:'own-anchor',linkedBy:'lexical',verbatim:true,lexicalHits:1}],
    correction:{revision:1,decision:{action:'EDITED',value:true,evidence:[],included:true}} as RetainedValue['correction']})
  const row=durableRailRow(saved,null)
  expect(row.value).toBe(true)
  expect(row.extracted).toBe(false)
  expect(row.kind).toBe('edited')
  // A linked value keeps the shared row's own words ("p.{n} · Linked by rule…").
  expect(row.retained?.source).toBeUndefined()
  expect(row.chip).toEqual({text:'linked · rule',style:'rule'})
})

it('shows a linked value saved while the run goes on as linked, not as still being checked',()=> {
  const row=durableRailRow(value({grounding:'provisional',node:{id:'flag',name:'flag',type:'string'},
    links:[{resultPath:['records',0,'flag'],evidenceAnchorId:'own-anchor',verbatim:true,lexicalHits:1,grounding:{linkedBy:'verification'}}] as never}),null)
  expect(row.retained?.source).toBeUndefined()
  expect(row.chip).toEqual({text:'linked',style:'link'})
})

it('marks a missing value as missing while the run goes on and after it, never as still being checked',()=> {
  for(const grounding of ['provisional','ungrounded'] as const) {
    const row=durableRailRow(value({modelValue:null,processing:'absent',grounding}),null)
    expect(row.kind).toBe('missing')
    expect(row.chip).toEqual({text:'missing',style:'neutral'})
    expect(row.evidence).toEqual({label:'No value',detail:'No value was extracted.'})
  }
})

it('lists the records discovery found as queued or reading until their values are saved, nearest the start page first',()=> {
  const saved=value({path:['records',2,'flag']})
  const model=durableRailModel({values:[saved]} as DurablePage,null,{records:[{ordinal:0,page:1},{ordinal:1,page:4},{ordinal:2,page:5}],
    reading:new Set([1]),fields:['flag','note'],startPage:5})
  expect(model.records.map(record=>[record.label,record.state])).toEqual([['Record 3','finished'],['Record 2','reading'],['Record 1','queued']])
  expect(model.records[1]!.rows.map(row=>[row.name,row.kind])).toEqual([['flag','reading'],['note','reading']])
  expect(model.records[2]!.rows).toEqual([])
  expect(model.counts).toMatchObject({toCheck:1,required:1,notReviewable:0})
})

it('keeps disagreements to check with their readings, and shows a chosen reading as approved',()=> {
  const saved=value({modelValue:null,disagreement:[{path:[],alternatives:[{value:false,segments:['p3_s0']},{value:true,segments:['p3_s0']}]}]})
  const row=durableRailRow(saved,null)
  expect(row.kind).toBe('to-check')
  expect(row.chip?.text).toBe('readings differ')
  expect(row.disagreement).toEqual([{part:'',path:[],alternatives:[{value:false,pages:'p. 3'},{value:true,pages:'p. 3'}]}])
  expect(rowText(row)).toBe('false or true')
  const approved={...saved,correction:{decision:{action:'APPROVED',value:false,choices:[{path:[],value:false}]}} as RetainedValue['correction']}
  const chosen=durableRailRow(approved,null)
  expect(chosen.kind).toBe('approved')
  expect(chosen.value).toBe(false)
  expect(durableRailModel({values:[approved]} as DurablePage,null).counts).toMatchObject({toCheck:0,approved:1,required:1})
  expect(rowText(durableRailRow({...saved,correction:{decision:{action:'REJECTED'}} as RetainedValue['correction']},null))).toBe('false or true')
})

it('names each scalar part of a composite value with its own link, and keys it back to its value',()=> {
  const node={id:'skelet',name:'skelet',type:'object' as const,children:[{id:'art',name:'art',type:'string' as const},
    {id:'dele',name:'dele',type:'array' as const,children:[{id:'nr',name:'nr',type:'string' as const},{id:'note',name:'note',type:'string' as const}]}]}
  const cell={evidenceAnchorId:'a_p1_s2_r1_c1',resultPath:['records',0,'skelet','dele',0,'note'],precision:'cell'} as unknown as RetainedValue['links'][number]
  const saved=value({id:'v1',fieldId:'skelet',path:['records',0,'skelet'],node,modelValue:{art:'Human',dele:[{nr:'1',note:'Tooth'}]},links:[cell]})
  const parts=valueParts(saved)
  expect(parts.map(part=>[part.name,part.value,part.link])).toEqual([['skelet › art','Human',null],
    ['skelet › dele › #1 › nr','1',null],['skelet › dele › #1 › note','Tooth',cell]])
  const key=parts[2]!.key
  expect(markValueId(key)).toBe('v1')
  expect([ownsMark('v1',key),ownsMark('v1','v10'),ownsMark(key,'v1')]).toEqual([true,false,false])
  // A part's row is that part's Evidence; the decision stays the whole value's.
  expect(durableRailRow(saved,null,parts[0]).chip?.text).toBe('no evidence')
  expect(durableRailRow(saved,null,parts[2]).link).toBe(cell)
  expect(durableRailRow(saved,null,parts[0]).decision?.evidenceAnchorId).toBe('a_p1_s2_r1_c1')
  expect(valueParts(value())).toEqual([])
})

it('links an edited value\'s parts only where the model read the same item at the same path',()=> {
  const node={id:'skelet',name:'skelet',type:'object' as const,children:[{id:'art',name:'art',type:'string' as const},
    {id:'dele',name:'dele',type:'array' as const,children:[{id:'nr',name:'nr',type:'string' as const},{id:'note',name:'note',type:'string' as const}]}]}
  const link=(...path:(string|number)[])=>({evidenceAnchorId:'a_p1_s1',resultPath:['records',0,'skelet',...path],precision:'cell'}) as unknown as RetainedValue['links'][number]
  const links=[link('art'),link('dele',0,'nr'),link('dele',0,'note'),link('dele',1,'nr'),link('dele',1,'note')]
  const linked=(edit:unknown)=>valueParts(value({id:'v1',fieldId:'skelet',path:['records',0,'skelet'],node,links,
    modelValue:{art:'Human',dele:[{nr:'1',note:'Tooth'},{nr:'2',note:'Tooth'}]},
    correction:{revision:1,decision:{action:'EDITED',value:edit,included:true,evidence:[]}}} as Partial<RetainedValue>))
    .map(part=>[part.name,part.value,part.link!==null])
  // Dropping the first row: row #1 is the model's second, though its note reads the same.
  expect(linked({art:'Human',dele:[{nr:'2',note:'Tooth'}]})).toEqual([['skelet › art','Human',true],
    ['skelet › dele › #1 › nr','2',false],['skelet › dele › #1 › note','Tooth',false]])
  // Inserting a row first: no row sits where the model read it.
  expect(linked({art:'Human',dele:[{nr:'0',note:'Tooth'},{nr:'1',note:'Tooth'},{nr:'2',note:'Tooth'}]}).filter(([,,kept])=>kept))
    .toEqual([['skelet › art','Human',true]])
  // An edited cell and art: their rows and art lose their links; an unchanged row keeps them, whatever its keys' order.
  expect(linked({art:'Animal',dele:[{note:'Tooth',nr:'1'},{nr:'2',note:'Molar'}]}).filter(([,,kept])=>kept))
    .toEqual([['skelet › dele › #1 › nr','1',true],['skelet › dele › #1 › note','Tooth',true]])
})

it('lights a value\'s correction Evidence with the value and with each of its parts, never another value\'s',()=> {
  const part=partKey('v1',['records',0,'skelet','art'])
  expect([ownsMark('v1','v1#correction'),ownsMark(part,'v1#correction'),ownsMark(part,'v1'),ownsMark(partKey('v10',[]),'v1#correction')])
    .toEqual([true,true,false,false])
})
