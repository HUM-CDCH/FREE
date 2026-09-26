import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, test } from 'node:test'
import { Client } from 'pg'
import { validateDisposableTestDatabaseTarget } from './database-url.js'
import { withHeldSourceDocumentLock } from './postgres-test-helpers.js'
import { lockSourceDocumentRow } from './row-lock.js'

const url = process.env.PROJECT_STORE_POSTGRES_URL
if (!url)
  throw new Error(
    'PROJECT_STORE_POSTGRES_URL must name a disposable free_test_* database.',
  )
validateDisposableTestDatabaseTarget(url)
process.env.DATABASE_URL = url
const { db, pool } = await import('./prisma/db.js')
const { createResearcherProjectStore, ReprocessConflictError } =
  await import('./project-store.js')
after(async () => {
  await db.close()
  await pool.end()
})

// The root client must not satisfy the lock's parameter: its update would commit at once.
// @ts-expect-error the root client is not a transaction context
const rootClientIsNotATransaction: Parameters<typeof lockSourceDocumentRow>[0] = db
void rootClientIsNotATransaction

test('reprocessing atomically appends, preserves history, and arbitrates concurrent requests', async () => {
  const account = await db.orm.public.ResearcherAccount.create({
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Reprocess validation',
  })
  const store = createResearcherProjectStore(account.id, db)
  const project = await store.createProjectContext('Cell evidence')
  const base = {
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
    requestKey: randomUUID(),
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
    [randomUUID(), randomUUID()].map((requestKey) =>
      store.reprocessSourceDocument(
        project.projectContextId,
        first.sourceDocumentId,
        { ...next, requestKey },
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
        requestKey: randomUUID(),
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

test('reprocess publication waits for a held Source Document row lock', async () => {
  const account = await db.orm.public.ResearcherAccount.create({
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Reprocess lock validation',
  })
  const store = createResearcherProjectStore(account.id, db)
  const project = await store.createProjectContext('Lock evidence')
  const base = {
    contentSha256: 'd'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'locked.pdf',
    artifactReference: 'e'.repeat(64),
    artifactSha256: 'e'.repeat(64),
    contractVersion: 'parsed_document.v2',
    preprocessId: 'native-v5',
    parserName: 'kei-exp',
    parserVersion: '5',
    ensureRetained: async () => {},
  }
  const first = await store.ingestSourceDocument(project.projectContextId, base)
  assert.ok(first)
  let orderMarker = 'held'
  const revised = await withHeldSourceDocumentLock(
    url!,
    first.sourceDocumentId,
    () =>
      store.reprocessSourceDocument(project.projectContextId, first.sourceDocumentId, {
        ...base,
        requestKey: randomUUID(),
        expectedRepresentationId: first.sourceRepresentationId,
        requestFingerprint: 'f'.repeat(64),
      }),
    async () => {
      // Runs while publication is blocked on the row lock: it has not published yet.
      orderMarker = 'blocked-before-publish'
    },
  )
  assert.equal(orderMarker, 'blocked-before-publish')
  assert.equal(revised?.revisionNumber, 2)
  // Leave no rows: project-store.postgres.check.ts asserts empty tables on the same database.
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

test('the Source Document row lock is held until the locking transaction commits', async () => {
  const account = await db.orm.public.ResearcherAccount.create({
    tenantId: randomUUID(),
    objectId: randomUUID(),
    displayName: 'Row lock holder validation',
  })
  const store = createResearcherProjectStore(account.id, db)
  const project = await store.createProjectContext('Held lock evidence')
  const first = await store.ingestSourceDocument(project.projectContextId, {
    contentSha256: '1'.repeat(64),
    mediaType: 'application/pdf',
    originalName: 'held.pdf',
    artifactReference: '2'.repeat(64),
    artifactSha256: '2'.repeat(64),
    contractVersion: 'parsed_document.v2',
    preprocessId: 'native-v5',
    parserName: 'kei-exp',
    parserVersion: '5',
    ensureRetained: async () => {},
  })
  assert.ok(first)
  const lockNowait =
    'SELECT id FROM "sourceDocument" WHERE id = $1 FOR UPDATE NOWAIT'
  const probe = new Client({ connectionString: url! })
  await probe.connect()
  try {
    await db.transaction(async (transaction) => {
      assert.equal(
        await lockSourceDocumentRow(transaction, first.sourceDocumentId),
        true,
      )
      // While the locking transaction is open, another session cannot take the row.
      await assert.rejects(
        probe.query(lockNowait, [first.sourceDocumentId]),
        (error: unknown) => (error as { code?: string }).code === '55P03',
      )
    })
    // After it commits, the row is free again (an autocommit statement needs no BEGIN).
    const released = await probe.query(lockNowait, [first.sourceDocumentId])
    assert.equal(released.rowCount, 1)
  } finally {
    await probe.end()
  }
  // Leave no rows: project-store.postgres.check.ts asserts empty tables on the same database.
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
