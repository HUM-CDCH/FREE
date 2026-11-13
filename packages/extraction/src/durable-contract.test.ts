import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { durableValueSchema, plannedRecords } from './durable-contract.js'
import { plainEvidenceLink, unifiedEvidenceLink } from './kei-evidence.js'

test('retained model Evidence preserves leaf attribution and rejects a different value or anchor',()=> {
  const producer={path:['records',0,'work','title'],segment:'p1_s1',page:1,bbox_pt:null,verbatim:true,
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

test('a single-pass unified link keeps its spans as a lexical producer, not a stripped plain link', () => {
  const span = { segment: 'p1_s0', start: 3, end: 7 }
  const link = { path: ['records', 0, 'site'], segment: 'p1_s0', page: 1, bbox_pt: null, verbatim: true,
    linked_by: 'lexical', support: 'literal', spans: [span], alternatives: [], precision: 'segment', raw: 'Site', item: null }
  assert.deepEqual(durableValueSchema.shape.evidence.element.shape.producer.parse(link), link)
})

test('an Article version-1 link keeps its location as a plain producer and projects it outside grounding', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../apps/parsing_service/tests/fixtures/contracts/article-location-link.json', import.meta.url), 'utf8'))
  const producerSchema = durableValueSchema.shape.evidence.element.shape.producer
  const located = producerSchema.parse(fixture.with_location), plain = producerSchema.parse(fixture.without_location)
  assert.deepEqual(located, fixture.with_location)
  assert.deepEqual(plain, fixture.without_location)
  assert.ok(!('support' in located) && !('provenance' in located) && !('support' in plain) && !('provenance' in plain))
  const { spans: [span], raw } = fixture.with_location.location
  assert.equal([...fixture.passage_text].slice(span.start, span.end).join(''), raw)
  const link = plainEvidenceLink(located, 'a_p1_s3')
  assert.deepEqual(link.location, { textSpans: [span], raw })
  assert.ok(!('grounding' in link) && !('linkedBy' in link))
  const { location: _location, ...unlocated } = link
  assert.deepEqual(unlocated, plainEvidenceLink(plain, 'a_p1_s3'))
  // A location is a single valid printing in the link's own segment, or the producer does not parse.
  for (const location of [
    { spans: [{ ...span, segment: 'p1_s4' }], raw }, { spans: [{ ...span, end: span.start }], raw },
    { spans: [{ ...span, start: -1 }], raw }, { spans: [], raw }, { spans: [span, span], raw },
    { spans: [span], raw: '' }, { spans: [span] }, { spans: [{ ...span, page: 1 }], raw }, { spans: [span], raw, boxes: [] },
  ]) assert.equal(producerSchema.safeParse({ ...fixture.with_location, location }).success, false, JSON.stringify(location))
})

test('a producer link keeps the value boxes the Parsing Service writes and projects them as valueBoxes', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../apps/parsing_service/tests/fixtures/contracts/value-mark-link.json', import.meta.url), 'utf8'))
  const producerSchema = durableValueSchema.shape.evidence.element.shape.producer
  for (const name of ['article', 'unified', 'without']) assert.deepEqual(producerSchema.parse(fixture[name]), fixture[name], name)
  const boxes = ([x0, y0, x1, y1]: number[]) => ({ x0, y0, x1, y1 })
  const article = plainEvidenceLink(producerSchema.parse(fixture.article) as Parameters<typeof plainEvidenceLink>[0], 'a_p1_s3')
  assert.deepEqual(article.valueBoxes, fixture.article.value_boxes_pt.map(boxes))
  assert.equal('valueBoxes' in plainEvidenceLink(producerSchema.parse(fixture.without) as Parameters<typeof plainEvidenceLink>[0], 'a_p1_s3'), false)
  assert.deepEqual(unifiedEvidenceLink(producerSchema.parse(fixture.unified) as Parameters<typeof unifiedEvidenceLink>[0], 'a_p2_s5').valueBoxes,
    fixture.unified.value_boxes_pt.map(boxes))
  assert.equal(producerSchema.safeParse({ ...fixture.article, value_boxes_pt: [[1, 1, 1, 2]] }).success, false)
})

test('Value Disagreements retain typed alternatives at null places addressed by child id',()=> {
  const entry={path:['title-id'],alternatives:[{value:'Observed article',segments:['p3_s0']},{value:'Cited title',segments:['p9_s0']}]}
  const value={id:'work-value',recordId:'record',fieldId:'work',path:['records',0,'work'],
    selectionId:'11111111-1111-4111-8111-111111111111',schemaRevisionId:'22222222-2222-4222-8222-222222222222',
    node:{id:'work',name:'work',type:'object',children:[{id:'title-id',name:'title',type:'string'},{id:'year-id',name:'year',type:'integer'}]},
    modelValue:{title:null,year:1827},evidence:[],grounding:'ungrounded',processing:'saved',lineage:[],disagreement:[entry]}
  assert.deepEqual(durableValueSchema.parse(value),value)
  for(const invalid of [
    {...value,processing:'absent'}, {...value,disagreement:[]}, {...value,disagreement:null},
    {...value,modelValue:{title:'A',year:1827}}, {...value,disagreement:[entry,entry]},
    {...value,disagreement:[{...entry,path:['title']}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0]]}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0],{...entry.alternatives[1],segments:[]}]}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0],{...entry.alternatives[1],value:null}]}]},
    {...value,disagreement:[{...entry,alternatives:[entry.alternatives[0],{...entry.alternatives[1],verdict:'supported'}]}]},
    {...value,node:{...value.node,type:'array'},modelValue:[{title:null,year:1827}]},
  ]) assert.equal(durableValueSchema.safeParse(invalid).success,false,JSON.stringify(invalid))
  const years=JSON.parse('[{"value":9007199254740993,"segments":["p1_s0"]},{"value":9007199254740992,"segments":["p3_s0"]}]')
  assert.equal(durableValueSchema.safeParse({...value,modelValue:{title:'A',year:null},disagreement:[{path:['year-id'],alternatives:years}]}).success,true)
})

