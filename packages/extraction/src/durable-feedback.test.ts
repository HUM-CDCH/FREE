import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adaptedCorrection, correctionSourceContext, correctionValueFits, fieldMeaning, selectFeedback } from './durable-feedback.js'
import type { SchemaNode } from './schema.js'
import sourceFixture from '../../../prototypes/studio/src/assets/parsed_document.v2.json' with {type:'json'}
import { decodeParsedDocument } from './parsed-document.js'
import { durableValueSchema } from './durable-contract.js'

const text: SchemaNode = { id:'field-1', name:'title', type:'string', description:'A work title' }
const source=decodeParsedDocument(sourceFixture)
const tableSource=structuredClone(source)
const bbox={x0:36,y0:60,x1:100,y1:80}
tableSource.content_stream.push({kind:'table',block_id:'table-block',table_id:'table',page_number:1,parser:'fixture',bbox,markdown_span:null})
tableSource.pages[0].ordered_content.push('table-block')
tableSource.tables.push({table_id:'table',rows:1,cols:1,continuation:'page_local',
  parser_attribution:{content_parser:{parser:'fixture',version:null},structure_parser:{parser:'fixture',version:null},geometry_parser:null},
  spans:[{page_number:1,producer_table_ref:null,page_local_row_start:0,page_local_row_end:0,page_local_col_count:1}],
  cells:[{cell_id:'cell',row:0,column:0,text:'Original table phrase',role:null,rowspan:1,colspan:1,bbox,evidence_anchor_id:'table-anchor'}]})
tableSource.evidence_index.anchors.push({kind:'table_cell',anchor_id:'table-anchor',content_sha256:source.document.content_sha256,
  preprocess_id:source.preprocessing.preprocess_id,logical_table_id:'table',cell_id:'cell',canonical_row:0,canonical_column:0,
  producer_observations:[{occurrence_id:'table-occurrence',page_number:1,producer_ref:null,row_offset:0,column_offset:0,row_span:1,column_span:1,bbox}]})
decodeParsedDocument(tableSource)
const saved=durableValueSchema.parse({id:'v',recordId:'record',fieldId:text.id,path:[text.name],
  selectionId:'11111111-1111-4111-8111-111111111111',schemaRevisionId:'22222222-2222-4222-8222-222222222222',
  node:text,modelValue:'Original interpretation',evidence:[],grounding:'ungrounded',processing:'saved',lineage:[]})
