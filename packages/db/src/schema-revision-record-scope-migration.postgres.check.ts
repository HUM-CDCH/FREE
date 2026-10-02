import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/** The record-scope backfill on populated data: the migration's own data SQL, run against revisions as they were stored
 *  before this release (no scope), pinned by Extractions and Batch Extractions of one strategy, of both, or of none. */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('the record-scope backfill declares only the scope of the one strategy a revision ran with', async () => {
  if (!databaseUrl) throw new Error('Set PROJECT_STORE_POSTGRES_URL to a migrated disposable free_test_* database.')
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl
  const { db, pool } = await import('./prisma/db.js')
  const orm = db.orm.public
  const accountIds: string[] = []
  const projectIds: string[] = []
  after(async () => {
    try {
      for (const id of projectIds) await orm.ProjectContext.where({ id }).delete()
      for (const id of accountIds) await orm.ResearcherAccount.where({ id }).delete()
    } finally { await db.close(); await pool.end() }
  })
  const account = await orm.ResearcherAccount.create({ tenantId: randomUUID(), objectId: randomUUID(), displayName: 'Record scope' })
  accountIds.push(account.id)
  const project = await orm.ProjectContext.create({ researcherAccountId: account.id, name: 'Record scope' })
  projectIds.push(project.id)
  const document = await orm.SourceDocument.create({
    projectContextId: project.id, contentSha256: randomBytes(32).toString('hex'), mediaType: 'application/pdf',
  })
  const artifact = randomBytes(32).toString('hex')
  const representation = await orm.SourceRepresentationRevision.create({
    sourceDocumentId: document.id, revisionNumber: 1, artifactReference: artifact, artifactSha256: artifact,
    contractVersion: 'parsed_document.v2', preprocessId: 'kei-exp:run-scope:g1', parserName: 'test', parserVersion: '1',
  })
  const schema = await orm.ExtractionSchema.create({ projectContextId: project.id, name: 'Schema' })
  const tree = (name: string) => ({ recordDescription: `${name}.`, schemaNodes: [{ id: name, name, type: 'array', itemType: 'string' }] })
  let revisionNumber = 0
  const revision = async (name: string, recordScope: string | null = null) =>
    (await orm.SchemaRevision.create({
      extractionSchemaId: schema.id, revisionNumber: ++revisionNumber, origin: 'RESEARCHER_EDIT', schemaTree: tree(name), recordScope,
    })).id
  const extraction = (schemaRevisionId: string, strategy: string) => orm.Extraction.create({
    sourceDocumentId: document.id, sourceRepresentationRevisionId: representation.id, schemaRevisionId, strategy,
  })
  const batch = (schemaRevisionId: string, strategy: string) => orm.BatchExtraction.create({
    projectContextId: project.id, schemaRevisionId, strategy,
  })

  const article = await revision('article')
  await extraction(article, 'ARTICLE')
  await extraction(article, 'ARTICLE')
  const catalog = await revision('catalog')
  await extraction(catalog, 'CATALOG')
  const catalogBatch = await revision('catalogBatch')
  await batch(catalogBatch, 'CATALOG')
  const articleBatch = await revision('articleBatch')
  await batch(articleBatch, 'ARTICLE')
  await extraction(articleBatch, 'ARTICLE')
  const both = await revision('both')
  await extraction(both, 'ARTICLE')
  await batch(both, 'CATALOG')
  const never = await revision('never')
  const declared = await revision('declared', 'records')
  await extraction(declared, 'ARTICLE')

  const migrations = resolve(import.meta.dirname, '../migrations/app')
  const directory = readdirSync(migrations).find((name) => name.endsWith('_schema_revision_record_scope'))!
  const operations = JSON.parse(readFileSync(resolve(migrations, directory, 'ops.json'), 'utf8')) as
    Array<{ operationClass: string; execute: Array<{ sql: string; params: unknown[] }>; postcheck: Array<{ sql: string; params: unknown[] }> }>
  const data = operations.find((operation) => operation.operationClass === 'data')!
  const client = new Client({ connectionString: databaseUrl })
  await client.connect()
  try {
    for (const step of data.execute) await client.query(step.sql, step.params)
    // The ambiguous revisions remain NULL, and the postcheck still holds.
    for (const step of data.postcheck) assert.equal((await client.query(step.sql, step.params)).rows[0]?.ok, true)
    // Running it again changes nothing: a replay of the transform is harmless.
    for (const step of data.execute) await client.query(step.sql, step.params)
  } finally {
    await client.end()
  }
  const rows = await orm.SchemaRevision.where({ extractionSchemaId: schema.id })
    .select('id', 'recordScope', 'schemaTree').all()
  const scopes = Object.fromEntries(rows.map((row) => [row.id, row.recordScope]))
  assert.deepEqual(
    [article, catalog, catalogBatch, articleBatch, both, never, declared].map((id) => scopes[id]),
    ['document', 'records', 'records', 'document', null, null, 'records'],
  )
  // The stored trees are untouched, array fields and all: scope is never inferred from them.
  const trees = Object.fromEntries(rows.map((row) => [row.id, row.schemaTree]))
  assert.deepEqual(trees[never], tree('never'))
  assert.deepEqual(trees[article], tree('article'))
})
