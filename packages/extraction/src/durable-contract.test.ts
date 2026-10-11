import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { durableValueSchema } from './durable-contract.js'

test('retained model Evidence preserves leaf attribution and rejects a different value or anchor',()=> {
  const producer={path:['records',0,'work','title'],segment:'p1_s1',page:1,bbox_pt:null,verbatim:true,hits:1,
    linked_by:'key',spans:[{segment:'p1_s1',start:7,end:11}],alternatives:[],provenance:'token',key_spans:[{segment:'p1_s1',start:0,end:5}],
    heading:null,precision:'segment',raw:'Book',normalized:null}
  const value={id:'work-value',recordId:'own-source-record',fieldId:'work',path:['records',0,'work'],
    selectionId:randomUUID(),schemaRevisionId:randomUUID(),node:{id:'work',name:'work',type:'object',children:[{id:'title',name:'title',type:'string'}]},
    modelValue:{title:'Book'},evidence:[{anchorId:'a_p1_s1',occurrenceIds:[],producer}],grounding:'ungrounded',processing:'saved',lineage:[]}
  const saved=durableValueSchema.parse(value)
  assert.deepEqual(saved.evidence[0].producer,producer)
  assert.equal(durableValueSchema.safeParse({...value,evidence:[{...value.evidence[0],anchorId:'a_p2_s1'}]}).success,false)
  assert.equal(durableValueSchema.safeParse({...value,evidence:[{...value.evidence[0],producer:{...producer,path:['records',1,'work','title']}}]}).success,false)
  assert.equal(durableValueSchema.safeParse({...value,evidence:[{anchorId:'a_p1_s1',occurrenceIds:[]}]}).success,false)
})

test('Python version-3 producer Evidence satisfies the durable producer contract', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../apps/parsing_service/tests/fixtures/contracts/extract.result.v3.json', import.meta.url), 'utf8'))
  assert.ok(fixture.artifact.evidence.length > 0)
  for (const link of fixture.artifact.evidence) {
    const producer = durableValueSchema.shape.evidence.element.shape.producer.parse(link)
    assert.deepEqual(producer.path, link.path)
    assert.equal(producer.segment, link.segment)
  }
})

test('Value Disagreements retain typed alternatives at null places addressed by child id',()=> {
  const origins=[{selectionId:'11111111-1111-4111-8111-111111111111',generation:'1',primary:[{segment:'p3_s0',start:0,end:12}],overlap:[]}]
  const entry={path:['title-id'],alternatives:[{id:'a'.repeat(64),value:'Observed article',origins},{id:'c'.repeat(64),value:'Cited title',origins}]}
  const value={id:'work-value',recordId:'record',fieldId:'work',path:['records',0,'work'],
    selectionId:origins[0].selectionId,schemaRevisionId:'22222222-2222-4222-8222-222222222222',
    node:{id:'work',name:'work',type:'object',children:[{id:'title-id',name:'title',type:'string'},{id:'year-id',name:'year',type:'integer'}]},
    modelValue:{title:null,year:1827},evidence:[],grounding:'ungrounded',processing:'saved',lineage:[],disagreement:[entry]}
  assert.deepEqual(durableValueSchema.parse(value),value)
  for(const invalid of [
    {...value,processing:'absent'}, {...value,disagreement:[]}, {...value,disagreement:null},
    {...value,modelValue:{title:'A',year:1827}}, {...value,disagreement:[entry,entry]},
    {...value,disagreement:[{...entry,path:['title']}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0]]}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0],entry.alternatives[0]]}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0],{...entry.alternatives[1],value:null}]}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0],{...entry.alternatives[1],verdict:'supported'}]}]},
    {...value,node:{...value.node,type:'array'},modelValue:[{title:null,year:1827}]},
  ]) assert.equal(durableValueSchema.safeParse(invalid).success,false,JSON.stringify(invalid))
})

test('alternative choices are optional and only allowed on approvals', async()=> {
  const {durableCorrectionSchema}=await import('./durable-contract.js')
  const plain={expectedRevision:0,snapshotVersion:1,action:'APPROVED',evidence:[],included:true}
  assert.deepEqual(durableCorrectionSchema.parse(plain),plain)
  assert.deepEqual(durableCorrectionSchema.parse({...plain,alternativeIds:['a']}),{...plain,alternativeIds:['a']})
  for(const action of ['EDITED','REJECTED','PENDING'])
    assert.equal(durableCorrectionSchema.safeParse({...plain,action,alternativeIds:['a']}).success,false)
})
