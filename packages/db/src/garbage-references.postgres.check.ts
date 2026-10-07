import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

/**
 * Garbage collection decides from what the domain tables still hold, so only PostgreSQL can prove its reads. The check
 * creates its own account, so it does not need an empty database, and deletes it when it ends.
 */
const databaseUrl = process.env.PROJECT_STORE_POSTGRES_URL

test('garbage collection reads the scopes, revision references and package references that still exist', async (t) => {
  if (!databaseUrl)
    throw new Error(
      'Set PROJECT_STORE_POSTGRES_URL to a disposable free_test_* database, for example: pnpm --filter db db:start && createdb free_test_garbage_references.',
    )
  validateDisposableTestDatabaseTarget(databaseUrl)
  process.env.DATABASE_URL = databaseUrl

  const [{ db, pool }, { createGarbageReferences, EMPTY_SCOPE_IDS }, { default: postgres }, { default: contractJson }, { Pool }] =
    await Promise.all([
      import('./prisma/db.js'),
      import('./garbage-references.js'),
      import('@prisma-next/postgres/runtime'),
      import('./prisma/contract.json', { with: { type: 'json' } }),
      import('pg'),
    ])
  const accountIds: string[] = []
  after(async () => {
    try {
      for (const id of accountIds)
        await db.orm.public.ResearcherAccount.where({ id }).delete()
    } finally {
      await db.close()
      await pool.end()
    }
  })

  const orm = db.orm.public
  const account = await orm.ResearcherAccount.create({
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Garbage references',
  })
  accountIds.push(account.id)
  const project = await orm.ProjectContext.create({ researcherAccountId: account.id, name: 'Garbage references' })
  const document = await orm.SourceDocument.create({
    projectContextId: project.id,
    contentSha256: randomBytes(32).toString('hex'),
    mediaType: 'application/pdf',
  })
  const seededPackage = randomBytes(32).toString('hex')
  const otherPackage = randomBytes(32).toString('hex')
  const preprocessId = 'kei-exp:run-abc:g1'
  const revision = await orm.SourceRepresentationRevision.create({
    sourceDocumentId: document.id,
    revisionNumber: 1,
    artifactReference: seededPackage,
    artifactSha256: seededPackage,
    contractVersion: 'parsed_document.v2',
    preprocessId,
    parserName: 'test',
    parserVersion: '1',
  })
  const schema = await orm.ExtractionSchema.create({ projectContextId: project.id, name: 'Schema' })
  const suggestion = await orm.BatchSchemaSuggestion.create({
    projectContextId: project.id,
    selectionKey: `garbage-references-${randomUUID()}`,
    attempt: 2,
    outcome: 'SUCCEEDED',
  })

  const references = createGarbageReferences(db)
  const seededIds = {
    projectContextIds: [project.id, randomUUID()],
    sourceDocumentIds: [document.id, randomUUID()],
    sourceRepresentationRevisionIds: [revision.id, randomUUID()],
    extractionSchemaIds: [schema.id, randomUUID()],
    batchSchemaSuggestionIds: [suggestion.id, randomUUID()],
  }

  await t.test('scopes reports existing rows and the state of suggestions', async () => {
    const snapshot = await references.scopes(seededIds)
    assert.deepEqual([...snapshot.projectContexts], [project.id])
    assert.deepEqual([...snapshot.sourceDocuments], [document.id])
    assert.deepEqual([...snapshot.sourceRepresentationRevisions], [revision.id])
    assert.deepEqual([...snapshot.extractionSchemas], [schema.id])
    assert.deepEqual([...snapshot.suggestions.keys()], [suggestion.id])
    assert.deepEqual(snapshot.suggestions.get(suggestion.id), { attempt: 2, settled: true })
  })

  await t.test('unknown or malformed IDs are absent, and a failed read rejects', async () => {
    const snapshot = await references.scopes({
      ...EMPTY_SCOPE_IDS,
      projectContextIds: ['not-a-uuid', 'A0000000-0000-4000-8000-000000000000'],
    })
    assert.equal(snapshot.projectContexts.size, 0)

    const endedPool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 20_000 })
    const ended = postgres({ contractJson, pg: endedPool })
    await endedPool.end()
    const failing = createGarbageReferences(ended)
    await assert.rejects(failing.scopes(seededIds))
    await assert.rejects(failing.referencedPreprocessIds())
    await assert.rejects(failing.referencedPackages([seededPackage]))
    await ended.close()
  })

  await t.test('referencedPreprocessIds and referencedPackages name what surviving revisions reference', async () => {
    assert.ok((await references.referencedPreprocessIds()).has(preprocessId))
    assert.deepEqual([...(await references.referencedPackages([seededPackage, otherPackage]))], [seededPackage])
    assert.equal(await references.packageIsReferenced(seededPackage), true)
    assert.equal(await references.packageIsReferenced(otherPackage), false)
  })

  await t.test('after the project is deleted, none of its scopes exist', async () => {
    await orm.ProjectContext.where({ id: project.id }).delete()
    const snapshot = await references.scopes(seededIds)
    assert.equal(snapshot.projectContexts.size, 0)
    assert.equal(snapshot.sourceDocuments.size, 0)
    assert.equal(snapshot.sourceRepresentationRevisions.size, 0)
    assert.equal(snapshot.extractionSchemas.size, 0)
    assert.equal(snapshot.suggestions.size, 0)
    assert.equal(await references.packageIsReferenced(seededPackage), false)
  })
})
