import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { Client, Pool } from 'pg'
import { migrate, provisionDatabase, seedPreMigrationHistory, ARTICLE_TREE } from '../../db/src/record-scope-history-fixture.js'
import { initializeDurableExtraction, DurableNotFound } from './durable-repository.js'
import { readDurableDiagnostics } from './durable-diagnostics.js'

test('diagnostics are owner scoped, read-only, bounded and compare exact saved discovery inputs', async t => {
  const base = process.env.EXTRACTION_TEST_DATABASE_URL
  if (!base) throw new Error('Set EXTRACTION_TEST_DATABASE_URL to a guarded disposable target.')
  const target = await provisionDatabase(base, `free_test_diagnostics_${randomBytes(5).toString('hex')}`)
  const admin = new Client({ connectionString: target.url })
  const source = new Pool({ connectionString: target.url })
  const observedModes: string[] = []
  source.on('connect', client => {
    client.query = new Proxy(client.query, { apply(query, receiver, args) {
      if (typeof args[0] === 'string' && args[0].includes('FROM extraction_runtime.head h'))
        return Reflect.apply(query, receiver, ['SHOW transaction_read_only']).then((result: { rows: { transaction_read_only: string }[] }) => {
          observedModes.push(result.rows[0]!.transaction_read_only)
          return Reflect.apply(query, receiver, args)
        })
      return Reflect.apply(query, receiver, args)
    } })
  })
  t.after(async () => { await source.end(); await admin.end(); await target.drop() })
  await migrate(target.url)
  await admin.connect()
  const fixture = await seedPreMigrationHistory(admin)
  const document = fixture.documents.d1
  const representation = (await admin.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1',
    [document.sourceRepresentationRevisionId])).rows[0]
  const ids: string[] = [], key = 'd'.repeat(64)
  for (let index = 0; index < 2; index++) {
    const id = randomUUID()
    ids.push(id)
    await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings")
      VALUES ($1,$2,$3,$4,'ARTICLE',$5)`, [id, document.sourceDocumentId, document.sourceRepresentationRevisionId,
      fixture.revisions.article, { article: null }])
    await admin.query('BEGIN')
    await initializeDurableExtraction(admin as never, id, { projectContextId: fixture.projectContextId,
      sourceRepresentationRevisionId: document.sourceRepresentationRevisionId, schemaRevisionId: fixture.revisions.article,
      schemaTree: ARTICLE_TREE, strategy: 'ARTICLE', catalogRecipe: null, preprocessId: representation.preprocessId,
      requestedModels: null, requestedSettings: { article: null } })
    await admin.query('COMMIT')
    const head = (await admin.query('SELECT * FROM extraction_runtime.head WHERE id=$1', [id])).rows[0]
    const request = { provider: { model: 'fixture/model', password: 'credential-canary' },
      examples: index === 0 ? [{ value: 'private-correction-canary' }] : [], omissions: [],
      body: { stage: 'discovery', system: index === 0 ? 'with private guidance' : 'without guidance',
        user: 'private-source-canary', schema: { type: 'object' }, httpRequest: { max_tokens: 4096 } } }
    for (let number = 0; number < 7; number++) {
      const capture = randomUUID(), unit = number === 0 ? key : `${number}`.repeat(64)
      await admin.query(`INSERT INTO extraction_runtime.capture
        (id,"extractionId",generation,"unitKey","selectionId","originalAttemptId","feedbackVersion",candidates,descriptor,
        "reservationAttemptId","reservationEpoch","inFlight",invoked)
        VALUES ($1,$2,1,$3,$4,$5,0,'[]',$6,$5,0,false,true)`, [capture, id, unit, head.selectionId, head.attemptId, { stage: 'discovery' }])
      await admin.query('INSERT INTO extraction_runtime.input (id,digest,request) VALUES ($1,$2,$3)', [capture, 'a'.repeat(64), request])
      await admin.query('INSERT INTO extraction_runtime.checkpoint (id,"inputDigest","outputDigest",output) VALUES ($1,$2,$3,$4)',
        [capture, 'a'.repeat(64), 'b'.repeat(64), { parsed: { places: index === 0 ? [] : [['L1', 'record', '1']] },
          calls: [{ ok: true, finish: 'stop', input_tokens: 100, output_tokens: index === 0 ? 18 : 40, error: 'credential-canary' }] }])
    }
    await admin.query('UPDATE extraction_runtime.head SET acknowledgement=\'COMPLETED\' WHERE id=$1', [id])
  }
  const before = (await admin.query('SELECT count(*)::int AS count FROM extraction_runtime.capture')).rows[0].count
  const result = await readDurableDiagnostics(source, { owner: fixture.accountId, extraction: ids[0]!, compare: ids[1]! })
  assert.equal(result.summary.extraction.stages[0]!.captures, 7)
  assert.equal(result.summary.extraction.calls.length, 3)
  assert.equal(result.summary.extraction.sample.truncated, true)
  assert.equal(result.summary.extraction.calls[0]!.reply.places, 0)
  assert.equal(result.summary.differences!.sourceChanged, false)
  assert.equal(result.summary.differences!.matchedCalls[0]!.systemChanged, true)
  assert.equal(result.payloads.length, 0)
  assert.ok(!JSON.stringify(result).includes('canary'))
  assert.ok(observedModes.length > 0 && observedModes.every(mode => mode === 'on'))
  await assert.rejects(readDurableDiagnostics(source, { owner: randomUUID(), extraction: ids[0]! }), DurableNotFound)
  await assert.rejects(readDurableDiagnostics(source, { owner: fixture.accountId, extraction: ids[0]!, compare: randomUUID() }), DurableNotFound)
  const other = await seedPreMigrationHistory(admin), foreign = randomUUID()
  const foreignDocument = other.documents.d1
  await admin.query(`INSERT INTO public.extraction (id,"sourceDocumentId","sourceRepresentationRevisionId","schemaRevisionId",strategy,"requestedSettings")
    VALUES ($1,$2,$3,$4,'ARTICLE',$5)`, [foreign, foreignDocument.sourceDocumentId, foreignDocument.sourceRepresentationRevisionId,
    other.revisions.article, { article: null }])
  const foreignRepresentation = (await admin.query('SELECT "preprocessId" FROM public."sourceRepresentationRevision" WHERE id=$1',
    [foreignDocument.sourceRepresentationRevisionId])).rows[0]
  await admin.query('BEGIN')
  await initializeDurableExtraction(admin as never, foreign, { projectContextId: other.projectContextId,
    sourceRepresentationRevisionId: foreignDocument.sourceRepresentationRevisionId, schemaRevisionId: other.revisions.article,
    schemaTree: ARTICLE_TREE, strategy: 'ARTICLE', catalogRecipe: null, preprocessId: foreignRepresentation.preprocessId,
    requestedModels: null, requestedSettings: { article: null } })
  await admin.query('COMMIT')
  await assert.rejects(readDurableDiagnostics(source, { owner: fixture.accountId, extraction: ids[0]!, compare: foreign }), DurableNotFound)
  const explicit = await readDurableDiagnostics(source, { owner: fixture.accountId, extraction: ids[0]!, payloads: true, limit: 1 })
  assert.equal(explicit.payloads.length, 1)
  assert.ok(JSON.stringify(explicit.payloads).includes('private-source-canary'))
  assert.equal((await admin.query('SELECT count(*)::int AS count FROM extraction_runtime.capture')).rows[0].count, before)
  await admin.query('UPDATE extraction_runtime.head SET deleted=true WHERE id=$1', [ids[0]])
  await assert.rejects(readDurableDiagnostics(source, { owner: fixture.accountId, extraction: ids[0]! }), DurableNotFound)
})
