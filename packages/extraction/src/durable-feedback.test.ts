import assert from 'node:assert/strict'
import { test } from 'node:test'
import { correctionValueFits, fieldMeaning, legacyValueId, selectFeedback } from './durable-feedback.js'
import type { SchemaNode } from './schema.js'

const text: SchemaNode = { id:'field-1', name:'title', type:'string', description:'A work title' }
test('compatibility preserves renames and excludes changed meaning or type for each target', () => {
  const candidate = {id:'c1',fieldId:text.id,meaning:fieldMeaning(text),value:'A corrected title',sourceContext:'Own source',grounded:false}
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
test('oversize examples are omitted whole with a reason and stable legacy identities bind to the artifact', () => {
  const candidate = {id:'c1',fieldId:text.id,meaning:fieldMeaning(text),value:'Long text',sourceContext:'Own source',grounded:false}
  assert.deepEqual(selectFeedback({nodes:[text],candidates:[candidate],fits:()=>false}),{examples:[],omissions:[{id:'c1',reason:'budget'}]})
  assert.equal(legacyValueId('e','digest',['records',0,'title']),legacyValueId('e','digest',['records',0,'title']))
  assert.notEqual(legacyValueId('e','digest',['records',0,'title']),legacyValueId('e','another',['records',0,'title']))
})