for(const kind of ['text','table_cell'] as const) {
  test(`correction guidance retains canonical ${kind} text and explicit occurrence links`,()=> {
    const document=kind==='table_cell'?tableSource:source
    const anchor=document.evidence_index.anchors.find(each=>each.kind===kind)!
    assert.ok(anchor)
    const links=[{anchorId:anchor.anchor_id,occurrenceIds:[anchor.producer_observations[0].occurrence_id]}]
    const context=correctionSourceContext(document,'Full source',saved,links)
    assert.deepEqual(context.correctionEvidence,links)
    assert.deepEqual(context.modelEvidence,[])
    assert.equal(context.modelGrounding,'ungrounded')
    assert.equal(context.source.scope,'correction-anchors')
    const expected=anchor.kind==='table_cell'?document.tables.find(table=>table.table_id===anchor.logical_table_id)!.cells.find(cell=>cell.cell_id===anchor.cell_id)!.text
      :document.content_stream.find(block=>block.block_id===anchor.block_id)!
    assert.equal(context.source.excerpts?.[0].text,typeof expected==='string'?expected:'text' in expected?expected.text:'')
  })
}
test('an ungrounded correction retains the entire source without manufacturing linked Evidence',()=> {
  const markdown='Source example without a locatable model anchor\n'+'x'.repeat(100000)
  const context=correctionSourceContext(source,markdown,saved,[])
  assert.deepEqual(context.source,{scope:'document',text:markdown})
  assert.deepEqual(context.correctionEvidence,[])
  const candidate={id:'correction',fieldId:text.id,meaning:fieldMeaning(text),node:text,value:'Corrected',sourceContext:JSON.stringify(context),grounded:false}
  assert.deepEqual(selectFeedback({nodes:[text],candidates:[candidate],fits:()=>false}).omissions,[{id:'correction',reason:'budget'}])
  assert.deepEqual(selectFeedback({nodes:[text],candidates:[candidate],fits:()=>true}).examples,[candidate])
})
test('model-anchor context remains separate from optional researcher Evidence',()=> {
  const anchor=source.evidence_index.anchors[0]
  const modelEvidence=[{anchorId:anchor.anchor_id,occurrenceIds:[],producer:{path:['records',0,'title'],segment:'p1_s0',page:1,bbox_pt:[1,2,3,4] as [number,number,number,number],verbatim:true,hits:1,linked_by:'lexical' as const}}]
  const context=correctionSourceContext(source,'Full source',{...saved,evidence:modelEvidence},[])
  assert.equal(context.source.scope,'model-anchors')
  assert.equal(context.source.excerpts?.[0].text,'Unit 7')
  assert.deepEqual(context.modelEvidence,modelEvidence)
  assert.deepEqual(context.correctionEvidence,[])
  assert.equal(context.modelGrounding,'ungrounded')
})
test('compatibility preserves renames and excludes changed meaning or type for each target', () => {
  const candidate = {id:'c1',fieldId:text.id,meaning:fieldMeaning(text),value:'A corrected title',sourceContext:'Own source',grounded:false,node:text}
  const select = (node:SchemaNode) => selectFeedback({nodes:[node],candidates:[candidate],fits:()=>true})
  assert.deepEqual(select({...text,name:'work_title'}).examples,[candidate])
  assert.equal(select({id:text.id,name:text.name,description:text.description,type:'number'}).examples.length,0)
  assert.equal(select({...text,description:'A person name'}).omissions[0].reason,'incompatible')
  assert.deepEqual(select(text).examples,[candidate])
})
test('boolean, array and object corrections use the producing field contract', () => {
  assert.equal(correctionValueFits({id:'b',name:'flag',type:'boolean'},false),true)
  assert.equal(correctionValueFits({id:'b',name:'flag',type:'boolean'},'false'),false)
  assert.equal(correctionValueFits({id:'a',name:'names',type:'array',itemType:'string'},['Ada']),true)
  assert.equal(correctionValueFits({id:'a',name:'names',type:'array',itemType:'string'},[1]),false)
  assert.equal(correctionValueFits({id:'o',name:'work',type:'object',children:[text]},{title:'Book'}),true)
})
test('nested renames and presentation order preserve meaning and adapt typed object corrections by child identity',()=> {
  const original:SchemaNode={id:'list',name:'people',type:'array',children:[text,{id:'flag',name:'included',type:'boolean'}]}
  const renamed:SchemaNode={...original,name:'authors',children:[{id:'flag',name:'selected',type:'boolean'},{...text,name:'work_title'}]}
  assert.equal(fieldMeaning(original),fieldMeaning(renamed))
  assert.deepEqual(adaptedCorrection(original,renamed,[{title:'Book',included:false}]),[{work_title:'Book',selected:false}])
  assert.equal(adaptedCorrection(original,{...renamed,children:[{id:text.id,name:text.name,description:text.description,type:'number'}]},[{title:'Book',included:false}]),undefined)
})
test('oversize examples are omitted whole with a reason', () => {
  const candidate = {id:'c1',fieldId:text.id,meaning:fieldMeaning(text),value:'Long text',sourceContext:'Own source',grounded:false,node:text}
  assert.deepEqual(selectFeedback({nodes:[text],candidates:[candidate],fits:()=>false}),{examples:[],omissions:[{id:'c1',reason:'budget'}]})
})

test('child ordering uses the same UTF-8 order as the Python planner',()=> {
  const node:SchemaNode={id:'person',name:'person',type:'object',children:[{id:'Z',name:'name',type:'string'},{id:'a',name:'age',type:'integer'}]}
  assert.equal(fieldMeaning(node),'f9283904936a43435df32890e041320ea421d6b269ae281ca876ebc11e659626')
})
