import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client } from 'pg'
import { migrate, provisionDatabase } from '../../db/src/record-scope-history-fixture.js'
import { withHeldSourceDocumentLock } from 'db/postgres-test-helpers'
import { accountMethod, REFERENCE_ARTICLE } from './extraction-method.js'
import type { ExtractionExecution } from './dependencies.js'
import type { RunSingleInput, ScheduleBatchInput } from './types.js'

test('admission commits only durable work, replays it, and rolls back a failed enqueue', async t => {
  const base = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const target = await provisionDatabase(base, `free_test_durable_admission_${randomBytes(5).toString('hex')}`)
  const previousUrl = process.env.DATABASE_URL
  const admin = new Client({ connectionString: target.url })
  let closeRuntime: (() => Promise<void>) | undefined
  t.after(async () => {
    await closeRuntime?.(); await admin.end(); await target.drop()
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  })
  await migrate(target.url)
  await admin.connect()
  // Bind the domain pool only after the test has provisioned its own guarded database.
  process.env.DATABASE_URL = target.url
  const { db, pool } = await import('db')
  const { createResearcherExtractionPersistence } = await import('./postgres-persistence.js')
  const { DURABLE_RECONCILE } = await import('./durable-repository.js')
  closeRuntime = async () => { await db.close(); await pool.end() }
  const owner = randomUUID(), projectId = randomUUID(), schemaId = randomUUID(), revisionId = randomUUID()
  await admin.query('INSERT INTO public."researcherAccount" (id,"tenantId","objectId","displayName","updatedAt") VALUES ($1,$2,$3,\'Admission test\',now())', [owner, randomUUID(), randomUUID()])
  await admin.query('INSERT INTO public."projectContext" (id,name,"researcherAccountId") VALUES ($1,\'Admission test\',$2)', [projectId, owner])
  const documents: { id: string; revisionId: string }[] = []
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(), sourceRevisionId = randomUUID(), hash = randomBytes(32).toString('hex')
    await admin.query('INSERT INTO public."sourceDocument" (id,"projectContextId","contentSha256","mediaType","originalName") VALUES ($1,$2,$3,\'application/pdf\',$4)', [id, projectId, hash, `source-${index}.pdf`])
    await admin.query('INSERT INTO public."sourceRepresentationRevision" (id,"sourceDocumentId","revisionNumber","artifactReference","artifactSha256","contractVersion","preprocessId","parserName","parserVersion") VALUES ($1,$2,1,$3,$3,\'parsed_document.v2\',$4,\'fixture\',\'1\')', [sourceRevisionId, id, hash, `kei-exp:admission-${index}:g1`])
    documents.push({ id, revisionId: sourceRevisionId })
  }
  await admin.query('INSERT INTO public."extractionSchema" (id,"projectContextId",name) VALUES ($1,$2,\'Admission test\')', [schemaId, projectId])
  await admin.query('INSERT INTO public."schemaRevision" (id,"extractionSchemaId","revisionNumber",origin,"schemaTree","recordScope") VALUES ($1,$2,1,\'RESEARCHER_EDIT\',$3,\'document\')', [revisionId, schemaId, { recordDescription: 'One document.', schemaNodes: [{ id: 'title', name: 'title', type: 'string' }] }])
  // A transactional queue probe proves the enqueue boundary without calling a model or starting a worker.
  await admin.query('CREATE SCHEMA admission_test; CREATE TABLE admission_test.queue (id text PRIMARY KEY, name text NOT NULL, input jsonb NOT NULL)')
  const execution: ExtractionExecution = {
    enqueue: async (client, workflow, input) => {
      assert.equal(workflow.workflowName, DURABLE_RECONCILE)
      await client.query('INSERT INTO admission_test.queue VALUES ($1,$2,$3)', [workflow.workflowID, workflow.workflowName, JSON.stringify(input)])
    },
    statuses: async () => new Map(),
  }
  const persistence = createResearcherExtractionPersistence(owner, execution, { database: db })
  const method = { models: null, settings: { article: null } }
  const single: RunSingleInput = { kind: 'fresh', extractionId: randomUUID(), sourceRepresentationRevisionId: documents[0].revisionId, schemaRevisionId: revisionId, strategy: 'ARTICLE', method }
  const batch: ScheduleBatchInput = { projectContextId: projectId, schemaRevisionId: revisionId, strategy: 'ARTICLE', method, sourceDocumentIds: documents.map(document => document.id), repetition: 'create-new' }
  const counts = async () => (await admin.query(`SELECT
    (SELECT count(*)::int FROM public.extraction) AS extractions,
    (SELECT count(*)::int FROM public."batchExtraction") AS batches,
    (SELECT count(*)::int FROM extraction_runtime.head) AS heads,
    (SELECT count(*)::int FROM extraction_runtime.dispatch) AS dispatches,
    (SELECT count(*)::int FROM admission_test.queue) AS queued`)).rows[0]
  const admitted = await persistence.scheduleExtraction(single)
  assert.equal(admitted?.disposition, 'created')
  assert.equal(admitted?.extraction.executionStatus, 'QUEUED')
  assert.deepEqual(await counts(), { extractions: 1, batches: 0, heads: 1, dispatches: 1, queued: 1 })
  assert.equal((await persistence.scheduleExtraction(single))?.disposition, 'replayed')
  assert.equal((await counts()).queued, 1)
  const changedArticle={...REFERENCE_ARTICLE,prompt:'schema' as const}
  const changedMethod={models:null,settings:{article:changedArticle}}
  const beforeRefusals=await counts()
  await assert.rejects(persistence.scheduleExtraction({...single,method:changedMethod}),{code:'extraction_id_conflict'})
  await assert.rejects(persistence.scheduleExtraction({...single,extractionId:randomUUID(),method:changedMethod}),{code:'method_changed'})
  await assert.rejects(persistence.scheduleBatch({...batch,method:changedMethod}),{code:'method_changed'})
  assert.deepEqual(await counts(),beforeRefusals)

  const otherProject=randomUUID(),otherSchema=randomUUID(),otherRevision=randomUUID()
  await admin.query('INSERT INTO public."projectContext" (id,name,"researcherAccountId") VALUES ($1,\'Other Project\',$2)',[otherProject,owner])
  await admin.query('INSERT INTO public."extractionSchema" (id,"projectContextId",name) VALUES ($1,$2,\'Other schema\')',[otherSchema,otherProject])
  await admin.query('INSERT INTO public."schemaRevision" (id,"extractionSchemaId","revisionNumber",origin,"schemaTree","recordScope") SELECT $1,$2,1,origin,"schemaTree","recordScope" FROM public."schemaRevision" WHERE id=$3',
    [otherRevision,otherSchema,revisionId])
  assert.equal(await persistence.scheduleExtraction({...single,extractionId:randomUUID(),schemaRevisionId:otherRevision}),null)
  assert.equal(await persistence.scheduleBatch({...batch,schemaRevisionId:otherRevision}),null)
  assert.deepEqual(await counts(),beforeRefusals)
  const opened = await persistence.scheduleBatch(batch)
  assert.equal(opened?.disposition, 'created')
  assert.equal(opened?.batch.members.length, 2)
  for (const member of opened!.batch.members) {
    assert.equal(member.executionStatus, 'QUEUED')
    assert.equal(member.currentReview, null)
    assert.ok(member.extractionId)
  }
  assert.deepEqual(await counts(), { extractions: 3, batches: 1, heads: 3, dispatches: 3, queued: 3 })

  const suggestion = await db.orm.public.BatchSchemaSuggestion.create({
    projectContextId: projectId, selectionKey: randomUUID(), outcome: 'SUCCEEDED', phase: 'READY', draftVersion: 1,
    draft: { recordDescription: 'One document.', schemaNodes: [{ id: 'suggested-title', name: 'title', type: 'string' }] },
  })
  for (const document of documents) await db.orm.public.BatchSchemaSuggestionSource.create({
    batchSchemaSuggestionId: suggestion.id, sourceDocumentId: document.id, sourceRepresentationRevisionId: document.revisionId,
  })
  const suggestedInput = { projectContextId: projectId, batchSchemaSuggestionId: suggestion.id, strategy: 'ARTICLE' as const, method }
  const failing = createResearcherExtractionPersistence(owner, {
    ...execution,
    enqueue: async (client, workflow, input) => {
      await execution.enqueue(client, workflow, input)
      throw new Error('Queue commit refused')
    },
  }, { database: db })
  const schemaCounts=async()=>(await admin.query(`SELECT
    (SELECT count(*)::int FROM public."extractionSchema") AS schemas,
    (SELECT count(*)::int FROM public."schemaRevision") AS revisions`)).rows[0]
  const suggestionPointers=async()=>db.orm.public.BatchSchemaSuggestion
    .select('confirmedSchemaRevisionId','batchExtractionId').first({id:suggestion.id})
  const beforeSuggested={counts:await counts(),schemas:await schemaCounts(),pointers:await suggestionPointers()}
  await assert.rejects(failing.scheduleSuggestedBatch(suggestedInput),/Queue commit refused/)
  assert.deepEqual({counts:await counts(),schemas:await schemaCounts(),pointers:await suggestionPointers()},beforeSuggested)
  assert.deepEqual(beforeSuggested.pointers,{confirmedSchemaRevisionId:null,batchExtractionId:null})
  await assert.rejects(persistence.scheduleSuggestedBatch({...suggestedInput,method:changedMethod}),{code:'method_changed'})
  assert.equal(await persistence.scheduleSuggestedBatch({...suggestedInput,projectContextId:otherProject}),null)
  assert.deepEqual({counts:await counts(),schemas:await schemaCounts(),pointers:await suggestionPointers()},beforeSuggested)
  const suggested = await persistence.scheduleSuggestedBatch(suggestedInput)
  assert.equal(suggested?.disposition, 'created')
  assert.equal(suggested?.batch.members.length, 2)
  assert.ok(suggested?.batch.members.every(member => member.executionStatus === 'QUEUED' && member.extractionId))
  assert.equal((await persistence.scheduleSuggestedBatch(suggestedInput))?.disposition, 'replayed')
  const committed = { extractions: 5, batches: 2, heads: 5, dispatches: 5, queued: 5 }
  assert.deepEqual(await counts(), committed)

  await assert.rejects(failing.scheduleExtraction({ ...single, extractionId: randomUUID() }), /Queue commit refused/)
  await assert.rejects(failing.scheduleBatch(batch), /Queue commit refused/)
  assert.deepEqual(await counts(), committed)

  let membersEnqueued = 0
  const failSecondMember = createResearcherExtractionPersistence(owner, {
    ...execution,
    enqueue: async (client, workflow, input) => {
      await execution.enqueue(client, workflow, input)
      if (++membersEnqueued === 2) throw new Error('Second member refused')
    },
  }, { database: db })
  await assert.rejects(failSecondMember.scheduleBatch(batch), /Second member refused/)
  assert.equal(membersEnqueued, 2)
  assert.deepEqual(await counts(), committed)

  assert.equal((await persistence.readExtractionAttempt(single.extractionId))?.extractionId, single.extractionId)

  // The pre-durable selection hash is a real occupied identity, but it must neither block native admission nor
  // appear as an empty Batch Extraction. Compute the historical hash independently of the native implementation.
  const equalSelection={...batch,repetition:'reuse-equal-selection' as const}
  const legacyHash=createHash('sha256').update(JSON.stringify([
    projectId,revisionId,'ARTICLE',documents.map(document=>document.id).sort((a,b)=>a.localeCompare(b)),method,
  ])).digest('hex')
  const legacyVariant=(['8','9','a','b'] as const)[parseInt(legacyHash[16]!,16)&3]
  const legacyBatchId=`${legacyHash.slice(0,8)}-${legacyHash.slice(8,12)}-5${legacyHash.slice(13,16)}-${legacyVariant}${legacyHash.slice(17,20)}-${legacyHash.slice(20,32)}`
  await admin.query('INSERT INTO public."batchExtraction" (id,"projectContextId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,\'ARTICLE\',$4)',
    [legacyBatchId,projectId,revisionId,method.settings])
  for(const document of documents) await admin.query('INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings","batchExtractionId") VALUES ($1,$2,$3,$4,\'ARTICLE\',$5,$6)',
    [randomUUID(),document.id,document.revisionId,revisionId,method.settings,legacyBatchId])
  assert.equal(await persistence.readBatch({projectContextId:projectId,batchExtractionId:legacyBatchId}),null)
  assert.ok((await persistence.listBatches(projectId,50))?.every(item=>item.batchExtractionId!==legacyBatchId))
  const nativeBatch=await persistence.scheduleBatch(equalSelection)
  assert.equal(nativeBatch?.disposition,'created')
  assert.notEqual(nativeBatch?.batch.batchExtractionId,legacyBatchId)
  assert.equal(nativeBatch?.batch.members.length,documents.length)
  const afterNativeAdmission=await counts()
  const replayed=await persistence.scheduleBatch({...equalSelection,sourceDocumentIds:[...equalSelection.sourceDocumentIds].reverse()})
  assert.equal(replayed?.disposition,'replayed')
  assert.deepEqual(replayed?.batch,nativeBatch?.batch)
  assert.deepEqual(await counts(),afterNativeAdmission)

  // An exact request cannot replay a row with no live head: the identity is definitively spent, with no upgrade.
  const headlessId=randomUUID()
  await admin.query('INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings") VALUES ($1,$2,$3,$4,\'ARTICLE\',$5)',
    [headlessId,documents[0].id,documents[0].revisionId,revisionId,method.settings])
  const beforeHeadless=await counts()
  await assert.rejects(persistence.scheduleExtraction({...single,extractionId:headlessId}),{code:'extraction_id_conflict'})
  assert.deepEqual(await counts(),beforeHeadless)

  // Reprocessing commits while admission waits for the document row. New work sees the current revision after
  // acquiring that lock; the earlier admitted identity still replays on its original pins.
  const currentRevision=randomUUID()
  await assert.rejects(withHeldSourceDocumentLock(target.url,documents[0].id,
    ()=>persistence.scheduleExtraction({...single,extractionId:randomUUID()}),
    async run=>{await run(`INSERT INTO public."sourceRepresentationRevision"
      (id,"sourceDocumentId","revisionNumber","artifactReference","artifactSha256","contractVersion","preprocessId","parserName","parserVersion")
      SELECT $1,"sourceDocumentId",2,"artifactReference","artifactSha256","contractVersion",'kei-exp:admission-reprocessed:g2',"parserName","parserVersion"
      FROM public."sourceRepresentationRevision" WHERE id=$2`,[currentRevision,documents[0].revisionId])}),
    {code:'source_representation_superseded'})
  assert.equal((await persistence.scheduleExtraction(single))?.disposition,'replayed')
  assert.deepEqual(await counts(),beforeHeadless)

  // An account Apply committed while a new request waits for the document lock refuses the stale method. Identical
  // single and equal-selection batch replays retain their admitted methods after that Apply.
  const savedConfiguration={connections:[],routes:{schemaSuggestion:null,interaction:null},extractionModels:{},
    ingestionModels:{},extractionSettings:{article:changedArticle}}
  assert.deepEqual(accountMethod(savedConfiguration,'ARTICLE',null),changedMethod)
  await assert.rejects(withHeldSourceDocumentLock(target.url,documents[1].id,
    ()=>persistence.scheduleExtraction({...single,extractionId:randomUUID(),sourceRepresentationRevisionId:documents[1].revisionId}),
    async run=>{await run('INSERT INTO public."modelConfiguration" ("researcherAccountId",document) VALUES ($1,$2)',
      [owner,savedConfiguration])}),{code:'method_changed'})
  assert.equal((await persistence.scheduleExtraction(single))?.disposition,'replayed')
  assert.equal((await persistence.scheduleBatch(equalSelection))?.disposition,'replayed')
  assert.deepEqual(await counts(),beforeHeadless)
  const changedBatch=await persistence.scheduleBatch({...equalSelection,method:changedMethod})
  assert.equal(changedBatch?.disposition,'created')
  assert.notEqual(changedBatch?.batch.batchExtractionId,nativeBatch?.batch.batchExtractionId)
  assert.equal(changedBatch?.batch.members.length,documents.length)
})
