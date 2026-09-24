import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { validateDisposableTestDatabaseTarget } from './database-url.js'

const url = process.env.PROJECT_STORE_POSTGRES_URL
if (!url)
  throw new Error(
    'PROJECT_STORE_POSTGRES_URL must name a disposable free_test_* database.',
  )
validateDisposableTestDatabaseTarget(url)
process.env.DATABASE_URL = url
const { db } = await import('./prisma/db.js')
const { createResearcherProjectStore, ReprocessConflictError } =
  await import('./project-store.js')
after(() => db.close())

test('reprocessing atomically appends, preserves history, and arbitrates concurrent requests', async () => {
  const account = await db.orm.public.ResearcherAccount.create({
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Reprocess validation',
  })
  const store = createResearcherProjectStore(account.id, db)
  const project = await store.createProjectContext('Cell evidence')
  const base = {
    ingestionKey: randomUUID(),
    contentSha256: 'a'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'cells.pdf',
    artifactReference: 'b'.repeat(64),
    artifactSha256: 'b'.repeat(64),
    contractVersion: 'parsed_document.v2',
    preprocessId: 'native-v5',
    parserName: 'kei-exp',
    parserVersion: '5',
    ensureRetained: async () => {},
  }
  const first = await store.ingestSourceDocument(project.projectContextId, base)
  assert.ok(first)
  const input = {
    ...base,
    ingestionKey: randomUUID(),
    expectedRepresentationId: first.sourceRepresentationId,
    requestFingerprint: 'c'.repeat(64),
  }
  const sameKey = await Promise.all([
    store.reprocessSourceDocument(
      project.projectContextId,
      first.sourceDocumentId,
      input,
    ),
    store.reprocessSourceDocument(
      project.projectContextId,
      first.sourceDocumentId,
      input,
    ),
  ])
  assert.deepEqual(sameKey[0], sameKey[1])
  assert.equal(sameKey[0]?.revisionNumber, 2)
  assert.deepEqual(
    await store.getSourceRepresentation(
      project.projectContextId,
      first.sourceRepresentationId,
    ),
    first.descriptor,
  )
  const next = {
    ...input,
    expectedRepresentationId: sameKey[0]!.sourceRepresentationId,
  }
  const differentKeys = await Promise.allSettled(
    [randomUUID(), randomUUID()].map((ingestionKey) =>
      store.reprocessSourceDocument(
        project.projectContextId,
        first.sourceDocumentId,
        { ...next, ingestionKey },
      ),
    ),
  )
  assert.equal(
    differentKeys.filter((result) => result.status === 'fulfilled').length,
    1,
  )
  const rejected = differentKeys.find((result) => result.status === 'rejected')
  assert.ok(
    rejected?.status === 'rejected' &&
      rejected.reason instanceof ReprocessConflictError,
  )
  const revisions = await db.orm.public.SourceRepresentationRevision.where({
    sourceDocumentId: first.sourceDocumentId,
  })
    .select('revisionNumber')
    .all()
  assert.deepEqual(revisions.map((row) => row.revisionNumber).sort(), [1, 2, 3])
  await assert.rejects(
    store.reprocessSourceDocument(
      project.projectContextId,
      first.sourceDocumentId,
      { ...input, requestFingerprint: 'd'.repeat(64) },
    ),
    ReprocessConflictError,
  )
  await assert.rejects(
    store.reprocessSourceDocument(
      project.projectContextId,
      first.sourceDocumentId,
      {
        ...next,
        ingestionKey: randomUUID(),
        ensureRetained: async () => {
          throw new Error('unavailable')
        },
      },
    ),
    /unavailable/,
  )
  assert.equal(
    (
      await db.orm.public.SourceRepresentationRevision.where({
        sourceDocumentId: first.sourceDocumentId,
      })
        .select('id')
        .all()
    ).length,
    3,
  )
  // Delete database rows directly: the test descriptors do not name real packages.
  await db.orm.public.SourceRepresentationRevision.where({
    sourceDocumentId: first.sourceDocumentId,
  }).delete()
  await db.orm.public.SourceDocument.where({
    id: first.sourceDocumentId,
  }).delete()
  await db.orm.public.ProjectContext.where({
    id: project.projectContextId,
  }).delete()
  await db.orm.public.ResearcherAccount.where({ id: account.id }).delete()
})
