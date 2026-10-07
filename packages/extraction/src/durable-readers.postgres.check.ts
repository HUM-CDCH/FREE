import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client, Pool } from 'pg'
import { createDisposableRuntime } from 'db/postgres-test-helpers'
import { migrate, provisionDatabase, seedPreMigrationHistory, ARTICLE_TREE } from '../../db/src/record-scope-history-fixture.js'

/** Readers show durable Extractions only, to their owner only; fresh admission creates native coordination. */
test('durable readers ignore head-less rows, conceal another researcher\'s Extraction, and admit fresh durable single and batch work', async t => {
  const base = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const target = await provisionDatabase(base, `free_test_durable_readers_${randomBytes(5).toString('hex')}`)
  const admin = new Client({ connectionString: target.url }), source = new Pool({ connectionString: target.url, max: 4 })
  const previousUrl = process.env.DATABASE_URL
  let closeDomainPool: (() => Promise<void>) | undefined
  t.after(async () => {
    await closeDomainPool?.(); await source.end(); await admin.end(); await target.drop()
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  })
  await migrate(target.url); await admin.connect()
  process.env.DATABASE_URL = target.url
  const { db, pool } = await import('db')
  closeDomainPool = async () => { await db.close(); await pool.end() }
  const { createDurableRepository, initializeDurableExtraction, DURABLE_RECONCILE } = await import('./durable-repository.js')
  const { createResearcherExtractionPersistence } = await import('./postgres-persistence.js')
  // Public Extraction rows from before durable execution: published, reviewed and batch members, none with a head.
  const history = await seedPreMigrationHistory(admin)
  await admin.query('CREATE SCHEMA reader_test; CREATE TABLE reader_test.queue (id text PRIMARY KEY, input jsonb NOT NULL)')
  const execution: import('./dependencies.js').ExtractionExecution = {
    enqueue: async (client, workflow, input) => {
      assert.equal(workflow.workflowName, DURABLE_RECONCILE)
      await client.query('INSERT INTO reader_test.queue VALUES ($1,$2)', [workflow.workflowID, JSON.stringify(input)])
    },
    statuses: async () => new Map<string, string>(),
  }
  const owner = createResearcherExtractionPersistence(history.accountId, execution, { database: createDisposableRuntime(source) })
  const d1 = history.documents.d1

  assert.deepEqual(await owner.readDocumentExtractions({ sourceDocumentId: d1.sourceDocumentId }),
    { sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId, latestAttempt: null, latestReviewed: null })
  assert.equal(await owner.readExtractionAttempt(history.extractions.article.reviewed), null)
  assert.equal(await owner.readBatch({ projectContextId: history.projectContextId, batchExtractionId: history.batches.catalog }), null)
  assert.deepEqual(await owner.listBatches(history.projectContextId, 50), [])

  const id = randomUUID()
  const representation = (await admin.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1', [d1.sourceRepresentationRevisionId])).rows[0]
  await admin.query('INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,$4,\'ARTICLE\',$5)',
    [id, d1.sourceDocumentId, d1.sourceRepresentationRevisionId, history.revisions.article, { article: null }])
  await admin.query('BEGIN')
  try {
    await initializeDurableExtraction(admin as never, id, { projectContextId: history.projectContextId, sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId,
      schemaRevisionId: history.revisions.article, schemaTree: ARTICLE_TREE, strategy: 'ARTICLE', catalogRecipe: null, preprocessId: representation.preprocessId,
      requestedModels: null, requestedSettings: { article: null } })
    await admin.query('COMMIT')
  } catch (error) { await admin.query('ROLLBACK'); throw error }
  const listed = await owner.readDocumentExtractions({ sourceDocumentId: d1.sourceDocumentId })
  assert.equal(listed?.latestAttempt?.extractionId, id)
  assert.equal(listed?.latestAttempt?.executionStatus, 'QUEUED')
  assert.equal(listed?.latestReviewed, null)
  assert.equal((await owner.readExtractionAttempt(id))?.finalizedReview, null)

  const stranger = randomUUID()
  await admin.query('INSERT INTO public."researcherAccount" (id,"tenantId","objectId","displayName","updatedAt") VALUES ($1,$2,$3,\'Stranger\',now())',
    [stranger, randomUUID(), randomUUID()])
  const other = createResearcherExtractionPersistence(stranger, execution, { database: createDisposableRuntime(source) })
  assert.equal(await other.readExtractionAttempt(id), null)
  assert.equal(await other.readDocumentExtractions({ sourceDocumentId: d1.sourceDocumentId }), null)
  assert.equal(await other.readBatch({ projectContextId: history.projectContextId, batchExtractionId: history.batches.catalog }), null)

  const rows = async () => (await admin.query('SELECT count(*)::int AS n FROM public.extraction')).rows[0].n as number
  const heads = async () => (await admin.query('SELECT count(*)::int AS n FROM extraction_runtime.head')).rows[0].n as number
  const before = { rows: await rows(), heads: await heads() }
  await admin.query('UPDATE public."schemaRevision" SET "recordScope"=$2 WHERE id=$1', [history.revisions.article, 'document'])
  const method = { models: null, settings: { article: null } }
  const admitted = await owner.scheduleExtraction({ kind: 'fresh', extractionId: randomUUID(), sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId,
    schemaRevisionId: history.revisions.article, strategy: 'ARTICLE', method })
  assert.equal(admitted?.disposition, 'created')
  assert.equal(admitted?.extraction.executionStatus, 'QUEUED')
  const batch = await owner.scheduleBatch({ projectContextId: history.projectContextId, schemaRevisionId: history.revisions.article, strategy: 'ARTICLE',
    method, sourceDocumentIds: [d1.sourceDocumentId], repetition: 'create-new' })
  assert.equal(batch?.disposition, 'created')
  assert.equal(batch?.batch.members.length, 1)
  assert.equal(batch?.batch.members[0].executionStatus, 'QUEUED')
  assert.equal(batch?.batch.members[0].completed, false)
  assert.deepEqual({ rows: await rows(), heads: await heads() }, { rows: before.rows + 2, heads: before.heads + 2 })
  const queued = (await admin.query('SELECT id FROM reader_test.queue ORDER BY id')).rows.map(row => row.id)
  assert.deepEqual(queued, [admitted!.extraction.extractionId, batch!.batch.members[0].extractionId].map(id => `durable-dispatch:${id}`).sort())

  // Three heads share two current-cut versions. A malformed historical payload must never be loaded by a summary,
  // and the latest named finalization remains independent of a finalization of the current cut.
  const {readRuntimeHeads,readDurableSummaries}=await import('./postgres-attempts.js')
  const nativeIds=[id,admitted!.extraction.extractionId,batch!.batch.members[0].extractionId]
  const runtime=createDisposableRuntime(source)
  let nativeHeads=await readRuntimeHeads(runtime.orm,nativeIds)
  for(let index=0;index<nativeIds.length;index++) {
    const extractionId=nativeIds[index],head=nativeHeads.get(extractionId)!,version=index===2?1:2
    const node=ARTICLE_TREE.schemaNodes[0]
    const value={id:'value',recordId:'record',fieldId:node.id,path:['records',0,node.name],selectionId:head.selectionId,
      schemaRevisionId:history.revisions.article,node,modelValue:'Saved value',evidence:[],grounding:'ungrounded',processing:'saved',lineage:[]}
    const values=index===1?[value,{...value,id:'second-value',schemaRevisionId:history.revisions.catalog}]:[value]
    if(index===0) await admin.query(`INSERT INTO extraction_runtime.snapshot
      (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,1,$3,$4,$5,'{}')`,
      [randomUUID(),extractionId,head.selectionId,'a'.repeat(64),JSON.stringify([{historical:'not summary metadata'}])])
    await admin.query(`INSERT INTO extraction_runtime.snapshot
      (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,$3,$4,$5,$6,'{}')`,
      [randomUUID(),extractionId,version,head.selectionId,'b'.repeat(64),JSON.stringify(values)])
    await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=$2 WHERE id=$1',[extractionId,version])
    await admin.query(`INSERT INTO extraction_runtime.finalization
      (id,"extractionId","snapshotVersion","feedbackVersion","decisionDigest","createdAt") VALUES ($1,$2,$3,0,$4,$5)`,
      [randomUUID(),extractionId,version,'c'.repeat(64),'2026-10-05T01:00:00Z'])
    if(index===0) await admin.query(`INSERT INTO extraction_runtime.finalization
      (id,"extractionId","snapshotVersion","feedbackVersion","decisionDigest","createdAt") VALUES ($1,$2,1,1,$3,$4)`,
      [randomUUID(),extractionId,'d'.repeat(64),'2026-10-05T02:00:00Z'])
  }
  nativeHeads=await readRuntimeHeads(runtime.orm,nativeIds)
  let checkouts=0
  const acquired=()=>{checkouts++}
  source.on('acquire',acquired)
  let summaries:Awaited<ReturnType<typeof readDurableSummaries>>
  try{summaries=await readDurableSummaries(runtime.orm,nativeHeads)}finally{source.off('acquire',acquired)}
  assert.ok(checkouts<=3,`Current-cut summaries used ${checkouts} pool checkouts for three heads sharing two versions.`)
  assert.equal(summaries.get(id)?.review?.snapshotVersion,2)
  assert.equal(summaries.get(id)?.finalizedReview?.snapshotVersion,1)
  assert.equal(summaries.get(admitted!.extraction.extractionId)?.reviewable,true)
  assert.equal(summaries.get(admitted!.extraction.extractionId)?.review,null)
  // History's list counts each snapshot's values without loading them; the audit's full history still holds them.
  const durable=createDurableRepository(history.accountId,source)
  const versions=await durable.historySummary(id)
  assert.deepEqual(versions.snapshots.map(({version,valueCount})=>({version,valueCount})),[{version:1,valueCount:1},{version:2,valueCount:1}])
  assert.equal(versions.finalizations.length,2)
  assert.equal(Object.hasOwn(versions.snapshots[0],'values'),false)
  assert.deepEqual((await durable.history(id)).snapshots[0].values,[{historical:'not summary metadata'}])
  assert.equal(summaries.get(batch!.batch.members[0].extractionId)?.review?.schemaRevisionId,history.revisions.article)

  // Completion comes from attempt history after Stop changes the visible acknowledgement.
  const memberId=batch!.batch.members[0].extractionId
  await admin.query('UPDATE extraction_runtime.attempt SET outcome=\'COMPLETED\' WHERE id=$1',[nativeHeads.get(memberId)!.attemptId])
  await admin.query('UPDATE extraction_runtime.head SET intent=\'STOP\',acknowledgement=\'STOPPED\' WHERE id=$1',[memberId])
  const stoppedBatch=await owner.readBatch({projectContextId:history.projectContextId,batchExtractionId:batch!.batch.batchExtractionId})
  assert.equal(stoppedBatch?.members[0].executionStatus,'STOPPED')
  assert.equal(stoppedBatch?.members[0].completed,true)
  await runtime.close()
})
