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
  expect(row.retained?.attribution).toContain('producing-schema'.slice(0,8))
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
  expect(row.retained?.source).toBe('Linked by rule; no verifier checked it')
  expect(row.chip?.style).toBe('rule')
})
