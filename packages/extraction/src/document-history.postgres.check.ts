import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client, Pool } from 'pg'
import { migrate, provisionDatabase, seedPreMigrationHistory, ARTICLE_TREE } from '../../db/src/record-scope-history-fixture.js'

/** The document History list: live Extractions only, newest first, to their owner only, with the schema revisions their
 *  results and inputs used, their finalized reviews and whether they read the current Source Representation. */
test('document history lists an owned document\'s live Extractions with their revisions and reviews', async t => {
  const base = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const target = await provisionDatabase(base, `free_test_document_history_${randomBytes(5).toString('hex')}`)
  const admin = new Client({ connectionString: target.url }), source = new Pool({ connectionString: target.url, max: 2 })
  t.after(async () => { await source.end(); await admin.end(); await target.drop() })
  await migrate(target.url); await admin.connect()
  const { createDurableRepository, initializeDurableExtraction } = await import('./durable-repository.js')
  const history = await seedPreMigrationHistory(admin)
  const d1 = history.documents.d1
  const { preprocessId } = (await admin.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1', [d1.sourceRepresentationRevisionId])).rows[0]
  const extraction = async (createdAt: string) => {
    const id = randomUUID()
    await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings","createdAt")
      VALUES ($1,$2,$3,$4,'ARTICLE',$5,$6)`, [id, d1.sourceDocumentId, d1.sourceRepresentationRevisionId, history.revisions.article, { article: null }, createdAt])
    await admin.query('BEGIN')
    await initializeDurableExtraction(admin as never, id, { projectContextId: history.projectContextId, sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId,
      schemaRevisionId: history.revisions.article, schemaTree: ARTICLE_TREE, strategy: 'ARTICLE', catalogRecipe: null, preprocessId,
      requestedModels: null, requestedSettings: { article: null } })
    await admin.query('COMMIT')
    return { id, selectionId: (await admin.query('SELECT "selectionId" FROM extraction_runtime.head WHERE id=$1', [id])).rows[0].selectionId as string }
  }
  /** Another input selection of `extractionId`, a copy of `from` on the Catalog revision. */
  const selection = async (extractionId: string, from: string) => {
    const id = randomUUID()
    await admin.query(`INSERT INTO extraction_runtime.selection (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
      SELECT $1,"extractionId",ordinal+1,$3,"schemaHash","schemaTree",method,resolved,$4 FROM extraction_runtime.selection WHERE id=$2`,
    [id, from, history.revisions.catalog, randomBytes(32).toString('hex')])
    assert.equal((await admin.query('SELECT "extractionId" FROM extraction_runtime.selection WHERE id=$1', [id])).rows[0].extractionId, extractionId)
    return id
  }
  const snapshot = (extractionId: string, version: number, selectionId: string) => admin.query(`INSERT INTO extraction_runtime.snapshot
    (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,$3,$4,$5,'[]','{}')`, [randomUUID(), extractionId, version, selectionId, randomBytes(32).toString('hex')])

  const deleted = await extraction('2026-10-01T10:00:00.000Z')
  const reviewed = await extraction('2026-10-02T10:00:00.000Z')
  const newest = await extraction('2026-10-03T10:00:00.000Z')
  await admin.query('UPDATE extraction_runtime.head SET deleted=true WHERE id=$1', [deleted.id])
  // Reviewed: results 1 on the first inputs, results 2 on revised inputs, results 2 finalized.
  const revised = await selection(reviewed.id, reviewed.selectionId)
  await snapshot(reviewed.id, 1, reviewed.selectionId)
  await snapshot(reviewed.id, 2, revised)
  await admin.query('UPDATE extraction_runtime.head SET "selectionId"=$2,"snapshotVersion"=2,acknowledgement=\'COMPLETED\' WHERE id=$1', [reviewed.id, revised])
  await admin.query(`INSERT INTO extraction_runtime.finalization (id,"extractionId","snapshotVersion","feedbackVersion","decisionDigest",
    "createdAt") VALUES ($1,$2,2,0,$3,'2026-10-02T12:00:00.000Z')`, [randomUUID(), reviewed.id, 'c'.repeat(64)])
  // Newest: nothing saved yet, revised inputs pending.
  await admin.query('UPDATE extraction_runtime.head SET "pendingSelectionId"=$2 WHERE id=$1', [newest.id, await selection(newest.id, newest.selectionId)])

  const revisionNumber = async (id: string) => (await admin.query('SELECT "revisionNumber" FROM public."schemaRevision" WHERE id=$1', [id])).rows[0].revisionNumber as number
  const article = { schemaRevisionId: history.revisions.article, revisionNumber: await revisionNumber(history.revisions.article) }
  const catalog = { schemaRevisionId: history.revisions.catalog, revisionNumber: await revisionNumber(history.revisions.catalog) }
  const owner = createDurableRepository(history.accountId, source)
  const listed = await owner.documentHistory(history.projectContextId, d1.sourceDocumentId)
  assert.equal(listed.truncated, false)
  assert.deepEqual(listed.extractions.map(each => each.extractionId), [newest.id, reviewed.id])
  const [first, second] = listed.extractions
  assert.deepEqual({ ...first, extractionId: undefined }, { extractionId: undefined, createdAt: '2026-10-03T10:00:00.000Z', status: 'QUEUED',
    strategy: 'ARTICLE', batchExtractionId: null, sourceRevisionNumber: 1, currentSource: true, schemaRevisions: [article],
    pendingSchemaRevision: catalog, finalizations: [] })
  assert.equal(second!.status, 'COMPLETED')
  assert.deepEqual(second!.schemaRevisions, [article, catalog].sort((left, right) => left.revisionNumber - right.revisionNumber || left.schemaRevisionId.localeCompare(right.schemaRevisionId)))
  assert.equal(second!.pendingSchemaRevision, null)
  assert.deepEqual(second!.finalizations, [{ snapshotVersion: 2, feedbackVersion: 0, createdAt: '2026-10-02T12:00:00.000Z' }])

  // A newer Source Representation leaves both on an earlier one.
  await admin.query(`CREATE TEMP TABLE representation AS SELECT * FROM public."sourceRepresentationRevision" WHERE id=$1;
    UPDATE representation SET id=gen_random_uuid(),"revisionNumber"="revisionNumber"+1,"preprocessId"="preprocessId"||':next';
    INSERT INTO public."sourceRepresentationRevision" SELECT * FROM representation`.replace('$1', `'${d1.sourceRepresentationRevisionId}'`))
  assert.deepEqual((await owner.documentHistory(history.projectContextId, d1.sourceDocumentId)).extractions.map(each => each.currentSource), [false, false])

  // Concealed: another researcher, another Project, or a document outside the Project.
  const stranger = randomUUID()
  await admin.query('INSERT INTO public."researcherAccount" (id,"tenantId","objectId","displayName","updatedAt") VALUES ($1,$2,$3,\'Stranger\',now())',
    [stranger, randomUUID(), randomUUID()])
  for (const [account, project, document] of [[stranger, history.projectContextId, d1.sourceDocumentId],
    [history.accountId, randomUUID(), d1.sourceDocumentId], [history.accountId, history.projectContextId, randomUUID()]] as const)
    await assert.rejects(() => createDurableRepository(account, source).documentHistory(project, document), /That Source Document was not found in this Project/)
})
