import { expect, it } from 'vitest'
import { decodeParsedDocument } from 'extraction/parsed-document'
import rawDocument from './assets/parsed_document.v2.json'
import { provisionalMarks } from './provisionalMarks'
import type { RetainedValue } from './durableRailModel'

const value=(extra:Partial<RetainedValue>={}):RetainedValue=>({id:'value',recordId:'record',fieldId:'title',path:['records',0,'title'],
  node:{id:'title',name:'title',type:'string'},modelValue:'Unique title',links:[],grounding:'provisional',processing:'saved',
  correction:null,...extra} as RetainedValue)
const source=(texts:string[])=>{
  const document=decodeParsedDocument(rawDocument), anchor=document.evidence_index.anchors.find(each=>each.kind==='text')!
  document.tables=[]
  document.content_stream=texts.map((text,index)=>({kind:'text',block_id:`b${index}`,text} as never))
  document.evidence_index.anchors=texts.map((_,index)=>({...anchor,anchor_id:`a${index}`,block_id:`b${index}`} as never))
  return document
}
it('shows an exact unique text match as a display-only preview without changing saved evidence',()=>{
  const saved=value(), before=structuredClone(saved)
  expect(provisionalMarks(source(['Title: Unique title.']),[saved])).toEqual([
    {key:'value',name:'title',value:'Unique title',field:'title',link:{resultPath:['records',0,'title'],evidenceAnchorId:'a0'}},
  ])
  expect(saved).toEqual(before)
})
it('never guesses an absent, repeated, partial-token or paraphrased location',()=>{
  for(const texts of [['Absent'],['Unique title','Unique title'],['Unique title and Unique title'],['Unique titles'],['unique title']])
    expect(provisionalMarks(source(texts),[value()])).toEqual([])
})
it('leaves completed, already linked, edited and missing values alone',()=>{
  for(const change of [{grounding:'ungrounded'},{links:[{resultPath:['records',0,'title'],evidenceAnchorId:'elsewhere'}]},
    {correction:{decision:{action:'EDITED',value:'Unique title'}}},{processing:'absent'}])
    expect(provisionalMarks(source(['Unique title']),[value(change as Partial<RetainedValue>)])).toEqual([])
})
it('previews each unlinked list item separately, keeping an existing citation',()=>{
  const saved=value({node:{id:'title',name:'title',type:'array',itemType:'string'},modelValue:['Unique title','Second title'],
    links:[{resultPath:['records',0,'title',0],evidenceAnchorId:'a0'}]} as Partial<RetainedValue>)
  const marks=provisionalMarks(source(['Unique title','Second title']),[saved])
  expect(marks).toHaveLength(1)
  expect(marks[0]).toMatchObject({key:'value#["records",0,"title",1]',name:'title › #2',value:'Second title',link:{evidenceAnchorId:'a1'}})
})

it('uses a table cell anchor for an unlinked list value',()=>{
  const document=source([])
  document.tables=[{table_id:'table',cells:[{cell_id:'cell',text:'Unique title'}]} as never]
  document.evidence_index.anchors=[{kind:'table_cell',anchor_id:'cell-anchor',logical_table_id:'table',cell_id:'cell'} as never]
  expect(provisionalMarks(document,[value()])[0]?.link.evidenceAnchorId).toBe('cell-anchor')
})
