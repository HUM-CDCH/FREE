import { expect, it } from 'vitest'
import type { DurablePage } from 'extraction/durable-types'
import { durableRailModel, durableRailRow, type RetainedValue } from './durableRailModel'

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

it('lists the records discovery found as queued or reading until their values are saved, nearest the start page first',()=> {
  const saved=value({path:['records',2,'flag']})
  const model=durableRailModel({values:[saved]} as DurablePage,null,{records:[{ordinal:0,page:1},{ordinal:1,page:4},{ordinal:2,page:5}],
    reading:new Set([1]),fields:['flag','note'],startPage:5})
  expect(model.records.map(record=>[record.label,record.state])).toEqual([['Record 3','finished'],['Record 2','reading'],['Record 1','queued']])
  expect(model.records[1]!.rows.map(row=>[row.name,row.kind])).toEqual([['flag','reading'],['note','reading']])
  expect(model.records[2]!.rows).toEqual([])
  expect(model.counts).toMatchObject({toCheck:1,required:1,notReviewable:0})
})
