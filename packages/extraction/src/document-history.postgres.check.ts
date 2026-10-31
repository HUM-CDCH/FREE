import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client, Pool } from 'pg'
import type { TestContext } from 'node:test'
import { migrate, provisionDatabase, seedPreMigrationHistory, ARTICLE_TREE } from '../../db/src/record-scope-history-fixture.js'

/** A migrated disposable database with the record-scope history, and Extractions of its first document on demand. */
async function fixture(t: TestContext, name: string) {
  const base = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const target = await provisionDatabase(base, `free_test_${name}_${randomBytes(5).toString('hex')}`)
  const admin = new Client({ connectionString: target.url }), source = new Pool({ connectionString: target.url, max: 2 })
  t.after(async () => { await source.end(); await admin.end(); await target.drop() })
  await migrate(target.url); await admin.connect()
  const repository = await import('./durable-repository.js')
  const history = await seedPreMigrationHistory(admin)
  const d1 = history.documents.d1
  const { preprocessId } = (await admin.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1', [d1.sourceRepresentationRevisionId])).rows[0]
  const extraction = async (createdAt: string) => {
    const id = randomUUID()
    await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings","createdAt")
      VALUES ($1,$2,$3,$4,'ARTICLE',$5,$6)`, [id, d1.sourceDocumentId, d1.sourceRepresentationRevisionId, history.revisions.article, { article: null }, createdAt])
    await admin.query('BEGIN')
    await repository.initializeDurableExtraction(admin as never, id, { projectContextId: history.projectContextId, sourceRepresentationRevisionId: d1.sourceRepresentationRevisionId,
      schemaRevisionId: history.revisions.article, schemaTree: ARTICLE_TREE, strategy: 'ARTICLE', catalogRecipe: null, preprocessId,
      requestedModels: null, requestedSettings: { article: null } })
    await admin.query('COMMIT')
    return { id, selectionId: (await admin.query('SELECT "selectionId" FROM extraction_runtime.head WHERE id=$1', [id])).rows[0].selectionId as string }
  }
  const snapshot = (extractionId: string, version: number, selectionId: string, values: unknown[] = []) => admin.query(`INSERT INTO extraction_runtime.snapshot
    (id,"extractionId",version,"selectionId",digest,values,coverage) VALUES ($1,$2,$3,$4,$5,$6,'{}')`, [randomUUID(), extractionId, version, selectionId, randomBytes(32).toString('hex'), JSON.stringify(values)])
  /** A newer Source Representation of the document, a copy of its first. */
  const reprocess = async () => {
    const id = randomUUID()
    await admin.query(`INSERT INTO public."sourceRepresentationRevision" SELECT (jsonb_populate_record(r, jsonb_build_object('id',$2::uuid,
      'revisionNumber',r."revisionNumber"+1,'preprocessId',r."preprocessId"||':next'))).* FROM public."sourceRepresentationRevision" r WHERE r.id=$1`,
    [d1.sourceRepresentationRevisionId, id])
    return id
  }
  return { admin, source, history, d1, repository, extraction, snapshot, reprocess }
}

/** The document History list: live Extractions only, newest first, to their owner only, with the schema revisions their
 *  results and inputs used, their finalized reviews and whether they read the current Source Representation. */
test('document history lists an owned document\'s live Extractions with their revisions and reviews', async t => {
  const { admin, source, history, d1, repository: { createDurableRepository }, extraction, snapshot, reprocess } = await fixture(t, 'document_history')
  /** Another input selection of `extractionId`, a copy of `from` on the Catalog revision. */
  const selection = async (extractionId: string, from: string) => {
    const id = randomUUID()
    await admin.query(`INSERT INTO extraction_runtime.selection (id,"extractionId",ordinal,"schemaRevisionId","schemaHash","schemaTree",method,resolved,digest)
      SELECT $1,"extractionId",ordinal+1,$3,"schemaHash","schemaTree",method,resolved,$4 FROM extraction_runtime.selection WHERE id=$2`,
    [id, from, history.revisions.catalog, randomBytes(32).toString('hex')])
    assert.equal((await admin.query('SELECT "extractionId" FROM extraction_runtime.selection WHERE id=$1', [id])).rows[0].extractionId, extractionId)
    return id
  }

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
  await reprocess()
  assert.deepEqual((await owner.documentHistory(history.projectContextId, d1.sourceDocumentId)).extractions.map(each => each.currentSource), [false, false])

  // Concealed: another researcher, another Project, or a document outside the Project.
  const stranger = randomUUID()
  await admin.query('INSERT INTO public."researcherAccount" (id,"tenantId","objectId","displayName","updatedAt") VALUES ($1,$2,$3,\'Stranger\',now())',
    [stranger, randomUUID(), randomUUID()])
  for (const [account, project, document] of [[stranger, history.projectContextId, d1.sourceDocumentId],
    [history.accountId, randomUUID(), d1.sourceDocumentId], [history.accountId, history.projectContextId, randomUUID()]] as const)
    await assert.rejects(() => createDurableRepository(account, source).documentHistory(project, document), /That Source Document was not found in this Project/)
})

/** One value's history: its latest reading in each Extraction of the document History window that read the same Source
 *  Representation, by identity only, with its historical name and the decision review shows; the rest counted. */
test('value history follows one value by identity across the document\'s Extractions', async t => {
  const { admin, source, history, d1, repository: { createDurableRepository }, extraction, snapshot, reprocess } = await fixture(t, 'value_history')
  const title = ARTICLE_TREE.schemaNodes[0]!
  const value = (selectionId: string, modelValue: string, node: object = title, id = 'v-title') => ({ id, recordId: 'record', fieldId: title.id,
    path: ['records', 0, title.name], selectionId, schemaRevisionId: history.revisions.article, node, modelValue, evidence: [], grounding: 'ungrounded',
    processing: 'saved', lineage: [] })
  const read = async (each: { id: string; selectionId: string }, values: unknown[]) => {
    await snapshot(each.id, 1, each.selectionId, values)
    await admin.query('UPDATE extraction_runtime.head SET "snapshotVersion"=1 WHERE id=$1', [each.id])
  }
  const older = await extraction('2026-10-01T10:00:00.000Z')
  const deleted = await extraction('2026-10-02T10:00:00.000Z')
  const renamed = await extraction('2026-10-03T10:00:00.000Z')
  const without = await extraction('2026-10-04T10:00:00.000Z')
  await extraction('2026-10-05T10:00:00.000Z') // nothing saved yet
  const elsewhere = await extraction('2026-10-06T10:00:00.000Z')
  await read(older, [value(older.selectionId, 'Old title'), value(older.selectionId, 'Other', title, 'v-other')])
  await read(deleted, [value(deleted.selectionId, 'Deleted title')])
  await admin.query('UPDATE extraction_runtime.head SET deleted=true WHERE id=$1', [deleted.id])
  await read(renamed, [value(renamed.selectionId, 'New title', { ...title, name: 'heading' })])
  // Readings differ at the whole value: the model gives none, the researcher chooses one.
  const disputed = { ...value(without.selectionId, null as never, title, 'v-disputed'), disagreement: [{ path: [], alternatives: [
    { value: 'Harbour', segments: ['p1_s0'] }, { value: 'Quay', segments: ['p2_s0'] }] }] }
  await read(without, [value(without.selectionId, 'Other', title, 'v-other'), disputed])
  // The same bare identity on another Source Representation is not the same value.
  await read(elsewhere, [value(elsewhere.selectionId, 'Elsewhere title')])
  await admin.query('UPDATE public.extraction SET "sourceRepresentationRevisionId"=$2 WHERE id=$1', [elsewhere.id, await reprocess()])
  const owner = createDurableRepository(history.accountId, source)
  await owner.saveCorrection(renamed.id, 'v-title', { expectedRevision: 0, snapshotVersion: 1, action: 'EDITED', value: 'Fixed title' }, async () => ({}))

  const traced = await owner.valueHistory(history.projectContextId, d1.sourceDocumentId, older.id, 'v-title')
  assert.deepEqual({ ...traced, readings: undefined }, { truncated: false, untraceableRevisions: 1, unmatched: 2, readings: undefined })
  assert.deepEqual(traced.readings.map(each => each.extractionId), [renamed.id, older.id])
  const [latest, earlier] = traced.readings
  const revisionNumber = (await admin.query('SELECT "revisionNumber" FROM public."schemaRevision" WHERE id=$1', [history.revisions.article])).rows[0].revisionNumber
  assert.deepEqual({ ...latest, createdAt: undefined, status: undefined }, { extractionId: renamed.id, createdAt: undefined, status: undefined, snapshotVersion: 1,
    schemaRevision: { schemaRevisionId: history.revisions.article, revisionNumber }, node: { ...title, name: 'heading' }, processing: 'saved',
    modelValue: 'New title', disagreement: null, decision: { action: 'EDITED', value: 'Fixed title' }, decisionIncompatible: false })
  assert.equal(earlier!.node.name, 'title')
  assert.equal(earlier!.modelValue, 'Old title')
  assert.equal(earlier!.decision, null)
  // Review shows the same decision on the same value.
  const reviewed = (await owner.page(renamed.id, { valueId: 'v-title' })).values[0]!
  assert.deepEqual(latest!.decision, { action: reviewed.correction!.decision.action, value: reviewed.correction!.decision.value })
  // A chosen reading is the value review shows.
  await owner.saveCorrection(without.id, 'v-disputed', { expectedRevision: 0, snapshotVersion: 1, action: 'APPROVED', choices: [{ path: [], value: 'Quay' }] }, async () => ({}))
  const chosen = await owner.valueHistory(history.projectContextId, d1.sourceDocumentId, without.id, 'v-disputed')
  assert.deepEqual([chosen.readings.map(each => each.extractionId), chosen.unmatched], [[without.id], 3])
  assert.deepEqual([chosen.readings[0]!.decision, chosen.readings[0]!.disagreement], [{ action: 'APPROVED', value: 'Quay' }, disputed.disagreement])
  // An anchor on the other Source Representation sees only its own.
  const there = await owner.valueHistory(history.projectContextId, d1.sourceDocumentId, elsewhere.id, 'v-title')
  assert.deepEqual([there.readings.map(each => each.modelValue), there.untraceableRevisions, there.unmatched], [['Elsewhere title'], 1, 0])

  // Concealed: another researcher, a deleted anchor, or an anchor outside the document.
  const stranger = randomUUID()
  await admin.query('INSERT INTO public."researcherAccount" (id,"tenantId","objectId","displayName","updatedAt") VALUES ($1,$2,$3,\'Stranger\',now())',
    [stranger, randomUUID(), randomUUID()])
  await assert.rejects(() => createDurableRepository(stranger, source).valueHistory(history.projectContextId, d1.sourceDocumentId, older.id, 'v-title'),
    /That Source Document was not found in this Project/)
  for (const anchor of [deleted.id, randomUUID()])
    await assert.rejects(() => owner.valueHistory(history.projectContextId, d1.sourceDocumentId, anchor, 'v-title'), /That Extraction was not found for this Source Document/)
  await assert.rejects(() => owner.valueHistory(history.projectContextId, history.documents.d2.sourceDocumentId, older.id, 'v-title'),
    /That Extraction was not found for this Source Document/)
})