test('chosen readings are optional and only allowed on approvals', async()=> {
  const {durableCorrectionSchema}=await import('./durable-contract.js')
  const plain={expectedRevision:0,snapshotVersion:1,action:'APPROVED',evidence:[],included:true}
  const choices=[{path:['title-id'],value:'Cited title'}]
  assert.deepEqual(durableCorrectionSchema.parse(plain),plain)
  assert.deepEqual(durableCorrectionSchema.parse({...plain,choices}),{...plain,choices})
  assert.equal(durableCorrectionSchema.safeParse({...plain,choices:[{...choices[0],id:'a'}]}).success,false)
  for(const action of ['EDITED','REJECTED','PENDING'])
    assert.equal(durableCorrectionSchema.safeParse({...plain,action,choices}).success,false)
})

test('a planned record keeps the text it owns, its disjoint lines stay disjoint',()=> {
  const line=(segment:string,start:number,end:number)=>({segment,start,end})
  const records=plannedRecords([
    // A parent whose child was carved out of the same block keeps the hole; its next block is a separate range.
    {ordinal:0,scope:[line('p1_s0',0,10),line('p1_s0',11,20),line('p1_s0',41,50),line('p1_s1',0,8)]},
    {ordinal:1,scope:[line('p1_s0',21,30),line('p1_s0',31,40)]},
    // Unowned text remains excluded.
    {ordinal:2,scope:[line('p2_s0',0,5),line('p2_s0',30,35)]},
  ])
  assert.deepEqual(records,[
    {ordinal:0,segment:'p1_s0',page:1,ranges:[line('p1_s0',0,10),line('p1_s0',11,20),line('p1_s0',41,50),line('p1_s1',0,8)]},
    {ordinal:1,segment:'p1_s0',page:1,ranges:[line('p1_s0',21,30),line('p1_s0',31,40)]},
    {ordinal:2,segment:'p2_s0',page:2,ranges:[line('p2_s0',0,5),line('p2_s0',30,35)]},
  ])
})

test('a planned record whose scope is not its exact lines keeps its start alone',()=> {
  assert.deepEqual(plannedRecords([
    {ordinal:0,scope:[{segment:'p3_s9'}]},
    {ordinal:1,scope:[{segment:'p4_s0',start:0,end:4},{segment:'p4_s1',start:'0',end:4}]},
    {ordinal:2,scope:[{segment:'p5_s0',start:4,end:4}]},
    {ordinal:3,scope:{pages:[1,2]}},
    {ordinal:4,scope:[]},
  ]),[
    {ordinal:0,segment:'p3_s9',page:3},{ordinal:1,segment:'p4_s0',page:4},{ordinal:2,segment:'p5_s0',page:5},
    {ordinal:3,segment:null,page:null},{ordinal:4,segment:null,page:null},
  ])
})


test('record ranges exclude shared notes and keep a multi-page child in scope order', () => {
  const line = (segment: string, start: number, end: number) => ({ segment, start, end })
  const scopes = [
    [line('p1_s0', 0, 18), line('p1_s0', 56, 78), line('p3_s0', 20, 40)],
    [line('p2_s0', 0, 20), line('p3_s0', 0, 20)],
  ]
  assert.deepEqual(plannedRecords(scopes.map((scope, ordinal) => ({ scope, ordinal }))).map(record => record.ranges), scopes)
})
