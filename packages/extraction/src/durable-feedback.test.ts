import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelDigest, disagreementDigest, resolvedValue, decidedAlternatives, decidedCandidate, correctionFit, settled, adaptedCorrection, correctionSourceContext, correctionValueFits, fieldMeaning, selectFeedback } from './durable-feedback.js'
import type { SchemaNode } from './schema.js'
import sourceFixture from '../../../apps/studio/src/assets/parsed_document.v2.json' with {type:'json'}
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

const origins=[{selectionId:saved.selectionId,generation:'1',primary:[{segment:'p3_s0',start:0,end:12}],overlap:[]}]
const alternative=(value:string,id:string)=>({id:id.repeat(64),value,origins})
const disputed=durableValueSchema.parse({...saved,modelValue:null,disagreement:[{path:[],alternatives:[alternative('A','a'),alternative('C','c')]}]})
const decision=(value:typeof saved,action:'APPROVED'|'EDITED'|'REJECTED'|'PENDING',ids?:string[],edit?:unknown)=> {
  const input={action,alternativeIds:ids,value:edit}
  const candidate=decidedCandidate(value,input,{sourceRevisionId:'source',recordId:value.recordId})
  assert.ok(candidate)
  return {candidate,decision:input}
}
test('a disagreement requires exactly one named alternative per place, never a plain approval',()=> {
  assert.equal(decidedCandidate(disputed,{action:'APPROVED'},{}),undefined)
  assert.equal(resolvedValue(disputed,[]),undefined)
  assert.equal(resolvedValue(disputed,['unknown']),undefined)
  assert.equal(resolvedValue(disputed,['a'.repeat(64),'c'.repeat(64)]),undefined)
  const choice=decision(disputed,'APPROVED',['c'.repeat(64)])
  assert.equal(resolvedValue(disputed,decidedAlternatives(choice,disputed)!),'C')
  assert.equal(correctionFit(choice,disputed),'compatible')
  assert.equal(settled(choice,disputed),true)
  assert.equal(JSON.parse(choice.candidate.sourceContext).modelValue,'C')
  assert.deepEqual(JSON.parse(choice.candidate.sourceContext).disagreement,[{path:[],values:['A','C']}])
})
test('a new reading keeps a chosen decision shown but requires Keep before finalizing the newer cut',()=> {
  const choice=decision(disputed,'APPROVED',['a'.repeat(64)])
  const newer={...disputed,disagreement:[{path:[],alternatives:[...disputed.disagreement![0].alternatives,alternative('D','d')]}]}
  assert.equal(correctionFit(choice,newer),'new-reading')
  assert.deepEqual(decidedAlternatives(choice,newer),['a'.repeat(64)])
  assert.equal(settled(choice,newer),false)
  assert.equal(settled(choice,disputed),true)
  assert.equal(settled(decision(newer,'APPROVED',['a'.repeat(64)]),newer),true)
})
test('approval and rejection before a disagreement apply to the earlier reading and need coverage',()=> {
  for(const action of ['APPROVED','REJECTED'] as const) {
    const earlier=decision({...saved,modelValue:'A'},action)
    assert.equal(correctionFit(earlier,disputed),'new-reading')
    assert.deepEqual(decidedAlternatives(earlier,disputed),['a'.repeat(64)])
    assert.equal(correctionFit(decision({...saved,modelValue:null},action),disputed),action==='REJECTED'?'new-reading':'incompatible')
  }
})
test('an edited value stays shown after new readings, while new origins and Evidence do not need review',()=> {
  const edit=decision(disputed,'EDITED',undefined,'Researcher title')
  const newer={...disputed,disagreement:[{path:[],alternatives:[...disputed.disagreement![0].alternatives,alternative('D','d')]}]}
  assert.equal(correctionFit(edit,newer),'new-reading')
  assert.equal(settled(decision(newer,'EDITED',undefined,'Researcher title'),newer),true)
  const relinked={...disputed,grounding:'provisional' as const,disagreement:disputed.disagreement!.map(entry=>({...entry,alternatives:entry.alternatives.map(a=>({...a,origins:[...a.origins,{...origins[0],primary:[{segment:'p9_s0',start:0,end:20}]}]}))}))}
  assert.equal(disagreementDigest(relinked),disagreementDigest(disputed))
  assert.equal(settled(edit,relinked),true)
})
test('a choice made before a second part disagrees projects alternatives for every part',()=> {
  const node:SchemaNode={id:'work',name:'work',type:'object',children:[{id:'t',name:'title',type:'string'},{id:'y',name:'year',type:'integer'}]}
  const first={...saved,node,modelValue:{title:null,year:1827},disagreement:[{path:['t'],alternatives:disputed.disagreement![0].alternatives}]}
  const choice=decision(first,'APPROVED',['a'.repeat(64)])
  const later={...first,modelValue:{title:null,year:null},disagreement:[...first.disagreement,{path:['y'],alternatives:[{...alternative('','b'),value:1827},{...alternative('','d'),value:1828}]}]}
  assert.equal(correctionFit(choice,later),'new-reading')
  assert.deepEqual(decidedAlternatives(choice,later),['a'.repeat(64),'b'.repeat(64)])
  assert.deepEqual(resolvedValue(later,decidedAlternatives(choice,later)!),{title:'A',year:1827})
})
test('PENDING never needs Keep and adoption that grows a disagreement invalidates a choice but retains an edit',()=> {
  const pending=decision(disputed,'PENDING')
  const adopted={...disputed,selectionId:'33333333-3333-4333-8333-333333333333'}
  assert.equal(correctionFit(pending,disputed),'compatible')
  assert.equal(settled(pending,disputed),false)
  assert.equal(correctionFit(pending,adopted),'incompatible')
  assert.equal(correctionFit(decision(disputed,'APPROVED',['a'.repeat(64)]),adopted),'incompatible')
  assert.equal(correctionFit(decision(disputed,'REJECTED'),adopted),'incompatible')
  assert.equal(correctionFit(decision(disputed,'EDITED',undefined,'Edit'),adopted),'compatible')
})

test('plain values retain the original model digest and sourceContext bytes without optional keys',()=> {
  assert.equal(modelDigest(saved),'a5595d6633f64f2f08efa0c946b3ec6f94e9a9e5f28958669582fce245c21113')
  const candidate=decidedCandidate(saved,{action:'APPROVED'},{recordId:'record',sourceRevisionId:'source'})!
  assert.equal(candidate.modelDigest,modelDigest(saved))
  assert.equal(candidate.sourceContext,'{"modelValue":"Original interpretation","recordId":"record","sourceRevisionId":"source"}')
  assert.equal(Object.hasOwn(candidate,'disagreementDigest'),false)
  assert.equal(settled(decision(saved,'APPROVED'),saved),true)
  assert.equal(settled(decision(saved,'REJECTED'),saved),true)
  assert.equal(settled(decision(saved,'PENDING'),saved),false)
})
