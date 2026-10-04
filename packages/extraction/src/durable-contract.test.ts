import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
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
