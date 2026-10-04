import assert from 'node:assert/strict'
import { randomBytes,randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client,Pool } from 'pg'
import { createDisposableRuntime } from 'db/postgres-test-helpers'
import { migrate,provisionDatabase,seedPreMigrationHistory,ARTICLE_TREE } from '../../db/src/record-scope-history-fixture.js'
import { createGarbageReferences } from '../../db/src/garbage-references.js'
import { createDurableRepository,initializeDurableExtraction,DurableConflict,DurableNotFound,collectDeletedDurableGraphs,reconcileDurableAttempts } from './durable-repository.js'
import { createResearcherExtractionPersistence } from './postgres-persistence.js'

test('durable controls, concurrent corrections, fixed pages and deletion retain one owned Extraction',async t=> {
  const base=process.env.EXTRACTION_TEST_DATABASE_URL
  if(!base)throw new Error('Set EXTRACTION_TEST_DATABASE_URL to an explicit disposable free_test_* target.')
  const target=await provisionDatabase(base,`free_test_durable_controls_${randomBytes(5).toString('hex')}`)
  const admin=new Client({connectionString:target.url}),source=new Pool({connectionString:target.url,max:4})
  t.after(async()=>{await source.end();await admin.end();await target.drop()})
  await migrate(target.url);await admin.connect()
  const fixture=await seedPreMigrationHistory(admin),document=fixture.documents.d1
  const representation=(await admin.query('SELECT * FROM public."sourceRepresentationRevision" WHERE id=$1',[document.sourceRepresentationRevisionId])).rows[0]
  const id=randomUUID()
  await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,$4,'ARTICLE',$5)`,[id,document.sourceDocumentId,document.sourceRepresentationRevisionId,fixture.revisions.article,{article:null}])
  const client=await source.connect()
  try {await client.query('BEGIN');await initializeDurableExtraction(client,id,{projectContextId:fixture.projectContextId,sourceRepresentationRevisionId:document.sourceRepresentationRevisionId,schemaRevisionId:fixture.revisions.article,schemaTree:ARTICLE_TREE,strategy:'ARTICLE',catalogRecipe:null,preprocessId:representation.preprocessId,requestedModels:null,requestedSettings:{article:null}});await client.query('COMMIT')}finally{client.release()}
  const repository=createDurableRepository(fixture.accountId,source)
  await assert.rejects(createDurableRepository(randomUUID(),source).read(id),DurableNotFound)
  await assert.rejects(repository.read(fixture.extractions.article.failed),DurableNotFound)
  let state=await repository.read(id),head=(await admin.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
  const pause={id:randomUUID(),expectedVersion:state.controlVersion,action:'pause'}
  assert.deepEqual(await repository.command(id,pause),await repository.command(id,pause))
  await assert.rejects(repository.command(id,{...pause,action:'stop'}),DurableConflict)
  await assert.rejects(repository.command(id,{id:randomUUID(),expectedVersion:0,action:'resume'}),DurableConflict)
  state=await repository.read(id)
  await repository.command(id,{id:randomUUID(),expectedVersion:state.controlVersion,action:'resume'})
  assert.equal((await repository.read(id)).pendingResume,true)
  state=await repository.read(id)
  await repository.command(id,{id:randomUUID(),expectedVersion:state.controlVersion,action:'editing'})
  assert.equal((await repository.read(id)).pendingResume,false)
  const claim=(await admin.query('SELECT extraction_runtime.claim($1,$2,$3) AS v',[id,head.attemptId,randomUUID()])).rows[0].v
  await admin.query('SELECT extraction_runtime.acknowledge($1,$2,$3,false,NULL)',[id,head.attemptId,claim.epoch])
  const node=ARTICLE_TREE.schemaNodes[0]
  const values=Array.from({length:503},(_,index)=>({id:`v${index}`,recordId:`record${index}`,fieldId:node.id,path:['records',index,node.name],selectionId:head.selectionId,schemaRevisionId:fixture.revisions.article,node,modelValue:`title ${index}`,evidence:[],grounding:'ungrounded',processing:'saved',lineage:[]}))
  await admin.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,1,$3,$4,$5,'{}')`,[randomUUID(),id,head.selectionId,'a'.repeat(64),JSON.stringify(values)])
  await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=1 WHERE id=$1',[id])
  const correction={expectedRevision:0,snapshotVersion:1,action:'EDITED',value:'corrected ungrounded',included:true,evidence:[]}
  const raced=await Promise.allSettled([repository.saveCorrection(id,'v0',correction,async()=>{}),repository.saveCorrection(id,'v0',{...correction,value:'another correction'},async()=>{})])
  assert.equal(raced.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(raced.filter(r=>r.status==='rejected'&&r.reason instanceof DurableConflict).length,1)
  const first=await repository.page(id,{limit:500})
  assert.equal(first.total,503);assert.equal(first.values[0].correction.revision,1)
  await repository.saveCorrection(id,'v0',{...correction,expectedRevision:1,value:'later correction'},async()=>{})
  await admin.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,2,$3,$4,$5,'{}')`,[randomUUID(),id,head.selectionId,'b'.repeat(64),JSON.stringify([...values,{...values[0],id:'v503',recordId:'extra'}])])
  await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=2 WHERE id=$1',[id])
  const last=await repository.page(id,first.next!)
  assert.equal(last.snapshotVersion,1);assert.equal(last.feedbackVersion,1);assert.equal(last.values.length,3)
  assert.deepEqual([...first.values,...last.values].map(v=>v.id),values.map(v=>v.id))
  assert.equal((await repository.page(id,{snapshotVersion:1,feedbackVersion:1})).values[0].correction.revision,1)
  await assert.rejects(repository.finalize(id,{snapshotVersion:1,feedbackVersion:2}),/Review each saved value/)
  const numeric=randomUUID(),tree={...ARTICLE_TREE,schemaNodes:[{...node,type:'number'}]}
  await admin.query(`INSERT INTO public."schemaRevision" (id,"extractionSchemaId","revisionNumber",origin,"schemaTree","recordScope") SELECT $1,"extractionSchemaId",2,'RESEARCHER_EDIT',$2,'document' FROM public."schemaRevision" WHERE id=$3`,[numeric,tree,fixture.revisions.article])
  state=await repository.read(id)
  const pending=await repository.saveSelection(id,{expectedVersion:state.controlVersion,schemaRevisionId:numeric,method:{models:null,settings:{article:null}}})
  assert.equal((await repository.feedback(fixture.projectContextId,id,pending.selectionId))[0].targetCompatibility,'incompatible')
  assert.equal((await repository.feedback(fixture.projectContextId,id,pending.selectionId))[0].sourceDocumentId,document.sourceDocumentId)
  assert.equal((await repository.feedback(fixture.projectContextId,id,head.selectionId))[0].targetCompatibility,'compatible')
  await assert.rejects(repository.feedback(fixture.projectContextId,id,randomUUID()),DurableNotFound)
  await assert.rejects(createDurableRepository(randomUUID(),source).feedback(fixture.projectContextId,id,pending.selectionId),DurableNotFound)
  await repository.adoptSelection(id,{expectedVersion:pending.controlVersion,selectionId:pending.selectionId,reprocessValueIds:[]})
  const preserved=await repository.page(id)
  assert.equal(preserved.values[0].modelValue,'title 0')
  assert.equal(preserved.values[0].selectionId,head.selectionId)
  assert.equal(preserved.values[0].correction.revision,2)
  assert.equal(preserved.values[0].historicalCorrection,null)
  assert.equal((await repository.feedback(fixture.projectContextId,id))[0].targetCompatibility,'incompatible')
  const producing=(await repository.read(id)).selection
  const numericValue={...values[0],selectionId:producing.id,schemaRevisionId:numeric,node:tree.schemaNodes[0],modelValue:42}
  await admin.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,3,$3,$4,$5,'{}')`,[randomUUID(),id,producing.id,'c'.repeat(64),JSON.stringify([numericValue])])
  await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=3 WHERE id=$1',[id])
  await repository.saveCorrection(id,'v0',{...correction,expectedRevision:2,snapshotVersion:3,value:43},async()=>{})
  const oldText=await repository.page(id,{snapshotVersion:1})
  assert.equal(oldText.values[0].modelValue,'title 0');assert.equal(oldText.values[0].correction,null)
  assert.equal(oldText.values[0].historicalCorrection.decision.value,43)
  assert.equal((await repository.page(id,{snapshotVersion:1,feedbackVersion:2})).values[0].correction.decision.value,'later correction')
  await repository.saveCorrection(id,'v0',{...correction,expectedRevision:3,snapshotVersion:3,action:'APPROVED'},async()=>{})
  await repository.finalize(id,{snapshotVersion:3,feedbackVersion:4})
  const finalized=await repository.page(id,{snapshotVersion:3,feedbackVersion:4})
  assert.equal(finalized.finalization?.snapshotVersion,3)
  assert.equal(finalized.finalization?.feedbackVersion,4)
  await admin.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,4,$3,$4,$5,'{}')`,[randomUUID(),id,producing.id,'d'.repeat(64),JSON.stringify([{...numericValue,modelValue:44}])])
  await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=4 WHERE id=$1',[id])
  assert.equal((await repository.page(id)).values[0].correction,null)
  assert.equal((await repository.page(id)).finalization,null)
  assert.deepEqual((await repository.page(id,{snapshotVersion:3,feedbackVersion:4})).finalization,finalized.finalization)
  await assert.rejects(repository.finalize(id,{snapshotVersion:4,feedbackVersion:4}),/Review each saved value/)
  const runtime=createDisposableRuntime(source),references=createGarbageReferences(runtime)
  const extractionPersistence=createResearcherExtractionPersistence(fixture.accountId,{
    enqueue:async()=>{throw new Error('Unexpected extraction admission')},statuses:async()=>new Map(),
    cancel:async()=>{throw new Error('A durable native call must drain')},
  },{database:runtime})
  assert.equal((await extractionPersistence.readExtractionAttempt(id))?.executionStatus,'PAUSED')
  assert.equal((await extractionPersistence.readExtractionAttempt(id))?.finalizedReview?.snapshotVersion,3)
  assert.equal((await extractionPersistence.readDocumentExtractions({sourceDocumentId:document.sourceDocumentId}))?.latestReviewed?.extractionId,id)
  assert.equal(await extractionPersistence.cancelExtraction(id),'not-found')
  assert.equal((await admin.query('SELECT outcome FROM public.extraction WHERE id=$1',[id])).rows[0].outcome,null)
  state=await repository.read(id)
  await repository.command(id,{id:randomUUID(),expectedVersion:state.controlVersion,action:'resume'})
  const dispatched:string[]=[]
  await reconcileDurableAttempts(async attempt=>{dispatched.push(attempt.workflowId)},source)
  await reconcileDurableAttempts(async attempt=>{dispatched.push(attempt.workflowId)},source)
  assert.equal(dispatched.length,1)
  await reconcileDurableAttempts(async()=>{},source,async ids=>new Map(ids.map(id=>[id,'ERROR'])))
  assert.equal((await repository.read(id)).status,'FAILED')
  // A completed result survives terminal acknowledgement failure. A proof
  // from an earlier attempt cannot complete a linked replacement.
  state=await repository.read(id)
  await repository.command(id,{id:randomUUID(),expectedVersion:state.controlVersion,action:'retry'})
  head=(await admin.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
  const proof={attemptId:head.attemptId,generation:head.generation,selectionId:head.selectionId,complete:true}
  await admin.query(`INSERT INTO extraction_runtime.snapshot (id,"extractionId",version,"selectionId",digest,values,coverage)
    SELECT $1,"extractionId",5,"selectionId",$3,values,$4 FROM extraction_runtime.snapshot WHERE "extractionId"=$2 AND version=4`,
    [randomUUID(),id,'e'.repeat(64),{finalizedAttempt:{...proof,attemptId:randomUUID()}}])
  await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=5 WHERE id=$1',[id])
  await reconcileDurableAttempts(async()=>{},source,async ids=>new Map(ids.map(id=>[id,'ERROR'])))
  assert.equal((await repository.read(id)).status,'FAILED')
  state=await repository.read(id)
  await repository.command(id,{id:randomUUID(),expectedVersion:state.controlVersion,action:'retry'})
  head=(await admin.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
  const finalClaim=(await admin.query('SELECT extraction_runtime.claim($1,$2,$3) AS v',[id,head.attemptId,randomUUID()])).rows[0].v
  const finalCoverage={finalizedAttempt:{attemptId:head.attemptId,generation:head.generation,selectionId:head.selectionId,complete:true}}
  await assert.rejects(admin.query('SELECT extraction_runtime.publish_snapshot($1,$2,$3,$4,$5,$6,$7)',
    [id,head.attemptId,finalClaim.epoch,randomUUID(),head.selectionId,JSON.stringify([]),{finalizedAttempt:{...proof,attemptId:randomUUID()}}]))
  await admin.query('SELECT extraction_runtime.publish_snapshot($1,$2,$3,$4,$5,$6,$7)',
    [id,head.attemptId,finalClaim.epoch,randomUUID(),head.selectionId,JSON.stringify([]),finalCoverage])
  await repository.command(id,{id:randomUUID(),expectedVersion:(await repository.read(id)).controlVersion,action:'pause'})
  await admin.query('UPDATE extraction_runtime.head SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',[id])
  await reconcileDurableAttempts(async()=>{},source,async ids=>new Map(ids.map(id=>[id,'ERROR'])))
  assert.equal((await repository.read(id)).status,'COMPLETED')
  state=await repository.read(id)
  const afterCompletion=await repository.saveSelection(id,{expectedVersion:state.controlVersion,schemaRevisionId:numeric,method:{models:null,settings:{article:null}}})
  await repository.adoptSelection(id,{expectedVersion:afterCompletion.controlVersion,selectionId:afterCompletion.selectionId,reprocessValueIds:[]})
  await repository.command(id,{id:randomUUID(),expectedVersion:(await repository.read(id)).controlVersion,action:'resume'})
  head=(await admin.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
  const stoppedClaim=(await admin.query('SELECT extraction_runtime.claim($1,$2,$3) AS v',[id,head.attemptId,randomUUID()])).rows[0].v
  await admin.query('SELECT extraction_runtime.publish_snapshot($1,$2,$3,$4,$5,$6,$7)',
    [id,head.attemptId,stoppedClaim.epoch,randomUUID(),head.selectionId,JSON.stringify([]),
      {finalizedAttempt:{attemptId:head.attemptId,generation:head.generation,selectionId:head.selectionId,complete:true}}])
  await admin.query('UPDATE extraction_runtime.head SET "leaseUntil"=clock_timestamp()-interval \'1 second\' WHERE id=$1',[id])
  state=await repository.read(id)
  await repository.command(id,{id:randomUUID(),expectedVersion:state.controlVersion,action:'stop'})
  await reconcileDurableAttempts(async()=>{},source,async ids=>new Map(ids.map(id=>[id,'ERROR'])))
  assert.equal((await repository.read(id)).status,'STOPPED')
  assert.equal((await extractionPersistence.readExtractionAttempt(id))?.executionStatus,'STOPPED')
  await assert.rejects(repository.command(id,{id:randomUUID(),expectedVersion:(await repository.read(id)).controlVersion,action:'resume'}),DurableConflict)
  const ref=representation.artifactReference
  assert.equal(await references.packageIsReferenced(ref),true)
  assert.equal((await admin.query('SELECT extraction_runtime.read_deleted_graph($1,$2) AS graph',[id,head.fence])).rows[0].graph,null)
  await admin.query('DELETE FROM public."sourceDocument" WHERE id=$1',[document.sourceDocumentId])
  head=(await admin.query('SELECT * FROM extraction_runtime.head WHERE id=$1',[id])).rows[0]
  assert.equal(head.deleted,true);assert.equal(head.intent,'STOP')
  assert.equal((await admin.query('SELECT extraction_runtime.read_deleted_graph($1,$2) AS graph',[id,head.fence+1])).rows[0].graph,null)
  const graph=(await admin.query('SELECT extraction_runtime.read_deleted_graph($1,$2) AS graph',[id,head.fence])).rows[0].graph
  assert.ok(graph.attempts.length>=4);assert.deepEqual(graph.captures,[])
  await assert.rejects(admin.query('SELECT extraction_runtime.claim($1,$2,$3)',[id,head.attemptId,randomUUID()]))
  assert.equal(await references.packageIsReferenced(ref),true)
  assert.ok((await references.referencedPreprocessIds()).has(representation.preprocessId))
  const live=async(ids:readonly string[])=>new Map(ids.map(id=>[id,'PENDING']))
  assert.equal(await collectDeletedDurableGraphs(live,source),0)
  assert.equal(await collectDeletedDurableGraphs(async()=>new Map(),source),1)
  assert.equal((await admin.query('SELECT count(*)::int AS n FROM extraction_runtime.correction WHERE "extractionId"=$1',[id])).rows[0].n,0)
  await runtime.close()
})
